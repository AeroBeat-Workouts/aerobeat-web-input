// @ts-check

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isBodyGridAnchorSnapshot,
  isBodyGridCellEntry,
  isCalibrationSnapshot,
  isGameplayEvidenceSnapshot,
  isTrackingSafetySnapshot
} from "@aerobeat/web-contracts";
import {
  createAeroBodyGridService,
  createMeasuredPoseRoutingSample
} from "../src/index.js";

const names = ["nose", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist"];
const replayFixture = JSON.parse(readFileSync(new URL("../fixtures/calibrated-body-grid-replay.json", import.meta.url), "utf8"));
assert.equal(replayFixture.schema, "aerobeat.input.body-grid-replay.v1");
assert.ok(replayFixture.timeline.length >= 13);

/** @param {number} timestampMs @param {Partial<Record<string, {x: number, y: number, confidence?: number}>>} [changes] @param {{sourceId?: string, mirrored?: boolean}} [options] */
function pose(timestampMs, changes = {}, options = {}) {
  const base = {
    nose: { x: 0.5, y: 0.3 },
    left_shoulder: { x: 0.6, y: 0.4 },
    right_shoulder: { x: 0.4, y: 0.4 },
    left_elbow: { x: 0.7, y: 0.4 },
    right_elbow: { x: 0.3, y: 0.4 },
    left_wrist: { x: 0.8, y: 0.4 },
    right_wrist: { x: 0.2, y: 0.4 }
  };
  return {
    sourceId: options.sourceId ?? "camera-a",
    timestampMs,
    mirrored: options.mirrored ?? true,
    landmarks: names.map((name) => ({
      name,
      ...base[name],
      ...changes[name],
      confidence: changes[name]?.confidence ?? 0.95
    }))
  };
}

/** @param {ReturnType<typeof createAeroBodyGridService>} service @param {number} start @param {{sourceAspectRatio?: number, sourceChangeId?: string}} [context] */
function calibrate(service, start = 0, context = {}) {
  // Span 2250ms so a full 2000ms hold completes even if the first frame
  // shares a timestamp with the previous measurement and is ignored.
  for (let offset = 0; offset <= 2250; offset += 250) {
    service.processPoseSample(pose(start + offset), context);
  }
  return service.getSnapshot();
}

/** Pose changes that drop exactly one loss-decision anchor below the confidence gate. */
const leftWristLoss = { left_wrist: { x: 0.8, y: 0.4, confidence: 0.2 } };
/** Pose changes that drop only non-loss anchors (shoulders/elbows) below the gate. */
const shoulderElbowLoss = {
  left_shoulder: { x: 0.6, y: 0.4, confidence: 0.2 },
  right_shoulder: { x: 0.4, y: 0.4, confidence: 0.2 },
  left_elbow: { x: 0.7, y: 0.4, confidence: 0.2 },
  right_elbow: { x: 0.3, y: 0.4, confidence: 0.2 }
};

const service = createAeroBodyGridService({ calibrationIdPrefix: "test" });
let snapshot = service.getSnapshot();
assert.equal(snapshot.calibration.state, "uncalibrated");
assert.equal(snapshot.calibration.bounds, null, "there is no silent bootstrap geometry");
assert.ok(Object.isFrozen(snapshot));
assert.ok(Object.isFrozen(snapshot.calibration));

snapshot = service.processPoseSample(pose(0));
assert.equal(snapshot.calibration.state, "holding");
assert.equal(snapshot.calibration.holdProgressMs, 0);
service.processPoseSample(pose(250));
assert.equal(service.getSnapshot().calibration.holdProgressMs, 250);
service.processPoseSample(pose(500, { left_wrist: { x: 0.8, y: 0.55 } }));
assert.equal(service.getSnapshot().calibration.state, "uncalibrated", "a failed gate during the first hold window restarts the hold");
assert.equal(service.getSnapshot().calibration.holdProgressMs, 0);

// The initial hold window is 2000ms; a failed gate restarts it from the next qualified frame.
service.processPoseSample(pose(750));
assert.equal(service.getSnapshot().calibration.holdProgressMs, 0, "the hold restarts at the next qualified frame after a failed gate");
service.processPoseSample(pose(1000, { left_wrist: { x: 0.8, y: 0.55 } }));
assert.equal(service.getSnapshot().calibration.holdProgressMs, 0, "a second failed gate restarts the hold again");
snapshot = calibrate(service, 1000);
assert.equal(snapshot.calibration.state, "cooldown");
assert.equal(snapshot.calibration.readiness, "countdown");
assert.equal(snapshot.calibration.calibrationId, "test-1");
assert.equal(snapshot.calibratedShoulderWorldY, 1, "the averaged shoulder center is world Y=1 with default symmetric bounds");
assert.equal(snapshot.calibration.releaseRequired, true);
assert.equal(snapshot.calibration.cooldownRemainingMs, 2000, "cooldown now comes from the 2000ms contract");
assert.ok(isCalibrationSnapshot(snapshot.calibration));
assert.ok(isTrackingSafetySnapshot(snapshot.tracking));
const bounds = snapshot.calibration.bounds;
assert.ok(bounds);
assert.ok(Math.abs(bounds.left - 0.2) < 1e-9);
assert.ok(Math.abs(bounds.right - 0.8) < 1e-9);
assert.ok(Math.abs(bounds.top - 0) < 1e-9);
assert.ok(Math.abs(bounds.bottom - 0.8) < 1e-9, "16:9 source aspect produces square-pixel 4x3 geometry");

const releasedChanges = {
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
};
for (let at = 2500; at <= 11000; at += 250) {
  snapshot = service.processPoseSample(pose(at, releasedChanges));
}
assert.equal(snapshot.calibration.releaseRequired, false);
assert.equal(snapshot.calibration.state, "calibrated");
assert.equal(snapshot.anchors.length, 7);
assert.ok(snapshot.anchors.every(isBodyGridAnchorSnapshot));
assert.ok(snapshot.latestEvidence && isGameplayEvidenceSnapshot(snapshot.latestEvidence));

// Optional lower-body measurements remain separate from seven-point calibration
// and never become frozen/predicted scored knee evidence.
{
  const kneeService = createAeroBodyGridService({ calibrationIdPrefix: "measured-knee" });
  calibrate(kneeService, 0);
  for (let at = 2500; at <= 5500; at += 250) kneeService.processPoseSample(pose(at, releasedChanges));
  const lowerJoints = [
    { name: "left_hip", x: .65, y: .6, confidence: .9 },
    { name: "left_knee", x: .68, y: .72, confidence: .95 },
    { name: "left_ankle", x: .69, y: .9, confidence: .8 },
    { name: "right_hip", x: .35, y: .6, confidence: .9 },
    { name: "right_knee", x: .32, y: .72, confidence: .95 },
    { name: "right_ankle", x: .31, y: .9, confidence: .8 }
  ];
  const withLegs = (timestampMs, joints = lowerJoints) => ({ ...pose(timestampMs, releasedChanges), landmarks: [...pose(timestampMs, releasedChanges).landmarks, ...joints] });
  let kneeSnapshot = kneeService.processPoseSample(withLegs(5600));
  assert.equal(kneeSnapshot.anchors.length, 7, "lower-body joints do not alter upper-body anchor contract");
  assert.equal(kneeSnapshot.latestEvidence?.kneePose?.legs.length, 2);
  assert.equal(kneeSnapshot.latestKneeVisualPose?.schema, "aerobeat/measured_knee_visual_pose");
  assert.equal(kneeSnapshot.latestKneeVisualPose?.version, 1);
  assert.equal(kneeSnapshot.latestKneeVisualPose?.calibrationId, kneeSnapshot.calibration.calibrationId);
  assert.equal(kneeSnapshot.latestKneeVisualPose?.measurementTimestampMs, 5600);
  assert.equal(kneeSnapshot.latestKneeVisualPose?.measuredSourceFrameId, kneeSnapshot.latestEvidence?.measuredSourceFrameId);
  assert.equal(kneeSnapshot.latestKneeVisualPose?.legs.length, 2);
  assert.equal(kneeSnapshot.latestKneeVisualPose?.legs[0].confidence, .9, "visual confidence uses only hip and knee");
  assert.deepEqual(kneeSnapshot.latestKneeVisualPose?.legs[0].ankle, kneeSnapshot.latestEvidence?.kneePose?.legs[0].ankle);
  assert.ok(Object.isFrozen(kneeSnapshot.latestKneeVisualPose?.legs[0]));
  assert.equal(isGameplayEvidenceSnapshot(kneeSnapshot.latestEvidence), true);
  assert.deepEqual(kneeSnapshot.latestEvidence?.kneePose?.legs.map((leg) => leg.side), ["left", "right"]);
  assert.equal(kneeSnapshot.latestEvidence?.kneePose?.legs[0].confidence, .8, "least-visible linked joint gates the leg");
  assert.ok(kneeSnapshot.latestEvidence.kneePose.legs[0].knee.x < kneeSnapshot.latestEvidence.kneePose.legs[1].knee.x, "camera x is mirrored into athlete space once");
  const ankleMissing = lowerJoints.filter((joint) => joint.name !== "left_ankle").map((joint) => joint.name === "right_ankle" ? { ...joint, confidence: .2 } : joint);
  kneeSnapshot = kneeService.processPoseSample(withLegs(5605, ankleMissing));
  assert.equal(Object.hasOwn(kneeSnapshot.latestEvidence, "kneePose"), false, "no ankle cannot create scored knee evidence");
  assert.deepEqual(kneeSnapshot.latestKneeVisualPose?.legs.map((leg) => leg.side), ["left", "right"]);
  assert.ok(kneeSnapshot.latestKneeVisualPose.legs.every((leg) => leg.ankle === null), "missing or low-confidence ankles remain null");
  assert.equal(kneeSnapshot.latestKneeVisualPose.legs[0].confidence, .9);
  assert.deepEqual(kneeSnapshot.latestKneeVisualPose.legs[0].hip, { x: (1 - .65 - bounds.left) / (bounds.right - bounds.left), y: (.6 - bounds.top) / (bounds.bottom - bounds.top) }, "visual hip uses the scored pose transform");
  assert.deepEqual(kneeSnapshot.latestKneeVisualPose.legs[0].knee, { x: (1 - .68 - bounds.left) / (bounds.right - bounds.left), y: (.72 - bounds.top) / (bounds.bottom - bounds.top) });
  kneeSnapshot = kneeService.processPoseSample(withLegs(5607, lowerJoints.filter((joint) => joint.name !== "right_ankle")));
  assert.deepEqual(kneeSnapshot.latestEvidence?.kneePose?.legs.map((leg) => leg.side), ["left"], "complete left side alone remains scoreable");
  assert.deepEqual(kneeSnapshot.latestKneeVisualPose?.legs.map((leg) => leg.ankle === null), [false, true], "each ankle is independently optional for display");
  kneeSnapshot = kneeService.processPoseSample(withLegs(5610, lowerJoints.map((joint) => joint.name === "right_knee" ? { ...joint, confidence: .2 } : joint)));
  assert.deepEqual(kneeSnapshot.latestEvidence?.kneePose?.legs.map((leg) => leg.side), ["left"], "one low-confidence side cannot score");
  assert.deepEqual(kneeSnapshot.latestKneeVisualPose?.legs.map((leg) => leg.side), ["left"], "missing knee hides only its visual side");
  kneeSnapshot = kneeService.processPoseSample(withLegs(5620, [...lowerJoints, lowerJoints[1]]));
  assert.deepEqual(kneeSnapshot.latestEvidence?.kneePose?.legs.map((leg) => leg.side), ["right"], "duplicate lower joint fails closed only for that leg");
  assert.deepEqual(kneeSnapshot.latestKneeVisualPose?.legs.map((leg) => leg.side), ["right"], "duplicate knee also fails visual geometry closed");
  kneeSnapshot = kneeService.processPoseSample(pose(5630, releasedChanges));
  assert.equal(Object.hasOwn(kneeSnapshot.latestEvidence, "kneePose"), false, "missing lower body immediately removes old knee data without freezing Flow");
  assert.equal(kneeSnapshot.latestKneeVisualPose, null);
  kneeSnapshot = kneeService.processPoseSample(withLegs(5640));
  const measuredKnee = kneeSnapshot.latestEvidence;
  kneeSnapshot = kneeService.processPoseSample({ ...createMeasuredPoseRoutingSample(withLegs(5641), { routeEpoch: "knee-predicted" }), provenance: "predicted", targetTimestampMs: 5660, predictionHorizonMs: 19 });
  assert.equal(kneeSnapshot.latestEvidence, measuredKnee, "predicted joints never replace measured knee evidence");
  assert.equal(kneeSnapshot.latestKneeVisualPose, null, "prediction cannot retain measured-only visual geometry");
  kneeSnapshot = kneeService.processPoseSample(withLegs(5645));
  assert.ok(kneeSnapshot.latestKneeVisualPose);
  kneeSnapshot = kneeService.processPoseSample(null);
  assert.equal(kneeSnapshot.latestKneeVisualPose, null, "invalid input clears only visual pose");
  kneeSnapshot = kneeService.processPoseSample(withLegs(5646));
  assert.ok(kneeSnapshot.latestKneeVisualPose);
  kneeSnapshot = kneeService.advanceTime(5646);
  assert.equal(kneeSnapshot.latestKneeVisualPose, null, "no-frame tick clears visual geometry before loss latch");
  kneeSnapshot = kneeService.processPoseSample(withLegs(5647));
  assert.ok(kneeSnapshot.latestKneeVisualPose);
  kneeSnapshot = kneeService.processPoseSample({ ...withLegs(5650), landmarks: [...withLegs(5650).landmarks, { name: "left_wrist", x: .8, y: .4, confidence: .2 }] });
  assert.equal(kneeSnapshot.latestEvidence?.provenance, "frozen");
  assert.equal(Object.hasOwn(kneeSnapshot.latestEvidence, "kneePose"), false, "frozen positions cannot replay a knee hit");
  assert.equal(kneeSnapshot.latestKneeVisualPose, null, "tracking loss hides visuals even while scored evidence is frozen");
  kneeSnapshot = kneeService.processPoseSample(withLegs(5660));
  assert.ok(kneeSnapshot.latestKneeVisualPose, "new passing frame recovers visual geometry");
  kneeSnapshot = kneeService.processPoseSample(withLegs(5670), { sourceChangeId: "new-camera" });
  assert.equal(kneeSnapshot.latestKneeVisualPose, null, "source change clears calibrated visual geometry");
  kneeSnapshot = kneeService.resetCalibration();
  assert.equal(kneeSnapshot.latestKneeVisualPose, null);
  kneeService.destroy();
  assert.equal(kneeService.getSnapshot().latestKneeVisualPose, null, "disconnect destroys visual pose");
}

// Camera-preview x is opposed exactly once: camera x=.8 maps to athlete x=.2 (raw ~0).
const cornerFrame = pose(11100, {
  nose: { x: 0.799999999, y: 0.000000001 },
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
});
snapshot = service.processPoseSample(cornerFrame);
const noseCorner = snapshot.anchors.find((anchor) => anchor.anchor === "nose");
assert.equal(noseCorner?.cell, 0);
assert.equal(noseCorner?.subcell, 0);
assert.ok(Math.abs(noseCorner?.x ?? 1) < 1e-8, "nose is at the left/top grid edge");
assert.ok(Math.abs(noseCorner?.y ?? 1) < 1e-8, "nose is at the left/top grid edge");

const farCorner = pose(11200, {
  nose: { x: 0.200000001, y: 0.799999999 },
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
});
snapshot = service.processPoseSample(farCorner);
const noseFar = snapshot.anchors.find((anchor) => anchor.anchor === "nose");
assert.equal(noseFar?.cell, 11);
assert.equal(noseFar?.subcell, 47);

snapshot = service.processPoseSample(pose(11225, {
  nose: { x: 0.200000001, y: 0 },
  ...releasedChanges
}));
assert.equal(snapshot.anchors.find((anchor) => anchor.anchor === "nose")?.cell, 3);
assert.equal(snapshot.anchors.find((anchor) => anchor.anchor === "nose")?.subcell, 7);
snapshot = service.processPoseSample(pose(11250, {
  nose: { x: 0.799999999, y: 0.799999998 },
  ...releasedChanges
}));
assert.equal(snapshot.anchors.find((anchor) => anchor.anchor === "nose")?.cell, 8);
assert.equal(snapshot.anchors.find((anchor) => anchor.anchor === "nose")?.subcell, 40);

const outside = pose(11300, {
  nose: { x: 0.1, y: 0.3 },
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
});
snapshot = service.processPoseSample(outside);
const outsideNose = snapshot.anchors.find((anchor) => anchor.anchor === "nose");
// D1(b): an off-grid but confident anchor stays staged — valid by signal
// validity with finite x/y — while still carrying no scoring cell/subcell.
assert.equal(outsideNose?.valid, true, "an off-grid confident anchor stays staged (valid by signal validity)");
assert.ok(Number.isFinite(outsideNose?.x ?? NaN), "the off-grid anchor keeps its normalized x for staging");
assert.ok(Number.isFinite(outsideNose?.y ?? NaN), "the off-grid anchor keeps its normalized y for staging");
assert.equal(outsideNose?.cell, null, "the off-grid anchor never occupies a scoring cell");
assert.equal(outsideNose?.subcell, null, "the off-grid anchor never occupies a scoring subcell");
assert.ok((outsideNose?.rawX ?? 0) > 1, "unclamped diagnostics survive out-of-grid staging");

// Outside-to-grid produces no synthetic entry; a later cardinal transition does.
service.processPoseSample(pose(11400, {
  nose: { x: 0.65, y: 0.3 },
  left_elbow: { x: 0.61, y: 0.52 }, right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 }, right_wrist: { x: 0.44, y: 0.55 }
}));
assert.equal(service.getSnapshot().entries.some((entry) => entry.anchor === "nose"), false);
snapshot = service.processPoseSample(pose(11500, {
  nose: { x: 0.45, y: 0.3 },
  left_elbow: { x: 0.61, y: 0.52 }, right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 }, right_wrist: { x: 0.44, y: 0.55 }
}));
const noseEntry = snapshot.entries.find((entry) => entry.anchor === "nose");
assert.ok(noseEntry && isBodyGridCellEntry(noseEntry));
assert.equal(noseEntry.direction, "right");

