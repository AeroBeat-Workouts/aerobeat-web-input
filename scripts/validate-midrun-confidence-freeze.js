// @ts-check
// I-1 oracle: calibrated mid-run SUSTAINED confidence drop (required upper-body
// anchor below requiredConfidence, bounds/heldEvidence intact) — does the
// service take the F4 anchor freeze or fall through to full pause?
// This is a diagnostic driver: it drives the scenario and REPORTS the actual
// state values rather than asserting the expected path, so a behavior change
// surfaces in the report instead of failing the suite.

import { createAeroBodyGridService } from "../src/index.js";

const names = ["nose", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist"];

/** @param {number} timestampMs @param {Partial<Record<string, {x: number, y: number, confidence?: number}>>} [changes] */
function pose(timestampMs, changes = {}) {
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
    sourceId: "camera-a",
    timestampMs,
    mirrored: true,
    landmarks: names.map((name) => ({
      name,
      ...base[name],
      ...changes[name],
      confidence: changes[name]?.confidence ?? 0.95
    }))
  };
}

const releasedChanges = {
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
};

function report(label, snapshot) {
  console.log(
    `${label.padEnd(42)}` +
    `anchorsFrozen=${snapshot.tracking.anchorsFrozen}` +
    ` trackingPaused(gameplayPaused)=${snapshot.tracking.gameplayPaused}` +
    ` freshCalibrationRequired=${snapshot.tracking.freshCalibrationRequired}` +
    ` readiness=${snapshot.calibration.readiness}` +
    ` state=${snapshot.calibration.state}` +
    ` calibrationId=${snapshot.calibration.calibrationId}` +
    ` bounds=${snapshot.calibration.bounds === null ? "null" : "set"}` +
    ` latestEvidence=${snapshot.latestEvidence === null ? "null" : snapshot.latestEvidence.provenance}` +
    ` degradedAnchors=[${snapshot.tracking.degradedAnchors.join(",")}]`
  );
}

const service = createAeroBodyGridService({ calibrationIdPrefix: "i1-confidence-freeze" });

// 1) Calibrate (T-pose hold, 2000ms span) and release into calibrated/countdown.
for (let offset = 0; offset <= 2250; offset += 250) {
  service.processPoseSample(pose(offset));
}
for (let at = 2500; at <= 6250; at += 250) {
  service.processPoseSample(pose(at, releasedChanges));
}
let snapshot = service.getSnapshot();
report("PRE-LOSS (calibrated, valid held frame)", snapshot);
const preCalibrationId = snapshot.calibration.calibrationId;
const preBoundsSet = snapshot.calibration.bounds !== null;

// 2) Sustained confidence drop on a REQUIRED (loss-decision) upper-body anchor:
//    right_wrist at 0.2 < requiredConfidence 0.5 (big-swing motion-blur loss).
//    Four consecutive frames, 250ms apart: 6500 -> 7250, spanning 750ms.
//    bounds stays non-null throughout (calibration is untouched by low
//    confidence).
for (const at of [6500, 6750, 7000, 7250]) {
  service.processPoseSample(pose(at, { right_wrist: { x: 0.44, y: 0.55, confidence: 0.2 } }));
  report(`DROP FRAME @ ${at}ms`, service.getSnapshot());
}

// 3) Capture the post-gate state (the loss gate trips on the 4th fail at 7250:
//    3+ consecutive fails latched at 7000, 750ms elapsed at 7250).
snapshot = service.getSnapshot();
const postCalibrationId = snapshot.calibration.calibrationId;
const postBoundsSet = snapshot.calibration.bounds !== null;

console.log("");
console.log("--- I-1 VERDICT DATA ---");
console.log(`pre-LOSS : bounds=${preBoundsSet ? "non-null" : "null"} calibrationId=${preCalibrationId}`);
console.log(`post-LOSS: anchorsFrozen=${snapshot.tracking.anchorsFrozen}`);
console.log(`post-LOSS: trackingPaused(gameplayPaused)=${snapshot.tracking.gameplayPaused}`);
console.log(`post-LOSS: freshCalibrationRequired=${snapshot.tracking.freshCalibrationRequired}`);
console.log(`post-LOSS: readiness=${snapshot.calibration.readiness}`);
console.log(`post-LOSS: calibration.state=${snapshot.calibration.state}`);
console.log(`post-LOSS: calibrationId=${postCalibrationId} (unchanged=${postCalibrationId === preCalibrationId})`);
console.log(`post-LOSS: bounds=${postBoundsSet ? "non-null" : "null"} (unchanged=${postBoundsSet === preBoundsSet})`);
console.log(`post-LOSS: countdownFrozen=${snapshot.countdownFrozen}`);
console.log(`post-LOSS: latestEvidence=${snapshot.latestEvidence === null ? "null" : `${snapshot.latestEvidence.provenance} (frozenTickId=${snapshot.latestEvidence.frozenTickId ?? "n/a"})`}`);

const freezeVerdict =
  snapshot.tracking.anchorsFrozen === true &&
  snapshot.tracking.gameplayPaused === false &&
  snapshot.tracking.freshCalibrationRequired === false &&
  snapshot.calibration.readiness === "countdown" &&
  postCalibrationId === preCalibrationId &&
  postBoundsSet === true;
const pauseVerdict =
  snapshot.tracking.gameplayPaused === true &&
  snapshot.tracking.freshCalibrationRequired === true;

console.log("");
if (freezeVerdict) {
  console.log("VERDICT: FREEZE (F4 works as designed) — calibrated mid-run sustained confidence drop enters the anchor freeze: anchorsFrozen=true, gameplayPaused=false, freshCalibrationRequired=false, readiness=countdown, calibration generation and bounds preserved.");
} else if (pauseVerdict) {
  console.log("VERDICT: FALLS THROUGH TO PAUSE (bug reproduced) — the loss gate took the full pause + fresh-calibration path: gameplayPaused=true, freshCalibrationRequired=true.");
} else {
  console.log("VERDICT: INCONCLUSIVE — observed state matches neither the pure freeze signature (anchorsFrozen=true, gameplayPaused=false, freshCalibrationRequired=false, readiness=countdown, bounds/calibrationId preserved) nor the pure pause signature (gameplayPaused=true, freshCalibrationRequired=true). Inspect the per-frame report above.");
}
