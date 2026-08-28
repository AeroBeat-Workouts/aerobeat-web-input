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
  for (const offset of [0, 1000, 2000, 3000, 4000]) {
    service.processPoseSample(pose(start + offset), context);
  }
  return service.getSnapshot();
}

const service = createAeroBodyGridService({ calibrationIdPrefix: "test" });
let snapshot = service.getSnapshot();
assert.equal(snapshot.calibration.state, "uncalibrated");
assert.equal(snapshot.calibration.bounds, null, "there is no silent bootstrap geometry");
assert.ok(Object.isFrozen(snapshot));
assert.ok(Object.isFrozen(snapshot.calibration));

snapshot = service.processPoseSample(pose(0));
assert.equal(snapshot.calibration.state, "holding");
assert.equal(snapshot.calibration.holdProgressMs, 0);
service.processPoseSample(pose(1000));
assert.equal(service.getSnapshot().calibration.holdProgressMs, 1000);
service.processPoseSample(pose(2000, { left_wrist: { x: 0.8, y: 0.55 } }));
assert.equal(service.getSnapshot().calibration.state, "uncalibrated", "a failed gate resets the hold window");
assert.equal(service.getSnapshot().calibration.holdProgressMs, 0);

snapshot = calibrate(service, 3000);
assert.equal(snapshot.calibration.state, "cooldown");
assert.equal(snapshot.calibration.readiness, "countdown");
assert.equal(snapshot.calibration.calibrationId, "test-1");
assert.equal(snapshot.calibration.releaseRequired, true);
assert.equal(snapshot.calibration.cooldownRemainingMs, 4000);
assert.ok(isCalibrationSnapshot(snapshot.calibration));
assert.ok(isTrackingSafetySnapshot(snapshot.tracking));
const bounds = snapshot.calibration.bounds;
assert.ok(bounds);
assert.ok(Math.abs(bounds.left - 0.2) < 1e-9);
assert.ok(Math.abs(bounds.right - 0.8) < 1e-9);
assert.ok(Math.abs(bounds.top - 0) < 1e-9);
assert.ok(Math.abs(bounds.bottom - 0.8) < 1e-9, "16:9 source aspect produces square-pixel 4x3 geometry");

const released = pose(7100, {
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
});
snapshot = service.processPoseSample(released);
assert.equal(snapshot.calibration.releaseRequired, false);
snapshot = service.processPoseSample(pose(11001, {
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
}));
assert.equal(snapshot.calibration.state, "calibrated");
assert.equal(snapshot.anchors.length, 7);
assert.ok(snapshot.anchors.every(isBodyGridAnchorSnapshot));
assert.ok(snapshot.latestEvidence && isGameplayEvidenceSnapshot(snapshot.latestEvidence));

// Camera-preview x is opposed exactly once: camera x=.8 maps to athlete x=.2.
const cornerFrame = pose(11100, {
  nose: { x: 0.8, y: 0 },
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
});
snapshot = service.processPoseSample(cornerFrame);
const noseCorner = snapshot.anchors.find((anchor) => anchor.anchor === "nose");
assert.equal(noseCorner?.cell, 0);
assert.equal(noseCorner?.subcell, 0);
assert.ok(Math.abs(noseCorner?.x ?? 1) < 1e-12);
assert.ok(Math.abs(noseCorner?.y ?? 1) < 1e-12);

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

// A boundary jitter remains in the old cell until the configured hysteresis is crossed.
const beforeJitter = snapshot.anchors.find((anchor) => anchor.anchor === "nose")?.cell;
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
assert.equal(service.getFreshEvidence(11850), snapshot.latestEvidence);
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

// 500ms sustained seven-anchor loss pauses, dims retained geometry, clears evidence and freezes countdown.
service.processPoseSample(pose(12000, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
snapshot = service.processPoseSample(pose(12500, { right_wrist: { x: 0.46, y: 0.58, confidence: 0.2 } }));
assert.equal(snapshot.tracking.gameplayPaused, true);
assert.equal(snapshot.tracking.freshCalibrationRequired, true);
assert.equal(snapshot.calibration.state, "tracking_lost");
assert.equal(snapshot.latestEvidence, null);
assert.equal(snapshot.retainedGeometryDimmed, true);
assert.equal(snapshot.countdownFrozen, true);

snapshot = calibrate(service, 12600);
assert.equal(snapshot.calibration.calibrationId, "test-2");
assert.equal(snapshot.tracking.gameplayPaused, false);
assert.equal(snapshot.tracking.freshCalibrationRequired, false);
assert.equal(snapshot.calibration.readiness, "countdown");

// Source, mirror, and source-aspect identity changes each invalidate scoring without applying a second x flip.
snapshot = service.processPoseSample(pose(16700), { sourceAspectRatio: 4 / 3, sourceChangeId: "camera-b" });
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

// Explicit reset remains paused and keeps old geometry only for dim display.
snapshot = service.resetCalibration("badge_reset");
assert.equal(snapshot.tracking.gameplayPaused, true);
assert.equal(snapshot.calibration.invalidationReason, "badge_reset");
assert.ok(snapshot.calibration.bounds);

// No-frame timeout uses the last real measurement and does not invent evidence.
const timeoutService = createAeroBodyGridService({ calibrationIdPrefix: "timeout" });
calibrate(timeoutService, 0);
timeoutService.processPoseSample(released);
snapshot = timeoutService.advanceTime(7600);
assert.equal(snapshot.tracking.gameplayPaused, true);
assert.equal(snapshot.latestEvidence, null);

const averagedService = createAeroBodyGridService({ calibrationIdPrefix: "average" });
for (const [index, leftX] of [0.75, 0.775, 0.8, 0.825, 0.85].entries()) {
  averagedService.processPoseSample(pose(index * 1000, {
    left_wrist: { x: leftX, y: 0.4 },
    right_wrist: { x: 1 - leftX, y: 0.4 }
  }));
}
const averagedBounds = averagedService.getSnapshot().calibration.bounds;
assert.ok(averagedBounds);
assert.ok(Math.abs(averagedBounds.left - 0.2) < 1e-9);
assert.ok(Math.abs(averagedBounds.right - 0.8) < 1e-9, "geometry uses the complete qualified hold-window average");

// Padding/aspect are measured in source pixels: width and height grow independently.
const padded = createAeroBodyGridService({ calibrationIdPrefix: "padded", sourceAspectRatio: 1, padding: { left: 0.1, right: 0.1, top: 0.2, bottom: 0.2 } });
snapshot = calibrate(padded, 0, { sourceAspectRatio: 1 });
const paddedBounds = snapshot.calibration.bounds;
assert.ok(paddedBounds);
assert.ok(Math.abs((paddedBounds.right - paddedBounds.left) - 0.72) < 1e-9);
assert.ok(Math.abs((paddedBounds.bottom - paddedBounds.top) - 0.63) < 1e-9);

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