const cardinalService = createAeroBodyGridService({ calibrationIdPrefix: "cardinal" });
calibrate(cardinalService, 0);
for (let at = 2500; at <= 8250; at += 250) {
  cardinalService.processPoseSample(pose(at, releasedChanges));
}
const cameraPointForRaw = (x, y) => ({ x: 1 - (0.2 + x * 0.6), y: y * 0.8 });
cardinalService.processPoseSample(pose(8500, { nose: cameraPointForRaw(0.125, 1 / 6), ...releasedChanges }));
for (const [at, raw, direction] of [
  [8525, [0.625, 2 / 3], "right"],
  [8550, [0.125, 2 / 3], "left"],
  [8575, [0.125, 1 / 6], "up"],
  [8600, [0.125, 2 / 3], "down"]
]) {
  snapshot = cardinalService.processPoseSample(pose(at, { nose: cameraPointForRaw(raw[0], raw[1]), ...releasedChanges }));
  assert.equal(snapshot.entries.find((entry) => entry.anchor === "nose")?.direction, direction, `${direction} cardinal entry is deterministic`);
}

// A boundary jitter remains in the old cell until the configured hysteresis is crossed.
const beforeJitter = service.getSnapshot().anchors.find((anchor) => anchor.anchor === "nose")?.cell;
snapshot = service.processPoseSample(pose(11520, {
  nose: { x: 0.4 - 0.001, y: 0.3 },
  left_elbow: { x: 0.61, y: 0.52 }, right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 }, right_wrist: { x: 0.44, y: 0.55 }
}));
assert.equal(snapshot.anchors.find((anchor) => anchor.anchor === "nose")?.cell, beforeJitter);

// Straight continuity uses only measurements and exposes spatial accepted-subcell state.
for (const at of [11600, 11650, 11700]) {
  snapshot = service.processPoseSample(pose(at, {
    left_shoulder: { x: 0.62, y: 0.5 }, left_elbow: { x: 0.59, y: 0.5 }, left_wrist: { x: 0.56, y: 0.5 },
    right_shoulder: { x: 0.38, y: 0.5 }, right_elbow: { x: 0.41, y: 0.5 }, right_wrist: { x: 0.44, y: 0.5 },
    nose: { x: 0.5, y: 0.3 }
  }));
}
assert.ok(snapshot.latestEvidence?.activeBoxingActions.includes("straight_left"));
assert.ok(snapshot.latestEvidence?.activeBoxingActions.includes("straight_right"));
assert.ok(snapshot.straightQualifications.every((item) => item.semanticQualified));
assert.ok(snapshot.straightQualifications.every((item) => item.spatialQualified));
const mainStraightEvidence = snapshot.latestEvidence;

const independentStraight = createAeroBodyGridService({ calibrationIdPrefix: "straight-independent" });
calibrate(independentStraight, 0);
for (let at = 2500; at <= 8250; at += 250) {
  independentStraight.processPoseSample(pose(at, releasedChanges));
}
for (const at of [8500, 8650, 8750]) {
  snapshot = independentStraight.processPoseSample(pose(at, {
    left_shoulder: { x: 0.85, y: 0.5 }, left_elbow: { x: 0.8, y: 0.5 }, left_wrist: { x: 0.75, y: 0.5 },
    right_elbow: { x: 0.39, y: 0.52 }, right_wrist: { x: 0.44, y: 0.55 }
  }));
}
const independentLeft = snapshot.straightQualifications.find((item) => item.hand === "left");
assert.equal(independentLeft?.semanticQualified, true, "an exact 150ms gap preserves semantic continuity");
assert.equal(independentLeft?.spatialQualified, false, "semantic straight is independent of accepted spatial subcolumns");
assert.ok(snapshot.latestEvidence?.activeBoxingActions.includes("straight_left"));

