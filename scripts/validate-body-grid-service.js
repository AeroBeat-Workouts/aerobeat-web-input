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
assert.equal(outsideNose?.valid, false);
assert.equal(outsideNose?.cell, null);
assert.ok((outsideNose?.rawX ?? 0) > 1, "unclamped diagnostics survive out-of-grid invalidity");

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
assert.ok(snapshot.latestEvidence?.activeBoxingActions.includes("crossed_guard"));
assert.ok(snapshot.latestEvidence?.activeBoxingActions.includes("weave_left"));

// 750ms sustained three-anchor loss (3+ consecutive fails latch the window) pauses,
// dims retained geometry, clears evidence and freezes countdown.
service.processPoseSample(pose(12000, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
snapshot = service.processPoseSample(pose(12250, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(snapshot.tracking.gameplayPaused, false, "one failed sample never latches the loss window");
snapshot = service.processPoseSample(pose(12500, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
snapshot = service.processPoseSample(pose(12750, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(snapshot.tracking.gameplayPaused, true);
assert.equal(snapshot.tracking.freshCalibrationRequired, true);
assert.equal(snapshot.calibration.state, "tracking_lost");
assert.equal(snapshot.latestEvidence, null);
assert.equal(snapshot.retainedGeometryDimmed, true);
assert.equal(snapshot.countdownFrozen, true);

// Partial auto-recovery: the three loss-decision anchors visible and stable for
// 300ms of measured time clear freshCalibrationRequired WITHOUT recalibrating.
const beforeRecovery = JSON.stringify(service.getSnapshot().calibration.bounds);
const beforeRecoveryId = service.getSnapshot().calibration.calibrationId;
service.processPoseSample(pose(13000, releasedChanges));
const duringRecovery = service.getSnapshot();
assert.equal(duringRecovery.tracking.gameplayPaused, true, "the session stays paused while the recovery hold accumulates");
assert.equal(duringRecovery.tracking.freshCalibrationRequired, true, "the recovery hold has not yet reached 300ms");
assert.equal(duringRecovery.tracking.recoveryInProgress, true, "recovery-in-progress is exposed semantically");
service.processPoseSample(pose(13300, releasedChanges));
const partialRecovered = service.getSnapshot();
assert.equal(partialRecovered.calibration.calibrationId, beforeRecoveryId, "recovery does not mint a new calibrationId");
assert.equal(JSON.stringify(partialRecovered.calibration.bounds), beforeRecovery, "recovery keeps bounds byte-identical");
assert.equal(partialRecovered.tracking.gameplayPaused, false);
assert.equal(partialRecovered.tracking.freshCalibrationRequired, false);
assert.equal(partialRecovered.tracking.recoveryInProgress, false);
assert.equal(partialRecovered.calibration.readiness, "countdown");
assert.equal(partialRecovered.calibration.state, "calibrated");
assert.ok(partialRecovered.latestEvidence, "evidence resumes immediately after partial recovery");

// (e) A recovery hold interrupted by one bad sample restarts from zero.
const interruptService = createAeroBodyGridService({ calibrationIdPrefix: "interrupt" });
calibrate(interruptService, 0);
for (let at = 2500; at <= 6250; at += 250) {
  interruptService.processPoseSample(pose(at, releasedChanges));
}
// Three consecutive fails latch and pause.
interruptService.processPoseSample(pose(6500, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
interruptService.processPoseSample(pose(6750, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
interruptService.processPoseSample(pose(7000, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
interruptService.processPoseSample(pose(7250, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(interruptService.getSnapshot().tracking.gameplayPaused, true);
// Recovery starts at 7500.
interruptService.processPoseSample(pose(7500, releasedChanges));
assert.equal(interruptService.getSnapshot().tracking.recoveryInProgress, true, "recovery hold starts on the first good sample");
// Interrupt at 7600.
interruptService.processPoseSample(pose(7600, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(interruptService.getSnapshot().tracking.recoveryInProgress, false, "one bad sample interrupts the recovery hold");
// Recovery restarts at 7700.
interruptService.processPoseSample(pose(7700, releasedChanges));
assert.equal(interruptService.getSnapshot().tracking.recoveryInProgress, true, "the restarted hold counts from the new start");
// The restarted hold needs a full 300ms: 7700→8000 is 300ms.
interruptService.processPoseSample(pose(7999, releasedChanges));
assert.equal(interruptService.getSnapshot().tracking.freshCalibrationRequired, true, "the restarted hold has not yet reached 300ms");
interruptService.processPoseSample(pose(8000, releasedChanges));
assert.equal(interruptService.getSnapshot().tracking.freshCalibrationRequired, false, "the restarted 300ms hold still clears the requirement");

// Full T-pose calibration remains available and is the invalidation path for source changes.
for (let at = 13500; at <= 14250; at += 250) {
  service.processPoseSample(pose(at, releasedChanges));
}
snapshot = calibrate(service, 14500);
assert.equal(snapshot.calibration.calibrationId, "test-2");
assert.equal(snapshot.tracking.gameplayPaused, false);
assert.equal(snapshot.tracking.freshCalibrationRequired, false);
assert.equal(snapshot.calibration.readiness, "countdown");

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
const gapSilent = createAeroBodyGridService({ calibrationIdPrefix: "gap-silent" });
calibrate(gapSilent, 0);
for (let at = 2500; at <= 6250; at += 250) {
  gapSilent.processPoseSample(pose(at, releasedChanges));
}
assert.equal(gapSilent.advanceTime(7250).tracking.gameplayPaused, false, "one pre-latch missed tick cannot trip the loss window");
assert.equal(gapSilent.advanceTime(7500).tracking.gameplayPaused, false, "two pre-latch missed ticks still cannot trip the loss window");
assert.equal(gapSilent.advanceTime(7750).tracking.gameplayPaused, true, "three consecutive missed ticks latch and hold 750ms of measured loss");
assert.equal(gapSilent.getSnapshot().latestEvidence, null);

const explicitReset = createAeroBodyGridService({ calibrationIdPrefix: "explicit-reset" });
calibrate(explicitReset, 0);
for (let at = 2500; at <= 6250; at += 250) {
  explicitReset.processPoseSample(pose(at, releasedChanges));
}
snapshot = explicitReset.resetCalibration("badge_reset");
assert.equal(snapshot.tracking.gameplayPaused, true);
assert.equal(snapshot.calibration.invalidationReason, "badge_reset");
assert.ok(snapshot.calibration.bounds);

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
assert.equal(timeoutService.advanceTime(6750).tracking.gameplayPaused, false, "a second missed tick still cannot trip the loss window");
snapshot = timeoutService.advanceTime(7000);
assert.equal(snapshot.tracking.gameplayPaused, true, "three consecutive no-frame misses latch and hold 750ms of measured loss");
assert.equal(snapshot.latestEvidence, null);

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
assert.equal(refire.getSnapshot().calibration.calibrationId, "refire-2", "release plus a fresh exact hold refires");

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
noFrameAnchors.advanceTime(6500);
noFrameAnchors.advanceTime(6750);
snapshot = noFrameAnchors.advanceTime(7000);
assert.equal(snapshot.tracking.gameplayPaused, true, "three consecutive no-frame ticks latch the loss window");
assert.equal(snapshot.anchors.length, 0, "no-frame pause removes stale gameplay-valid anchors");
assert.equal(noFrameAnchors.getEvidenceHistory().length, 0);

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