assert.equal(service.getFreshEvidence(11850), mainStraightEvidence);
assert.equal(service.getFreshEvidence(11851), null, "checkpoint freshness is capped at 150ms");
snapshot = service.processPoseSample(pose(11860, {
  left_shoulder: { x: 0.62, y: 0.5 }, left_elbow: { x: 0.59, y: 0.5 }, left_wrist: { x: 0.56, y: 0.5 },
  right_shoulder: { x: 0.38, y: 0.5 }, right_elbow: { x: 0.41, y: 0.5 }, right_wrist: { x: 0.44, y: 0.5 }
}));
assert.ok(snapshot.straightQualifications.every((item) => item.semanticDurationMs === 0), "a gap over 150ms restarts straight continuity");

const measuredBeforePrediction = snapshot.latestEvidence;
const predicted = {
  ...createMeasuredPoseRoutingSample(pose(11800), { routeEpoch: "predicted-test" }),
  provenance: "predicted",
  targetTimestampMs: 11850,
  predictionHorizonMs: 50
};
snapshot = service.processPoseSample(predicted);
assert.equal(snapshot.latestEvidence, measuredBeforePrediction, "predictions never replace measured evidence");
assert.equal(snapshot.predictedDiagnostics.sampleCount, 1);

// Same-sample guard and squat overlap as positive observations.
snapshot = service.processPoseSample(pose(11900, {
  nose: { x: 0.5, y: 0.62 },
  left_shoulder: { x: 0.62, y: 0.5 }, left_elbow: { x: 0.58, y: 0.48 }, left_wrist: { x: 0.54, y: 0.58 },
  right_shoulder: { x: 0.38, y: 0.5 }, right_elbow: { x: 0.42, y: 0.48 }, right_wrist: { x: 0.46, y: 0.58 }
}));
assert.ok(snapshot.latestEvidence?.activeBoxingActions.includes("guard"));
assert.ok(snapshot.latestEvidence?.activeBoxingActions.includes("squat"));

snapshot = service.processPoseSample(pose(11920, {
  left_shoulder: { x: 0.62, y: 0.5 }, left_elbow: { x: 0.58, y: 0.55 }, left_wrist: { x: 0.5, y: 0.55 },
  right_elbow: { x: 0.39, y: 0.62 }, right_wrist: { x: 0.44, y: 0.68 }
}));
assert.ok(snapshot.latestEvidence?.activeBoxingActions.includes("hook_left"));
snapshot = service.processPoseSample(pose(11940, {
  left_shoulder: { x: 0.62, y: 0.5 }, left_elbow: { x: 0.58, y: 0.58 }, left_wrist: { x: 0.58, y: 0.48 },
  right_elbow: { x: 0.39, y: 0.62 }, right_wrist: { x: 0.44, y: 0.68 }
}));
assert.ok(snapshot.latestEvidence?.activeBoxingActions.includes("uppercut_left"));
snapshot = service.processPoseSample(pose(11960, {
  nose: { x: 0.6, y: 0.3 },
  left_elbow: { x: 0.5, y: 0.4 }, left_wrist: { x: 0.46, y: 0.34 },
  right_elbow: { x: 0.5, y: 0.4 }, right_wrist: { x: 0.54, y: 0.34 }
}));
const swappedGuardEvidence = snapshot.latestEvidence;
assert.ok(swappedGuardEvidence && isGameplayEvidenceSnapshot(swappedGuardEvidence), "swapped wrists produce valid public measured evidence");
assert.equal(swappedGuardEvidence.provenance, "measured");
assert.ok(swappedGuardEvidence.activeBoxingActions.includes("guard"), "hands near the face remain an ordinary guard regardless of wrist order");
assert.ok(swappedGuardEvidence.activeBoxingActions.includes("weave_left"), "overlapping weave observation survives");
const swappedLeftWrist = swappedGuardEvidence.anchors.find((anchor) => anchor.anchor === "left_wrist");
const swappedRightWrist = swappedGuardEvidence.anchors.find((anchor) => anchor.anchor === "right_wrist");
assert.ok(swappedLeftWrist?.valid && swappedRightWrist?.valid, "both named wrist anchors remain available for scoring");
assert.ok(swappedLeftWrist.cell !== null && swappedRightWrist.cell !== null, "both wrist cells remain scoreable");
assert.ok(swappedLeftWrist.x > swappedRightWrist.x, "swapped physical positions retain their original wrist names");

// 750ms sustained three-anchor loss (3+ consecutive fails latch the window) now
// FREEZES the anchors instead of pausing (0.0.60 F4): the session keeps playing,
// the markers hold their last positions, and the last measured frame is republished
// as frozen evidence so scoring stays live on the held positions. A dedicated
// service starts in a clean calibrated/countdown state (mid-play) so the freeze
// scenario is not contaminated by an in-progress T-pose hold.
const freezeService = createAeroBodyGridService({ calibrationIdPrefix: "freeze" });
calibrate(freezeService, 0);
for (let at = 2500; at <= 6250; at += 250) {
  freezeService.processPoseSample(pose(at, releasedChanges));
}
snapshot = freezeService.getSnapshot();
assert.equal(snapshot.calibration.state, "calibrated");
assert.equal(snapshot.calibration.readiness, "countdown", "the freeze scenario starts in a clean mid-play state");
const beforeFreeze = JSON.stringify(snapshot.anchors);
const beforeFreezeId = snapshot.calibration.calibrationId;
const beforeFreezeEvidence = snapshot.latestEvidence;
freezeService.processPoseSample(pose(6500, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(freezeService.getSnapshot().tracking.anchorsFrozen, false, "one failed sample never latches the freeze");
assert.deepEqual(freezeService.getSnapshot().tracking.degradedAnchors, ["right_wrist"], "the degraded set tracks the low-confidence loss anchors");
snapshot = freezeService.processPoseSample(pose(6750, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(snapshot.tracking.gameplayPaused, false, "one failed sample never latches the loss window");
assert.equal(snapshot.tracking.anchorsFrozen, false, "two consecutive fails stay under the hysteresis latch");
snapshot = freezeService.processPoseSample(pose(7000, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(snapshot.tracking.anchorsFrozen, false, "three consecutive fails latch the window but 750ms have not elapsed");
snapshot = freezeService.processPoseSample(pose(7250, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(snapshot.tracking.gameplayPaused, false, "calibrated loss freezes the anchors instead of pausing gameplay");
assert.equal(snapshot.tracking.anchorsFrozen, true, "sustained calibrated loss enters the anchor freeze");
assert.equal(snapshot.tracking.freshCalibrationRequired, false, "the freeze never requires a fresh calibration");
assert.equal(snapshot.calibration.state, "tracking_lost", "the grid debug dim follows the tracking-lost state");
assert.equal(snapshot.calibration.readiness, "countdown", "readiness stays countdown through the freeze");
assert.equal(snapshot.calibration.calibrationId, beforeFreezeId, "the freeze keeps the calibration generation");
assert.equal(snapshot.retainedGeometryDimmed, true);
assert.equal(snapshot.countdownFrozen, false, "the countdown is not frozen while the session keeps playing");
assert.deepEqual(snapshot.tracking.degradedAnchors, ["right_wrist"]);
const frozenEvidence = snapshot.latestEvidence;
assert.ok(frozenEvidence && isGameplayEvidenceSnapshot(frozenEvidence));
assert.equal(frozenEvidence.provenance, "frozen");
assert.equal(frozenEvidence.frozenTickId, 1, "the first frozen publication carries per-tick identity 1");
assert.equal(frozenEvidence.measurementTimestampMs, beforeFreezeEvidence.measurementTimestampMs, "frozen frames repeat the last measured frame's timestamp");
assert.equal(frozenEvidence.measuredSourceFrameId, beforeFreezeEvidence.measuredSourceFrameId, "frozen frames repeat the last measured frame's identity");
assert.equal(frozenEvidence.calibrationId, beforeFreezeId);
assert.deepEqual(frozenEvidence.activeBoxingActions, [], "frozen frames mint no new semantic actions");
assert.deepEqual(frozenEvidence.entries, [], "frozen frames mint no new cell entries");
assert.equal(JSON.stringify(snapshot.anchors), beforeFreeze, "failing frames never clobber the held anchor positions");
assert.ok(snapshot.anchors.every(isBodyGridAnchorSnapshot));
assert.equal(JSON.stringify(frozenEvidence.anchors), beforeFreeze, "the held evidence keeps the last good frame's positions");

// Failing frames while frozen keep the freeze, advance the per-tick identity and
// never clobber the held positions. An anchor that recovers above the gate leaves
// the degraded set while the freeze continues.
snapshot = freezeService.processPoseSample(pose(7500, { nose: { x: 0.5, y: 0.3, confidence: 0.2 }, right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(snapshot.tracking.anchorsFrozen, true, "a further failing frame keeps the freeze");
assert.deepEqual(snapshot.tracking.degradedAnchors, ["nose", "right_wrist"], "a second lost anchor joins the degraded set");
assert.equal(snapshot.latestEvidence.frozenTickId, 2, "each frozen publication increments the per-tick identity");
assert.equal(snapshot.latestEvidence.measurementTimestampMs, beforeFreezeEvidence.measurementTimestampMs);
assert.equal(JSON.stringify(snapshot.anchors), beforeFreeze);
snapshot = freezeService.processPoseSample(pose(7750, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.deepEqual(snapshot.tracking.degradedAnchors, ["right_wrist"], "an anchor back above the gate leaves the degraded set");
assert.equal(snapshot.latestEvidence.frozenTickId, 3);
// A no-frame tick while frozen also advances the held-evidence publication.
snapshot = freezeService.advanceTime(8000);
assert.equal(snapshot.tracking.anchorsFrozen, true, "no-frame ticks keep the freeze");
assert.equal(snapshot.latestEvidence.frozenTickId, 4, "advanceTime ticks the held-evidence publication");
assert.equal(snapshot.latestEvidence.provenance, "frozen");
assert.equal(JSON.stringify(snapshot.anchors), beforeFreeze, "advanceTime never touches the held anchors");

// Resume: the very next passing sample clears the freeze — no hold, no gesture,
// no T-pose — and measured evidence resumes on the same calibration.
snapshot = freezeService.processPoseSample(pose(8250, releasedChanges));
assert.equal(snapshot.tracking.anchorsFrozen, false, "the next passing sample clears the freeze immediately");
assert.equal(snapshot.tracking.gameplayPaused, false);
assert.equal(snapshot.tracking.freshCalibrationRequired, false);
assert.deepEqual(snapshot.tracking.degradedAnchors, []);
assert.equal(snapshot.calibration.readiness, "countdown");
assert.equal(snapshot.calibration.state, "calibrated");
assert.equal(snapshot.calibration.calibrationId, beforeFreezeId, "resume does not mint a new calibration");
assert.ok(snapshot.latestEvidence && isGameplayEvidenceSnapshot(snapshot.latestEvidence));
assert.equal(snapshot.latestEvidence.provenance, "measured", "measured evidence resumes immediately");
assert.equal(snapshot.latestEvidence.measurementTimestampMs, 8250);
assert.ok(snapshot.latestEvidence.frozenTickId === undefined, "measured frames carry no frozen-tick identity");

// D1 recovery seam (mobile-menu + shell-matrix reds): after an UNCALIBRATED-path
// tracking loss (the service had been invalidated to fresh-required), a committed
// recalibration must NOT keep publishing the PREVIOUS generation's measured frame.
// The coordinator's public contract rejects cross-generation evidence; with the
// per-frame throw swallowed at the assembly seam that rejection froze the session
// clock in paused_tracking forever. A committed recalibration therefore drops the
// stale frame — its own held-frame bookkeeping — so the snapshot's evidence can
// never contradict its calibration.
{
  const recService = createAeroBodyGridService({ calibrationIdPrefix: "recal" });
  // Initial T-pose → test-1, then released to calibrated/countdown with live evidence.
  calibrate(recService, 0);
  for (let at = 2500; at <= 6250; at += 250) recService.processPoseSample(pose(at, releasedChanges));
  let rec = recService.getSnapshot();
  assert.equal(rec.calibration.calibrationId, "recal-1");
  assert.ok(rec.latestEvidence && rec.latestEvidence.calibrationId === "recal-1");
  // Sustained loss while CALIBRATED enters the anchor freeze (same id, fresh=false).
  for (const at of [7000, 7250, 7500, 7750]) recService.processPoseSample(pose(at, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
  rec = recService.getSnapshot();
  assert.equal(rec.tracking.anchorsFrozen, true, "calibrated loss freezes the anchors");
  assert.equal(rec.tracking.freshCalibrationRequired, false);
  assert.equal(rec.latestEvidence.calibrationId, "recal-1", "frozen evidence stays on the old generation");
  // Reset (source/menu path) invalidates: fresh-required and the stale frame is
  // cleared by the invalidation itself. The production hazard was a STALE FRAME
  // SURVIVING INTO THE NEW GENERATION (held across the reset while the recalibration
  // committed) — that window no longer exists because reset clears it, AND the
  // commit below additionally drops any frame that somehow persists. Either way the
  // new generation must never publish old-generation evidence.
  recService.resetCalibration("manual_reset");
  rec = recService.getSnapshot();
  assert.equal(rec.tracking.freshCalibrationRequired, true);
  assert.equal(rec.latestEvidence, null, "reset clears the previous generation's published frame");
  for (const offset of [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250]) recService.processPoseSample(pose(8000 + offset));
  rec = recService.getSnapshot();
  assert.equal(rec.calibration.calibrationId, "recal-2", "the mid-run recalibration commits a new generation");
  assert.equal(rec.tracking.freshCalibrationRequired, false);
  assert.equal(rec.tracking.gameplayPaused, false);
  assert.equal(rec.calibration.readiness, "countdown", "a fresh-required recovery commit reaches countdown immediately");
  assert.equal(rec.calibration.releaseRequired, true, "the recovery snapshot still reports the physically held pose");
  assert.ok(!rec.latestEvidence || rec.latestEvidence.calibrationId === "recal-2", "the committed snapshot carries no old-generation evidence");
  rec = recService.processPoseSample(pose(10400));
  assert.equal(rec.calibration.readiness, "countdown", "continued held frames do not re-arm a fresh recovery commit");
  assert.equal(rec.calibration.releaseRequired, true);
  assert.ok(!rec.latestEvidence || rec.latestEvidence.calibrationId === "recal-2", "continued held frames cannot restore cross-generation evidence");
  // The first scored standing frame re-publishes fresh evidence on the NEW id.
  rec = recService.processPoseSample(pose(10500, releasedChanges));
  assert.equal(rec.latestEvidence?.calibrationId ?? null, "recal-2", "post-recalibration scoring adopts the new generation");
}

// 0.0.72: mid-game T-pose recalibration gesture gate. While the session is in
// active gameplay (the assembly disables midGameRecalibrationEnabled), a T-pose
// held during a move must NOT commit a new calibration generation (which would
// mint a fresh calibrationId, force the coordinator to pause, and run the resume
// countdown). Initial calibration and pause-screen / recovery recalibration
// remain enabled, so the gate only suppresses the healthy mid-game refire.
{
  // (A) Default gate ON: a mid-game T-pose hold commits a new generation (backward-compat).
  const gateOn = createAeroBodyGridService({ calibrationIdPrefix: "gate-on" });
  calibrate(gateOn, 0);
  for (let at = 2500; at <= 6250; at += 250) gateOn.processPoseSample(pose(at, releasedChanges));
  let onSnap = gateOn.getSnapshot();
  assert.equal(onSnap.calibration.calibrationId, "gate-on-1");
  assert.equal(onSnap.calibration.state, "calibrated");
  for (let at = 7000; at <= 11500; at += 250) gateOn.processPoseSample(pose(at));
  onSnap = gateOn.getSnapshot();
  assert.equal(onSnap.calibration.calibrationId, "gate-on-2", "gate ON: a mid-game T-pose hold commits a new generation");

  // (B) Gate OFF: a mid-game T-pose hold does NOT commit; the service stays on the
  // same generation, unpaused, with no fresh-calibration requirement.
  const gateOff = createAeroBodyGridService({ calibrationIdPrefix: "gate-off" });
  calibrate(gateOff, 0);
  for (let at = 2500; at <= 6250; at += 250) gateOff.processPoseSample(pose(at, releasedChanges));
  let offSnap = gateOff.getSnapshot();
  assert.equal(offSnap.calibration.calibrationId, "gate-off-1");
  assert.equal(offSnap.calibration.state, "calibrated");
  gateOff.setMidGameRecalibrationEnabled(false);
  for (let at = 7000; at <= 11500; at += 250) gateOff.processPoseSample(pose(at));
  offSnap = gateOff.getSnapshot();
  assert.equal(offSnap.calibration.calibrationId, "gate-off-1", "gate OFF: a mid-game T-pose hold does NOT commit a new generation");
  assert.equal(offSnap.tracking.gameplayPaused, false, "gate OFF: no tracking pause from a mid-game T-pose");
  assert.equal(offSnap.tracking.freshCalibrationRequired, false, "gate OFF: no fresh-calibration requirement from a mid-game T-pose");

  // (C) Initial calibration still works with the gate off (bounds null path).
  const gateFresh = createAeroBodyGridService({ calibrationIdPrefix: "gate-fresh" });
  gateFresh.setMidGameRecalibrationEnabled(false);
  const freshSnap = calibrate(gateFresh, 0);
  assert.equal(freshSnap.calibration.calibrationId, "gate-fresh-1", "gate OFF: initial calibration still commits");
  assert.equal(freshSnap.calibration.readiness, "countdown");

  // (D) Recovery recalibration (after resetCalibration) still works with the gate
  // off — the pause-screen / recovery path is unaffected by the gate.
  gateOff.resetCalibration("menu_open");
  let recOffSnap = gateOff.getSnapshot();
  assert.equal(recOffSnap.tracking.freshCalibrationRequired, true, "gate OFF: reset arms a fresh-required recovery");
  for (let offset = 0; offset <= 2250; offset += 250) gateOff.processPoseSample(pose(12000 + offset));
  recOffSnap = gateOff.getSnapshot();
  assert.equal(recOffSnap.calibration.calibrationId, "gate-off-2", "gate OFF: a recovery T-pose recalibration still commits");
  assert.equal(recOffSnap.tracking.freshCalibrationRequired, false);
}

// (e) Anti-flicker: a single bad sample never (re-)enters the freeze, and the
// freeze only latches after 3 consecutive fails spanning 750ms. The freeze is
// cleared by the very next passing sample.
const interruptService = createAeroBodyGridService({ calibrationIdPrefix: "interrupt" });
calibrate(interruptService, 0);
for (let at = 2500; at <= 6250; at += 250) {
  interruptService.processPoseSample(pose(at, releasedChanges));
}
// One, two, then three consecutive fails: only the third latches the window but
// 750ms have not elapsed yet, so no freeze.
interruptService.processPoseSample(pose(6500, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(interruptService.getSnapshot().tracking.anchorsFrozen, false, "a single dropped sample cannot enter the freeze");
interruptService.processPoseSample(pose(6750, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
interruptService.processPoseSample(pose(7000, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(interruptService.getSnapshot().tracking.anchorsFrozen, false, "the window latches at three fails but 750ms have not elapsed");
// The fourth fail reaches 750ms: the freeze engages (not a pause).
interruptService.processPoseSample(pose(7250, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(interruptService.getSnapshot().tracking.anchorsFrozen, true, "sustained loss enters the freeze");
assert.equal(interruptService.getSnapshot().tracking.gameplayPaused, false, "the freeze does not pause gameplay");
// A passing sample clears the freeze on the very next good frame (no hold).
interruptService.processPoseSample(pose(7500, releasedChanges));
assert.equal(interruptService.getSnapshot().tracking.anchorsFrozen, false, "the passing sample clears the freeze immediately");
assert.equal(interruptService.getSnapshot().latestEvidence.provenance, "measured");
// A single bad sample after resume restarts the hysteresis clock (no re-freeze).
interruptService.processPoseSample(pose(7600, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(interruptService.getSnapshot().tracking.anchorsFrozen, false, "one post-resume bad sample restarts the hysteresis clock");
interruptService.processPoseSample(pose(7700, releasedChanges));
assert.equal(interruptService.getSnapshot().tracking.anchorsFrozen, false);

// 0.0.60 W6 (in0o): an interrupted mid-song T-pose hold must not pin the
// service in recalibrating/calibration_required. A CLEAN dedicated service
// (mirroring the freezeService pattern) starts calibrated/countdown so the
// scenario is not contaminated by the main service's T-pose history.
const holdInterrupt = createAeroBodyGridService({ calibrationIdPrefix: "hold-interrupt" });
calibrate(holdInterrupt, 0);
for (let at = 2500; at <= 6250; at += 250) {
  holdInterrupt.processPoseSample(pose(at, releasedChanges));
}
snapshot = holdInterrupt.getSnapshot();
assert.equal(snapshot.calibration.state, "calibrated", "the hold-interrupt scenario starts in a clean mid-play state");
assert.equal(snapshot.calibration.readiness, "countdown");
// Valid T-pose hold frames start a recalibration hold mid-song.
snapshot = holdInterrupt.processPoseSample(pose(6500));
assert.equal(snapshot.calibration.state, "recalibrating", "a T-pose hold frame starts the recalibration hold");
assert.equal(snapshot.calibration.readiness, "calibration_required");
snapshot = holdInterrupt.processPoseSample(pose(6750));
assert.equal(snapshot.calibration.state, "recalibrating");
assert.equal(snapshot.calibration.holdProgressMs, 250, "the hold accumulates while the T-pose is held");
// ONE non-hold frame interrupts the hold mid-window: the hold is cleared and
// the service reconciles back to its healthy calibrated/countdown state.
snapshot = holdInterrupt.processPoseSample(pose(7000, releasedChanges));
assert.equal(snapshot.calibration.holdProgressMs, 0, "the interrupting frame cancels the incomplete hold");
assert.equal(snapshot.calibration.state, "calibrated", "an interrupted hold reconciles back to calibrated");
assert.equal(snapshot.calibration.readiness, "countdown", "an interrupted hold reconciles readiness back to countdown");
assert.equal(snapshot.calibration.calibrationId, "hold-interrupt-1", "the interrupted hold never mints a new calibration");
assert.equal(snapshot.tracking.freshCalibrationRequired, false, "the interruption never requires a fresh calibration");
// A further neutral frame stays healthy (no re-stick).
snapshot = holdInterrupt.processPoseSample(pose(7250, releasedChanges));
assert.equal(snapshot.calibration.state, "calibrated", "a further neutral frame does not re-stick the service");
assert.equal(snapshot.calibration.readiness, "countdown");
// A fresh, uninterrupted hold after the interruption still commits (completed
// hold behavior is unchanged).
for (let at = 7500; at <= 9500; at += 250) {
  holdInterrupt.processPoseSample(pose(at));
}
assert.equal(holdInterrupt.getSnapshot().calibration.calibrationId, "hold-interrupt-2", "a fresh uninterrupted hold after the interruption still commits");

// D1(b): a wrist placed OUTSIDE the calibrated grid bounds but still visible
// with confidence >= requiredConfidence keeps staging (valid, finite x/y, no
// scoring cell/subcell) and triggers no pause or invalidation.
const offGridService = createAeroBodyGridService({ calibrationIdPrefix: "off-grid" });
calibrate(offGridService, 0);
for (let at = 2500; at <= 6250; at += 250) {
  offGridService.processPoseSample(pose(at, releasedChanges));
}
snapshot = offGridService.processPoseSample(pose(6500, {
  ...releasedChanges,
  left_wrist: { x: 1.0, y: 0.5 } // camera x=1.0 -> athlete x=0.0 -> raw -0.333, well past the left grid edge
}));
const offGridWrist = snapshot.anchors.find((anchor) => anchor.anchor === "left_wrist");
assert.ok(offGridWrist, "the off-grid wrist anchor is present in the snapshot");
assert.equal(offGridWrist.valid, true, "the off-grid wrist stays staged by signal validity");
assert.ok(Number.isFinite(offGridWrist.x) && Number.isFinite(offGridWrist.y), "the off-grid wrist keeps finite staging coordinates");
assert.equal(offGridWrist.cell, null, "the off-grid wrist occupies no scoring cell");
assert.equal(offGridWrist.subcell, null, "the off-grid wrist occupies no scoring subcell");
assert.equal(snapshot.tracking.gameplayPaused, false, "going off-grid never pauses gameplay");
assert.equal(snapshot.tracking.freshCalibrationRequired, false, "going off-grid never requires a fresh calibration");
assert.equal(snapshot.tracking.anchorsFrozen, false, "going off-grid never enters the anchor freeze");
assert.equal(snapshot.calibration.state, "calibrated", "going off-grid leaves the calibration state untouched");
assert.equal(offGridWrist.anchor, "left_wrist");

// A bilateral, confident, horizontally extended off-grid pose can resemble a
// T-pose, but in an ordinary healthy calibrated session it is still motion
// outside the active authority bounds—not permission to replace those bounds.
const bilateralOffGrid = createAeroBodyGridService({ calibrationIdPrefix: "bilateral-off-grid" });
calibrate(bilateralOffGrid, 0);
for (let at = 2500; at <= 6250; at += 250) {
  bilateralOffGrid.processPoseSample(pose(at, releasedChanges));
}
const bilateralBounds = bilateralOffGrid.getSnapshot().calibration.bounds;
assert.ok(bilateralBounds);
for (let at = 6500; at <= 8750; at += 250) {
  snapshot = bilateralOffGrid.processPoseSample(pose(at, {
    left_wrist: { x: 1.0, y: 0.4 },
    right_wrist: { x: 0.0, y: 0.4 }
  }));
  assert.equal(snapshot.calibration.calibrationId, "bilateral-off-grid-1", "bilateral off-grid motion never replaces healthy calibration");
  assert.deepEqual(snapshot.calibration.bounds, bilateralBounds, "bilateral off-grid motion preserves the active bounds");
  assert.equal(snapshot.calibration.state, "calibrated", "bilateral off-grid motion never starts a recalibration hold");
  assert.equal(snapshot.calibration.readiness, "countdown", "bilateral off-grid motion keeps countdown participation ready");
  assert.equal(snapshot.tracking.gameplayPaused, false, "bilateral off-grid motion never pauses gameplay");
  assert.equal(snapshot.tracking.freshCalibrationRequired, false, "bilateral off-grid motion never requires fresh calibration");
  for (const wristName of ["left_wrist", "right_wrist"]) {
    const wrist = snapshot.anchors.find((anchor) => anchor.anchor === wristName);
    assert.ok(wrist, `${wristName} remains staged while off-grid`);
    assert.ok(Number.isFinite(wrist.x) && Number.isFinite(wrist.y), `${wristName} keeps finite off-grid coordinates`);
    assert.equal(wrist.cell, null, `${wristName} has no scoring cell while off-grid`);
    assert.equal(wrist.subcell, null, `${wristName} has no scoring subcell while off-grid`);
  }
}

// Full T-pose calibration remains available and is the invalidation path for source changes.
for (let at = 14000; at <= 14250; at += 250) {
  service.processPoseSample(pose(at, releasedChanges));
}
snapshot = calibrate(service, 14500);
assert.equal(snapshot.calibration.calibrationId, "test-2");
assert.equal(snapshot.tracking.gameplayPaused, false);
assert.equal(snapshot.tracking.freshCalibrationRequired, false);
assert.equal(snapshot.calibration.readiness, "calibration_required", "an ordinary full T-pose refire waits for physical release");

// Source, mirror, and source-aspect identity changes each invalidate scoring without applying a second x flip.
snapshot = service.processPoseSample(pose(17000), { sourceAspectRatio: 4 / 3, sourceChangeId: "camera-b" });
assert.equal(snapshot.calibration.state, "recalibrating");
assert.equal(snapshot.calibration.invalidationReason, "source_changed");
assert.equal(snapshot.retainedGeometryDimmed, true);
assert.equal(snapshot.latestEvidence, null);

for (const kind of ["source", "mirror", "aspect"]) {
  const identityService = createAeroBodyGridService({ calibrationIdPrefix: `identity-${kind}` });
  calibrate(identityService, 0);
  identityService.processPoseSample(pose(4100, {
    left_elbow: { x: 0.61, y: 0.52 }, right_elbow: { x: 0.39, y: 0.52 },
    left_wrist: { x: 0.56, y: 0.55 }, right_wrist: { x: 0.44, y: 0.55 }
  }));
  const changed = kind === "source"
    ? pose(4200, {}, { sourceId: "camera-other" })
    : pose(4200, {}, { mirrored: false });
  snapshot = identityService.processPoseSample(changed, kind === "aspect" ? { sourceAspectRatio: 4 / 3 } : {});
  assert.equal(snapshot.calibration.invalidationReason, "source_changed", `${kind} changes invalidate calibration`);
  assert.equal(snapshot.tracking.freshCalibrationRequired, true);
}

// Source change does NOT allow partial auto-recovery: full T-pose recalibration is required.
const sourceNoRecovery = createAeroBodyGridService({ calibrationIdPrefix: "source-no-recovery" });
calibrate(sourceNoRecovery, 0);
for (let at = 2500; at <= 6250; at += 250) {
  sourceNoRecovery.processPoseSample(pose(at, releasedChanges));
}
// Source change invalidates calibration; recovery is not armed.
sourceNoRecovery.processPoseSample(pose(6500, {}, { sourceId: "camera-b" }));
assert.equal(sourceNoRecovery.getSnapshot().tracking.freshCalibrationRequired, true);
// Even with the three loss-decision anchors visible and stable for 300ms,
// partial recovery does not clear freshCalibrationRequired after a source change.
for (let at = 6600; at <= 7200; at += 250) {
  sourceNoRecovery.processPoseSample(pose(at, releasedChanges, { sourceId: "camera-b" }));
}
assert.equal(sourceNoRecovery.getSnapshot().tracking.freshCalibrationRequired, true, "source change requires full T-pose, not partial recovery");
assert.equal(sourceNoRecovery.getSnapshot().tracking.recoveryInProgress, false, "no recovery hold after a source change");

// A source-invalidated recovery must be free to replace the retained bounds,
// even when both wrists lie outside those old bounds.
const sourceReplacement = createAeroBodyGridService({ calibrationIdPrefix: "source-replacement" });
calibrate(sourceReplacement, 0);
for (let at = 2500; at <= 6250; at += 250) {
  sourceReplacement.processPoseSample(pose(at, releasedChanges));
}
const retainedSourceBounds = sourceReplacement.getSnapshot().calibration.bounds;
assert.ok(retainedSourceBounds);
for (let at = 6500; at <= 8500; at += 250) {
  snapshot = sourceReplacement.processPoseSample(pose(at, {
    left_wrist: { x: 1.0, y: 0.4 },
    right_wrist: { x: 0.0, y: 0.4 }
  }, { sourceId: "camera-b" }));
}
assert.equal(snapshot.calibration.calibrationId, "source-replacement-2", "source-change recovery accepts replacement bounds");
assert.notDeepEqual(snapshot.calibration.bounds, retainedSourceBounds, "source-change recovery replaces the old bounds");
assert.equal(snapshot.tracking.freshCalibrationRequired, false);
assert.equal(snapshot.tracking.gameplayPaused, false);
assert.equal(snapshot.calibration.readiness, "countdown", "source-change recovery resumes countdown immediately");

// (a) Five scattered bad frames within 1s: consecutive fails never reach the
// three-sample latch, so no pause can occur.
const scattered = createAeroBodyGridService({ calibrationIdPrefix: "scattered" });
calibrate(scattered, 0);
for (let at = 2500; at <= 6250; at += 250) {
  scattered.processPoseSample(pose(at, releasedChanges));
}
for (let i = 0; i < 5; i += 1) {
  scattered.processPoseSample(pose(6500 + i * 200, leftWristLoss));
  scattered.processPoseSample(pose(6600 + i * 200, releasedChanges));
}
assert.equal(scattered.getSnapshot().tracking.gameplayPaused, false, "non-consecutive dropped samples never trip the loss clock");
assert.equal(scattered.getSnapshot().tracking.freshCalibrationRequired, false);

// (c) A shoulder/elbow-only dropout is NO longer a tracking-loss event:
// shoulders and elbows remain calibration/geometry inputs but do not gate loss.
const shoulderDropout = createAeroBodyGridService({ calibrationIdPrefix: "shoulder-dropout" });
calibrate(shoulderDropout, 0);
for (let at = 2500; at <= 6250; at += 250) {
  shoulderDropout.processPoseSample(pose(at, releasedChanges));
}
for (let at = 6500; at <= 8990; at += 250) {
  const frame = shoulderDropout.processPoseSample(pose(at, shoulderElbowLoss));
  assert.equal(frame.tracking.gameplayPaused, false, "shoulder/elbow-only dropout never pauses gameplay");
  assert.equal(frame.tracking.allRequiredAnchorsVisible, false, "the seven-anchor visibility flag still reflects all anchors");
}
const postShoulderFrame = shoulderDropout.processPoseSample(pose(9100, releasedChanges));
assert.equal(postShoulderFrame.tracking.gameplayPaused, false);
assert.equal(postShoulderFrame.tracking.freshCalibrationRequired, false, "no recalibration is required after a non-loss dropout");
assert.equal(shoulderDropout.getSnapshot().calibration.state, "calibrated");
assert.ok(shoulderDropout.getFreshEvidence(9200), "evidence stays fresh through a non-loss dropout");

// Gap-based trigger: a whole silent window latches instantly, but pre-latch
// silence (fresh source, one advanceTime before any measured fail) does not.
// Calibrated, the third missed tick enters the anchor freeze (no pause) and the
// held frame is published as frozen evidence.
const gapSilent = createAeroBodyGridService({ calibrationIdPrefix: "gap-silent" });
calibrate(gapSilent, 0);
for (let at = 2500; at <= 6250; at += 250) {
  gapSilent.processPoseSample(pose(at, releasedChanges));
}
assert.equal(gapSilent.advanceTime(7250).tracking.gameplayPaused, false, "one pre-latch missed tick cannot trip the loss window");
assert.equal(gapSilent.getSnapshot().tracking.anchorsFrozen, false, "one pre-latch missed tick does not freeze the anchors");
assert.equal(gapSilent.advanceTime(7500).tracking.gameplayPaused, false, "two pre-latch missed ticks still cannot trip the loss window");
const gapSilentFrozen = gapSilent.advanceTime(7750);
assert.equal(gapSilentFrozen.tracking.gameplayPaused, false, "the freeze does not pause gameplay");
assert.equal(gapSilentFrozen.tracking.anchorsFrozen, true, "three consecutive missed ticks latch and enter the anchor freeze");
assert.equal(gapSilentFrozen.tracking.freshCalibrationRequired, false, "the freeze does not require fresh calibration");
assert.deepEqual(gapSilentFrozen.tracking.degradedAnchors, ["nose", "left_wrist", "right_wrist"], "a no-frame trigger counts every loss-decision anchor as degraded");
assert.equal(gapSilentFrozen.latestEvidence?.provenance, "frozen", "the held frame is published as frozen evidence");
assert.equal(gapSilentFrozen.latestEvidence?.frozenTickId, 1);
assert.equal(gapSilentFrozen.anchors.length, 7, "anchors are retained at their last positions while frozen");
assert.ok(gapSilentFrozen.anchors.every((anchor) => anchor.valid), "held anchors keep their last valid positions");

const explicitReset = createAeroBodyGridService({ calibrationIdPrefix: "explicit-reset" });
calibrate(explicitReset, 0);
for (let at = 2500; at <= 6250; at += 250) {
  explicitReset.processPoseSample(pose(at, releasedChanges));
}
snapshot = explicitReset.resetCalibration("badge_reset");
assert.equal(snapshot.tracking.gameplayPaused, true);
assert.equal(snapshot.calibration.invalidationReason, "badge_reset");
assert.ok(snapshot.calibration.bounds);

// An explicit/manual reset or actual source change retains old display
// geometry, not permission to auto-recover from a camera restart gap.
for (const reason of ["explicit_reset", "manual_reset", "source_changed"]) {
  for (const gapPath of ["advanceTime", "measured_gap"]) {
    const resetService = createAeroBodyGridService({ calibrationIdPrefix: `fresh-${reason}-${gapPath}` });
    calibrate(resetService, 0);
    for (let at = 2500; at <= 6250; at += 250) {
      resetService.processPoseSample(pose(at, releasedChanges));
    }
    const previous = resetService.getSnapshot().calibration;
    assert.ok(previous.bounds);
    snapshot = reason === "source_changed"
      ? resetService.processPoseSample(pose(6350, releasedChanges, { sourceId: "camera-b" }))
      : resetService.resetCalibration(reason);
    assert.equal(snapshot.calibration.invalidationReason, reason);
    const sourceOptions = reason === "source_changed" ? { sourceId: "camera-b" } : {};
    if (gapPath === "advanceTime") {
      resetService.advanceTime(6600);
      resetService.advanceTime(6800);
      snapshot = resetService.advanceTime(7100);
    } else {
      snapshot = resetService.processPoseSample(pose(7100, releasedChanges, sourceOptions));
    }
    assert.equal(snapshot.calibration.invalidationReason, reason, `${reason}/${gapPath} retains reset intent`);
    assert.equal(snapshot.tracking.freshCalibrationRequired, true);
    assert.equal(snapshot.tracking.recoveryInProgress, false);
    assert.equal(snapshot.calibration.calibrationId, previous.calibrationId);
    assert.deepEqual(snapshot.calibration.bounds, previous.bounds);
    for (let at = 7200; at <= 7800; at += 100) {
      snapshot = resetService.processPoseSample(pose(at, releasedChanges, sourceOptions));
    }
    assert.equal(snapshot.tracking.freshCalibrationRequired, true, `${reason}/${gapPath} non-T-pose cannot recover`);
    assert.equal(snapshot.tracking.recoveryInProgress, false);
    assert.equal(snapshot.calibration.calibrationId, previous.calibrationId);
    assert.notEqual(snapshot.calibration.readiness, "countdown");
    for (let at = 7900; at <= 9900; at += 250) {
      snapshot = resetService.processPoseSample(pose(at, {}, sourceOptions));
    }
    assert.notEqual(snapshot.calibration.calibrationId, previous.calibrationId, "measured T-pose mints a fresh ID");
    assert.equal(snapshot.tracking.freshCalibrationRequired, false);
    assert.equal(snapshot.calibration.readiness, "countdown");
  }
}

// Uncalibrated accidental loss remains classified as tracking loss, and
// ordinary calibrated loss still freezes/recovers with its original ID.
const initialLoss = createAeroBodyGridService({ calibrationIdPrefix: "initial-loss" });
initialLoss.processPoseSample(pose(0));
initialLoss.advanceTime(250);
initialLoss.advanceTime(500);
snapshot = initialLoss.advanceTime(750);
assert.equal(snapshot.calibration.invalidationReason, "tracking_lost");
assert.equal(snapshot.tracking.freshCalibrationRequired, true);
const ordinaryLoss = createAeroBodyGridService({ calibrationIdPrefix: "ordinary-loss" });
calibrate(ordinaryLoss, 0);
for (let at = 2500; at <= 6250; at += 250) {
  ordinaryLoss.processPoseSample(pose(at, releasedChanges));
}
const ordinaryId = ordinaryLoss.getSnapshot().calibration.calibrationId;
snapshot = ordinaryLoss.processPoseSample(pose(7250, releasedChanges));
assert.equal(snapshot.tracking.anchorsFrozen, false, "first visible frame clears ordinary gap freeze");
assert.equal(snapshot.calibration.calibrationId, ordinaryId);
assert.equal(snapshot.tracking.freshCalibrationRequired, false);
assert.equal(snapshot.calibration.readiness, "countdown");

// No-frame timeout uses the last real measurement and does not invent evidence.
const timeoutService = createAeroBodyGridService({ calibrationIdPrefix: "timeout" });
calibrate(timeoutService, 0);
for (let at = 2500; at <= 6250; at += 250) {
  timeoutService.processPoseSample(pose(at, {
    left_elbow: { x: 0.61, y: 0.52 }, right_elbow: { x: 0.39, y: 0.52 },
    left_wrist: { x: 0.56, y: 0.55 }, right_wrist: { x: 0.44, y: 0.55 }
  }));
}
assert.equal(timeoutService.advanceTime(6500).tracking.gameplayPaused, false, "a first missed tick before the latch does not pause");
assert.equal(timeoutService.advanceTime(6750).tracking.anchorsFrozen, false, "a second missed tick still cannot trip the loss window");
snapshot = timeoutService.advanceTime(7000);
assert.equal(snapshot.tracking.gameplayPaused, false, "the freeze does not pause a calibrated session");
assert.equal(snapshot.tracking.anchorsFrozen, true, "three consecutive no-frame misses latch and enter the anchor freeze");
assert.equal(snapshot.tracking.freshCalibrationRequired, false);
assert.equal(snapshot.latestEvidence?.provenance, "frozen", "the held frame is republished as frozen evidence");
assert.equal(snapshot.latestEvidence?.frozenTickId, 1);
assert.equal(snapshot.anchors.length, 7, "anchors are retained at their last positions while frozen");

const averagedService = createAeroBodyGridService({ calibrationIdPrefix: "average" });
for (let index = 0; index <= 8; index += 1) {
  const leftX = 0.75 + 0.1 * index / 16;
  averagedService.processPoseSample(pose(index * 250, {
    left_wrist: { x: leftX, y: 0.4 },
    right_wrist: { x: 1 - leftX, y: 0.4 }
  }));
}
const averagedBounds = averagedService.getSnapshot().calibration.bounds;
assert.ok(averagedBounds);
assert.ok(Math.abs(averagedBounds.left - 0.225) < 1e-9, "geometry uses the complete 2000ms hold-window average");
assert.ok(Math.abs(averagedBounds.right - 0.775) < 1e-9, "geometry uses the complete 2000ms hold-window average");

// Padding/aspect are measured in source pixels: width and height grow independently.
const padded = createAeroBodyGridService({ calibrationIdPrefix: "padded", sourceAspectRatio: 1, padding: { left: 0.1, right: 0.1, top: 0.2, bottom: 0.2 } });
snapshot = calibrate(padded, 0, { sourceAspectRatio: 1 });
const paddedBounds = snapshot.calibration.bounds;
assert.ok(paddedBounds);
assert.ok(Math.abs((paddedBounds.right - paddedBounds.left) - 0.72) < 1e-9);
assert.ok(Math.abs((paddedBounds.bottom - paddedBounds.top) - 0.63) < 1e-9);
assert.ok(Math.abs(snapshot.calibratedShoulderWorldY - 1) < 1e-9, "symmetric padding keeps the shoulder baseline centered");
const unevenPadding = createAeroBodyGridService({ calibrationIdPrefix: "uneven-shoulder", sourceAspectRatio: 1, padding: { top: 0.2 } });
snapshot = calibrate(unevenPadding, 0, { sourceAspectRatio: 1 });
assert.ok(Math.abs(snapshot.calibratedShoulderWorldY - 0.75) < 1e-9, "asymmetric padding projects the actual averaged shoulder center, not a hardcoded row");

// A sparse pair of frames cannot masquerade as a sustained two-second hold.
const sparseHold = createAeroBodyGridService({ calibrationIdPrefix: "sparse" });
sparseHold.processPoseSample(pose(0));
snapshot = sparseHold.processPoseSample(pose(2100));
assert.equal(snapshot.calibration.calibrationId, null);
assert.equal(snapshot.tracking.gameplayPaused, true, "a full silent window is a latched loss");
assert.equal(snapshot.tracking.freshCalibrationRequired, true);

const irregularHold = createAeroBodyGridService({ calibrationIdPrefix: "irregular" });
for (let at = 0; at <= 2000; at += 100) {
  irregularHold.processPoseSample(pose(at));
}
snapshot = irregularHold.getSnapshot();
assert.equal(snapshot.calibration.calibrationId, "irregular-1", "the exact 2000ms boundary qualifies");

const refire = createAeroBodyGridService({ calibrationIdPrefix: "refire" });
calibrate(refire, 0);
for (let at = 2500; at <= 6000; at += 250) {
  refire.processPoseSample(pose(at));
}
assert.equal(refire.getSnapshot().calibration.calibrationId, "refire-1", "cooldown blocks held-pose refire");
assert.equal(refire.getSnapshot().calibration.releaseRequired, true);
refire.processPoseSample(pose(6250, releasedChanges));
assert.equal(refire.getSnapshot().calibration.releaseRequired, false);
for (let at = 6500; at <= 10500; at += 250) {
  refire.processPoseSample(pose(at));
}
snapshot = refire.getSnapshot();
assert.equal(snapshot.calibration.calibrationId, "refire-2", "release plus a fresh exact hold refires");
assert.equal(snapshot.calibration.readiness, "calibration_required", "an ordinary held-pose refire is not ready before a real release");
assert.equal(snapshot.calibration.releaseRequired, true, "an ordinary held-pose refire keeps release outstanding");
assert.ok(!snapshot.latestEvidence || snapshot.latestEvidence.calibrationId === "refire-2", "an ordinary refire clears evidence from the previous generation");
snapshot = refire.processPoseSample(pose(10750, releasedChanges));
assert.equal(snapshot.calibration.readiness, "countdown", "a real non-T-pose frame releases the ordinary refire");
assert.equal(snapshot.calibration.releaseRequired, false);
assert.equal(snapshot.latestEvidence?.calibrationId ?? null, "refire-2", "post-release evidence belongs to the refired generation");

// Every required anchor independently gates calibration at the exact confidence boundary.
for (const name of names) {
  const confidenceGate = createAeroBodyGridService({ calibrationIdPrefix: `confidence-${name}` });
  snapshot = confidenceGate.processPoseSample(pose(0, { [name]: { x: 0.5, y: 0.3, confidence: 0.499 } }));
  assert.equal(snapshot.calibration.state, "uncalibrated", `${name} below .5 blocks calibration`);
}
const exactConfidence = createAeroBodyGridService({ calibrationIdPrefix: "confidence-exact" });
const exactConfidenceChanges = Object.fromEntries(names.map((name) => [name, { confidence: 0.5 }]));
for (let at = 0; at <= 2000; at += 250) {
  exactConfidence.processPoseSample(pose(at, exactConfidenceChanges));
}
assert.equal(exactConfidence.getSnapshot().calibration.calibrationId, "confidence-exact-1");

// Boxing's Knee strikes toggle, not its strike chance, determines whether BOTH
// current measured knees must share every qualified T-pose frame. Flow/ordinary
// Boxing still use only the seven upper-body anchors tested above.
function poseWithKnees(timestampMs, leftConfidence = 0.95, rightConfidence = 0.95) {
  const sample = pose(timestampMs);
  return { ...sample, landmarks: [
    ...sample.landmarks,
    { name: "left_knee", x: 0.6, y: 0.75, confidence: leftConfidence },
    { name: "right_knee", x: 0.4, y: 0.75, confidence: rightConfidence }
  ] };
}
const conditionalKnees = createAeroBodyGridService({ calibrationIdPrefix: "conditional-knees" });
assert.throws(() => conditionalKnees.setKneeVisibilityRequired(/** @type {boolean} */ (/** @type {unknown} */ (0))), /must be boolean/u);
conditionalKnees.setKneeVisibilityRequired(true);
for (let at = 0; at <= 2000; at += 250) conditionalKnees.processPoseSample(pose(at));
assert.equal(conditionalKnees.getSnapshot().calibration.calibrationId, null, "upper-body T-pose without knees cannot calibrate knee-enabled Boxing even at 0% chance");
snapshot = conditionalKnees.processPoseSample(poseWithKnees(2250, 0.5, 0.499));
assert.equal(snapshot.calibrationChecklist.visible.left_knee, true, "exact .5 knee confidence is visible");
assert.equal(snapshot.calibrationChecklist.visible.right_knee, false, "one flickering knee fails independently");
assert.equal(snapshot.calibrationChecklist.qualified, false);
assert.equal(snapshot.calibration.holdProgressMs, 0);
for (let at = 2500; at <= 3500; at += 250) conditionalKnees.processPoseSample(poseWithKnees(at));
assert.equal(conditionalKnees.getSnapshot().calibration.holdProgressMs, 1000);
snapshot = conditionalKnees.processPoseSample(poseWithKnees(3750, 0.499, 0.95));
assert.equal(snapshot.calibrationChecklist.visible.left_knee, false, "left knee flickers off on this measured frame");
assert.equal(snapshot.calibrationChecklist.visible.right_knee, true);
assert.equal(snapshot.calibration.holdProgressMs, 0, "one dropped knee resets the simultaneous T-pose hold");
for (let at = 4000; at <= 6000; at += 250) conditionalKnees.processPoseSample(poseWithKnees(at, 0.5, 0.5));
assert.equal(conditionalKnees.getSnapshot().calibration.calibrationId, "conditional-knees-1");
assert.ok(Object.isFrozen(conditionalKnees.getSnapshot().calibrationChecklist.visible));
snapshot = conditionalKnees.advanceTime(6250);
assert.equal(snapshot.calibrationChecklist.measuredAt, 6000, "ordinary idle ticks retain the real checklist timestamp");
assert.equal(snapshot.calibrationChecklist.visible.left_knee, true);
const missingKneeFrame = createAeroBodyGridService({ calibrationIdPrefix: "missing-knee-frame" });
missingKneeFrame.setKneeVisibilityRequired(true);
for (let at = 0; at <= 500; at += 250) missingKneeFrame.processPoseSample(poseWithKnees(at));
assert.equal(missingKneeFrame.getSnapshot().calibration.holdProgressMs, 500);
snapshot = missingKneeFrame.advanceTime(625);
assert.equal(snapshot.calibration.state, "holding", "an ordinary idle tick preserves the simultaneous knee hold");
snapshot = missingKneeFrame.processPoseSample(poseWithKnees(750));
assert.equal(snapshot.calibration.holdProgressMs, 750, "resumed measurements continue the same hold");
// Slow, ordinary inference cadence: idle publication must not erase measured
// calibration facts or add samples to the geometry average, in either mode.
for (const kneesRequired of [false, true]) {
  const idle = createAeroBodyGridService({ calibrationIdPrefix: "idle-cadence" });
  const control = createAeroBodyGridService({ calibrationIdPrefix: "idle-cadence" });
  idle.setKneeVisibilityRequired(kneesRequired);
  control.setKneeVisibilityRequired(kneesRequired);
  for (let at = 0; at <= 2000; at += 250) {
    const measured = poseWithKnees(at, 0.5, 0.5);
    // Vary geometry so extra idle samples would change the captured average.
    measured.landmarks = measured.landmarks.map((joint) => ({ ...joint, y: joint.y + at / 100000 }));
    const real = idle.processPoseSample(measured);
    control.processPoseSample(measured);
    assert.equal(real.calibrationChecklist.measuredAt, at);
    if (at === 2000) break;
    for (const offset of [100, 200]) {
      const waiting = idle.advanceTime(at + offset);
      assert.deepEqual(waiting.calibrationChecklist, real.calibrationChecklist, "idle preserves measured checklist including measuredAt");
      assert.equal(waiting.tracking.allRequiredAnchorsVisible, true);
      assert.equal(waiting.calibration.state, "holding");
      assert.equal(waiting.calibration.calibrationId, null, "only a real measured frame can commit the hold");
      assert.equal(waiting.latestEvidence, null, "idle cannot invent measured evidence before calibration");
    }
  }
  assert.equal(idle.getSnapshot().calibration.calibrationId, "idle-cadence-1", "4 FPS with idle ticks commits at the measured two-second hold");
  assert.deepEqual(idle.getSnapshot().calibration.bounds, control.getSnapshot().calibration.bounds, "only measured samples enter the average");
  assert.equal(idle.getSnapshot().calibratedShoulderWorldY, control.getSnapshot().calibratedShoulderWorldY);
  idle.destroy();
  control.destroy();

  // Test exact expiry independently of the unchanged consecutive-loss latch.
  const stale = createAeroBodyGridService();
  stale.setKneeVisibilityRequired(kneesRequired);
  for (const at of [0, 250, 500]) stale.processPoseSample(poseWithKnees(at));
  assert.equal(stale.advanceTime(1249).calibrationChecklist.measuredAt, 500, "749 ms retains real visibility");
  const expired = stale.advanceTime(1250);
  assert.equal(expired.calibrationChecklist.measuredAt, null, "750 ms expires real visibility");
  assert.ok(Object.values(expired.calibrationChecklist.visible).every((visible) => !visible));
  assert.equal(expired.tracking.allRequiredAnchorsVisible, false);
  assert.equal(expired.calibration.holdProgressMs, 0, "stale hold expires in both knee modes even before loss latch");
  assert.equal(stale.advanceTime(3000).calibration.calibrationId, null, "silence alone never calibrates");
  assert.equal(stale.processPoseSample(poseWithKnees(3250)).calibration.holdProgressMs, 0, "next real measurement starts a new hold");
  stale.destroy();

  // Missing and sub-threshold measured joints replace prior facts immediately,
  // not after the idle timeout; exact .5 remains qualified.
  for (const failure of ["missing", "low", "empty"]) {
    const failed = createAeroBodyGridService();
    failed.setKneeVisibilityRequired(kneesRequired);
    for (const at of [0, 250, 500]) failed.processPoseSample(poseWithKnees(at));
    failed.advanceTime(600);
    const jointName = kneesRequired ? "left_knee" : "left_elbow";
    const bad = poseWithKnees(650);
    bad.landmarks = failure === "empty" ? [] : failure === "missing"
      ? bad.landmarks.filter((joint) => joint.name !== jointName)
      : bad.landmarks.map((joint) => joint.name === jointName ? { ...joint, confidence: 0.499 } : joint);
    const failedSnapshot = failed.processPoseSample(bad);
    assert.equal(failedSnapshot.calibrationChecklist.measuredAt, 650);
    assert.equal(failedSnapshot.calibrationChecklist.visible[jointName], false);
    assert.equal(failedSnapshot.calibrationChecklist.qualified, false);
    assert.equal(failedSnapshot.calibration.holdProgressMs, 0);
    assert.equal(failed.advanceTime(700).calibrationChecklist.measuredAt, 650, "idle preserves the failed measurement too");
    assert.equal(failed.processPoseSample(poseWithKnees(750, .5, .5)).calibration.holdProgressMs, 0);
    failed.destroy();
  }

  const reset = createAeroBodyGridService();
  reset.setKneeVisibilityRequired(kneesRequired);
  for (const at of [0, 250, 500]) reset.processPoseSample(poseWithKnees(at), { sourceChangeId: "first" });
  reset.advanceTime(600);
  const changed = reset.processPoseSample(poseWithKnees(750), { sourceChangeId: "second" });
  assert.equal(changed.calibration.holdProgressMs, 0, "source change restarts a preserved hold");
  assert.equal(changed.calibrationChecklist.measuredAt, 750, "new source owns its own measured checklist");
  assert.equal(reset.resetCalibration().calibrationChecklist.measuredAt, null);
  assert.equal(reset.advanceTime(850).calibrationChecklist.measuredAt, null, "idle cannot resurrect a reset checklist");
  assert.equal(reset.getSnapshot().calibration.holdProgressMs, 0);
  reset.destroy();
}

const toggledKnees = createAeroBodyGridService({ calibrationIdPrefix: "toggled-knees" });
toggledKnees.setKneeVisibilityRequired(true);
for (let at = 0; at <= 500; at += 250) toggledKnees.processPoseSample(poseWithKnees(at));
assert.equal(toggledKnees.getSnapshot().calibration.holdProgressMs, 500);
snapshot = toggledKnees.setKneeVisibilityRequired(false);
assert.equal(snapshot.calibration.holdProgressMs, 0, "a knee-mode switch restarts an unfinished T-pose");
assert.equal(snapshot.calibrationChecklist.kneesRequired, false);
assert.equal(snapshot.calibrationChecklist.measuredAt, null);
for (let at = 750; at <= 2750; at += 250) toggledKnees.processPoseSample(pose(at));
assert.equal(toggledKnees.getSnapshot().calibration.calibrationId, "toggled-knees-1", "knee-disabled Boxing/Flow calibrates without knees");

// Wrist/elbow alignment and both elbow angles are independent T-pose gates.
for (const [label, changes] of [
  ["left-wrist-ratio", { left_wrist: { x: 0.8, y: 0.471 } }],
  ["right-wrist-ratio", { right_wrist: { x: 0.2, y: 0.471 } }],
  ["left-elbow-ratio", { left_elbow: { x: 0.7, y: 0.471 } }],
  ["right-elbow-ratio", { right_elbow: { x: 0.3, y: 0.471 } }],
  ["left-elbow-angle", { left_wrist: { x: 0.7, y: 0.3 } }],
  ["right-elbow-angle", { right_wrist: { x: 0.3, y: 0.3 } }]
]) {
  const gate = createAeroBodyGridService({ calibrationIdPrefix: label });
  snapshot = gate.processPoseSample(pose(0, changes));
  assert.equal(snapshot.calibration.state, "uncalibrated", `${label} blocks calibration`);
}

// Malformed/duplicate measurements count as unavailable, never leak invalid public anchors,
// and timestamp/frame rollback cannot rewrite measured history.
const adversarial = createAeroBodyGridService({ calibrationIdPrefix: "adversarial", historyCapacity: 8 });
calibrate(adversarial, 0);
for (let at = 2500; at <= 6250; at += 250) {
  adversarial.processPoseSample(pose(at, releasedChanges));
}
const validBeforeMalformed = adversarial.processPoseSample(pose(6500, releasedChanges));
assert.ok(validBeforeMalformed.anchors.every(isBodyGridAnchorSnapshot));
// One bad frame: the loss clock never latches (hysteresis) and no recovery is triggered
// because the service is not in a loss state.
const singleBad = adversarial.processPoseSample(pose(6625, leftWristLoss));
assert.equal(singleBad.tracking.gameplayPaused, false, "a single dropped sample cannot trip the loss window");
assert.equal(singleBad.tracking.recoveryInProgress, false, "no recovery is in progress for a non-loss dropout");
const afterSingleBad = adversarial.processPoseSample(pose(6640, releasedChanges));
assert.equal(afterSingleBad.tracking.recoveryInProgress, false, "the passing sample does not start a recovery hold outside a loss state");
const nanFrame = pose(6750, { nose: { x: Number.NaN, y: 0.3 } });
snapshot = adversarial.processPoseSample(nanFrame);
assert.equal(snapshot.tracking.allRequiredAnchorsVisible, false);
assert.ok(snapshot.anchors.every(isBodyGridAnchorSnapshot));
const duplicateFrame = pose(6900);
duplicateFrame.landmarks.push({ name: "nose", x: 0.2, y: 0.2, confidence: 0.95 });
snapshot = adversarial.processPoseSample(duplicateFrame);
assert.equal(snapshot.tracking.allRequiredAnchorsVisible, false);
assert.ok(snapshot.anchors.every(isBodyGridAnchorSnapshot));
const recovered = adversarial.processPoseSample(pose(7250, releasedChanges));
const rollback = adversarial.processPoseSample(pose(7100));
assert.equal(rollback, recovered, "timestamp rollback is ignored atomically");
assert.equal(rollback.latestEvidence?.measurementTimestampMs, 7250);
assert.doesNotThrow(() => adversarial.processPoseSample(/** @type {never} */ (null)));
for (let at = 7275; at <= 7750; at += 25) {
  adversarial.processPoseSample(pose(at, releasedChanges));
}
const boundedHistory = adversarial.getEvidenceHistory();
assert.equal(boundedHistory.length, 8);
assert.ok(Object.isFrozen(boundedHistory));
assert.ok(boundedHistory.every(Object.isFrozen));
const routedFrame = createMeasuredPoseRoutingSample(pose(8000, releasedChanges), { routeEpoch: "duplicate-audit" });
const routedSnapshot = adversarial.processPoseSample(routedFrame);
const duplicateRoutedFrame = {
  ...createMeasuredPoseRoutingSample(pose(8250, releasedChanges), { routeEpoch: "duplicate-audit" }),
  measuredSourceFrameId: routedFrame.measuredSourceFrameId
};
assert.equal(adversarial.processPoseSample(duplicateRoutedFrame), routedSnapshot, "duplicate source-frame identity is ignored");
snapshot = adversarial.resetCalibration("audit_reset");
assert.equal(snapshot.anchors.length, 0, "reset removes stale gameplay-valid anchors");
assert.equal(adversarial.getEvidenceHistory().length, 0, "reset clears scoring evidence history");

const noFrameAnchors = createAeroBodyGridService({ calibrationIdPrefix: "no-frame-anchors" });
calibrate(noFrameAnchors, 0);
for (let at = 2500; at <= 6250; at += 250) {
  noFrameAnchors.processPoseSample(pose(at, releasedChanges));
}
assert.ok(noFrameAnchors.getSnapshot().anchors.some((anchor) => anchor.valid));
const noFrameHistoryBefore = noFrameAnchors.getEvidenceHistory().length;
noFrameAnchors.advanceTime(6500);
noFrameAnchors.advanceTime(6750);
snapshot = noFrameAnchors.advanceTime(7000);
assert.equal(snapshot.tracking.anchorsFrozen, true, "three consecutive no-frame ticks latch the freeze window");
assert.equal(snapshot.tracking.gameplayPaused, false, "the freeze does not pause the session");
assert.equal(snapshot.anchors.length, 7, "the no-frame freeze retains the last known anchors");
assert.ok(snapshot.anchors.every((anchor) => anchor.valid), "retained anchors keep their last valid positions");
assert.equal(snapshot.latestEvidence?.provenance, "frozen");
assert.equal(noFrameAnchors.getEvidenceHistory().length, noFrameHistoryBefore, "frozen publications never enter the measured evidence history");
assert.ok(noFrameAnchors.getEvidenceHistory().every((entry) => entry.provenance === "measured"), "the measured evidence history stays measured-only");

let listenerErrors = 0;
let healthyListenerCalls = 0;
const listenerService = createAeroBodyGridService({ onListenerError: () => { listenerErrors += 1; } });
listenerService.subscribe(() => { throw new Error("observer failure"); });
listenerService.subscribe(() => { healthyListenerCalls += 1; });
assert.doesNotThrow(() => listenerService.processPoseSample(pose(0)));
assert.equal(listenerErrors, 2, "immediate and published listener errors are isolated");
assert.equal(healthyListenerCalls, 2, "one bad observer cannot starve later observers");

const isolatedA = createAeroBodyGridService({ calibrationIdPrefix: "isolated-a" });
const isolatedB = createAeroBodyGridService({ calibrationIdPrefix: "isolated-b" });
calibrate(isolatedA, 0);
calibrate(isolatedB, 0);
isolatedA.resetCalibration("instance-a-only");
assert.equal(isolatedA.getSnapshot().tracking.gameplayPaused, true);
assert.equal(isolatedB.getSnapshot().calibration.calibrationId, "isolated-b-1");
isolatedA.destroy();
assert.equal(isolatedA.getSnapshot().calibration.readiness, "destroyed");
assert.notEqual(isolatedB.processPoseSample(pose(4250, releasedChanges)).calibration.readiness, "destroyed", "destroy/reconnect state is per instance");

// Ordinary visible movement cannot bootstrap calibration.
const noBootstrap = createAeroBodyGridService({ calibrationIdPrefix: "none" });
for (let at = 0; at <= 10000; at += 1000) {
  noBootstrap.processPoseSample(pose(at, {
    left_elbow: { x: 0.6, y: 0.6 }, right_elbow: { x: 0.4, y: 0.6 },
    left_wrist: { x: 0.55, y: 0.7 }, right_wrist: { x: 0.45, y: 0.7 }
  }));
}
assert.equal(noBootstrap.getSnapshot().calibration.calibrationId, null);
assert.equal(noBootstrap.getSnapshot().calibration.bounds, null);

let notifications = 0;
const unsubscribe = service.subscribe(() => { notifications += 1; });
unsubscribe();
service.processPoseSample(pose(17000), { sourceAspectRatio: 4 / 3, sourceChangeId: "camera-b" });
assert.equal(notifications, 1, "unsubscribe removes the observer");
service.destroy();
assert.equal(service.getSnapshot().calibration.readiness, "destroyed");
assert.equal(service.getEvidenceHistory().length, 0);

console.log("Calibrated body-grid service validation passed.");
