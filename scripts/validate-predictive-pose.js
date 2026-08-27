// @ts-check

import assert from "node:assert/strict";
import {
  aeroGameplayPoseLandmarkNames,
  createMeasuredPoseRoutingSample,
  createPoseInputDraftEvents,
  createPoseInputRouter,
  createPosePredictor,
  evaluateHeldOutPoseTrace
} from "../src/index.js";

/**
 * @param {number} timestampMs
 * @param {number} x
 * @param {{ sourceId?: string, confidence?: number, y?: number, mirrored?: boolean, incomplete?: boolean }} [options]
 * @returns {import("@aerobeat/web-contracts").NormalizedPoseFrame}
 */
function frame(timestampMs, x, options = {}) {
  const names = options.incomplete ? aeroGameplayPoseLandmarkNames.slice(0, -1) : aeroGameplayPoseLandmarkNames;
  return {
    sourceId: options.sourceId ?? "camera",
    timestampMs,
    mirrored: options.mirrored ?? true,
    landmarks: names.map((name, index) => ({
      name,
      x: x + index * 0.001,
      y: (options.y ?? 0.4) + index * 0.001,
      confidence: options.confidence ?? 0.9
    }))
  };
}

/** @param {import("@aerobeat/web-contracts").AeroPoseRoutingSample} sample @param {number} targetTimestampMs */
function predictedFrom(sample, targetTimestampMs) {
  return {
    ...sample,
    provenance: "predicted",
    targetTimestampMs,
    predictionHorizonMs: targetTimestampMs - sample.measurementTimestampMs
  };
}

const legacyFrame = frame(100, 0.2);
const expectedBoxing = [
  {
    schema: "aero.input.draft",
    version: 1,
    mode: "boxing",
    eventName: "aero:input:boxing-intent",
    detail: { name: "straight_left", timestampMs: 100, confidence: 0.9 }
  },
  {
    schema: "aero.input.draft",
    version: 1,
    mode: "boxing",
    eventName: "aero:input:boxing-intent",
    detail: { name: "straight_right", timestampMs: 100, confidence: 0.9 }
  },
  {
    schema: "aero.input.draft",
    version: 1,
    mode: "boxing",
    eventName: "aero:input:boxing-intent",
    detail: { name: "guard_enabled", timestampMs: 100, confidence: 0.9 }
  }
];
const expectedFlow = [
  {
    schema: "aero.input.draft",
    version: 1,
    mode: "flow",
    eventName: "aero:input:flow-intent",
    detail: { kind: "cell_entered", anchor: "left_wrist", column: 0, row: 1, timestampMs: 100, confidence: 0.9 }
  },
  {
    schema: "aero.input.draft",
    version: 1,
    mode: "flow",
    eventName: "aero:input:flow-intent",
    detail: { kind: "cell_entered", anchor: "right_wrist", column: 0, row: 1, timestampMs: 100, confidence: 0.9 }
  },
  {
    schema: "aero.input.draft",
    version: 1,
    mode: "flow",
    eventName: "aero:input:flow-intent",
    detail: { kind: "cell_entered", anchor: "nose", column: 0, row: 1, timestampMs: 100, confidence: 0.9 }
  }
];
assert.deepEqual(createPoseInputDraftEvents(legacyFrame, "boxing"), expectedBoxing);
assert.deepEqual(createPoseInputDraftEvents(legacyFrame, "flow"), expectedFlow);
const legacyRouter = createPoseInputRouter({ mode: "boxing" });
assert.deepEqual(legacyRouter.routePoseFrame(legacyFrame), expectedBoxing);
legacyRouter.setMode("flow");
assert.deepEqual(legacyRouter.routePoseFrame(legacyFrame), expectedFlow);
for (const event of [...expectedBoxing, ...expectedFlow]) {
  assert.equal("provenance" in event.detail, false);
  assert.equal("routeEpoch" in event.detail, false);
}

const measured = createMeasuredPoseRoutingSample(legacyFrame, { routeEpoch: "test-7" });
assert.equal(measured.provenance, "measured");
assert.equal(measured.targetTimestampMs, 100);
assert.equal(measured.measurementTimestampMs, 100);
assert.equal(measured.predictionHorizonMs, 0);
assert.equal(measured.routeEpoch, "test-7");
assert.equal(measured.measuredSourceFrameId, "test-7:camera:100");
const enriched = createPoseInputRouter({ mode: "boxing" }).routePoseSample(measured);
assert.equal(enriched[0].detail.provenance, "measured");
assert.equal(enriched[0].detail.routeEpoch, "test-7");
assert.equal(enriched[0].detail.measuredSourceFrameId, measured.measuredSourceFrameId);

const predictor = createPosePredictor({ routeEpochPrefix: "bounds" });
predictor.pushMeasuredFrame(frame(0, 0.2));
assert.equal(predictor.predict(10), undefined);
assert.equal(predictor.getStatus().insufficientHistorySuppressionCount, 1);
predictor.pushMeasuredFrame(frame(100, 0.3));
assert.equal(predictor.predict(100), undefined);
assert.equal(predictor.getStatus().invalidHorizonSuppressionCount, 1);
const atCap = predictor.predict(225);
assert.ok(atCap);
assert.equal(atCap.predictionHorizonMs, 125);
assert.equal(predictor.predict(225.001), undefined);
assert.equal(predictor.getStatus().staleSuppressionCount, 1);
const predicted = predictor.predict(150);
assert.ok(predicted);
assert.ok(Math.abs(predicted.landmarks[0].x - 0.35) < 1e-9);
assert.ok(predicted.landmarks[0].confidence < 0.9);

const collision = createPosePredictor({ routeEpochPrefix: "collision" });
const beforeReset = collision.pushMeasuredFrame(frame(100, 0.2));
collision.reset("restart");
const afterReset = collision.pushMeasuredFrame(frame(100, 0.2));
assert.notEqual(beforeReset.routeEpoch, afterReset.routeEpoch);
assert.notEqual(beforeReset.measuredSourceFrameId, afterReset.measuredSourceFrameId);
assert.equal(collision.predict(110), undefined);
collision.pushMeasuredFrame(frame(200, 0.3));
assert.ok(collision.predict(210));

const incomplete = createPosePredictor({ routeEpochPrefix: "incomplete" });
incomplete.pushMeasuredFrame(frame(0, 0.2));
incomplete.pushMeasuredFrame(frame(100, 0.3));
incomplete.pushMeasuredFrame(frame(200, 0.4, { incomplete: true }));
assert.equal(incomplete.predict(210), undefined);
incomplete.pushMeasuredFrame(frame(300, 0.5));
assert.equal(incomplete.predict(310), undefined);
incomplete.pushMeasuredFrame(frame(400, 0.6));
assert.ok(incomplete.predict(410));
assert.equal(incomplete.getStatus().incompleteMeasurementCount, 1);

const lowVisibility = createPosePredictor({ routeEpochPrefix: "confidence" });
lowVisibility.pushMeasuredFrame(frame(0, 0.2));
lowVisibility.pushMeasuredFrame(frame(100, 0.3));
lowVisibility.pushMeasuredFrame(frame(200, 0.4, { confidence: 0.2 }));
assert.equal(lowVisibility.predict(210), undefined);
lowVisibility.pushMeasuredFrame(frame(300, 0.5));
assert.equal(lowVisibility.predict(310), undefined);
lowVisibility.pushMeasuredFrame(frame(400, 0.6));
assert.ok(lowVisibility.predict(410));

const sourceReset = createPosePredictor({ routeEpochPrefix: "source" });
sourceReset.pushMeasuredFrame(frame(0, 0.2));
sourceReset.pushMeasuredFrame(frame(100, 0.3));
sourceReset.pushMeasuredFrame(frame(200, 0.4, { sourceId: "other" }));
assert.equal(sourceReset.predict(210), undefined);
sourceReset.pushMeasuredFrame(frame(300, 0.5, { sourceId: "other" }));
assert.ok(sourceReset.predict(310));
assert.equal(sourceReset.getStatus().sourceResetCount, 1);

const timeReset = createPosePredictor({ routeEpochPrefix: "time" });
timeReset.pushMeasuredFrame(frame(0, 0.2));
timeReset.pushMeasuredFrame(frame(100, 0.3));
timeReset.pushMeasuredFrame(frame(90, 0.4));
assert.equal(timeReset.predict(95), undefined);
timeReset.pushMeasuredFrame(frame(190, 0.5));
assert.ok(timeReset.predict(200));
assert.equal(timeReset.getStatus().discontinuityCount, 1);

const reversal = createPosePredictor({ routeEpochPrefix: "reversal" });
reversal.pushMeasuredFrame(frame(0, 0.2));
reversal.pushMeasuredFrame(frame(100, 0.3));
reversal.pushMeasuredFrame(frame(200, 0.2));
assert.equal(reversal.predict(220), undefined);
reversal.pushMeasuredFrame(frame(300, 0.1));
assert.ok(reversal.predict(320));
assert.equal(reversal.getStatus().reversalResetCount, 1);

const corrections = createPosePredictor({ routeEpochPrefix: "corrections" });
corrections.pushMeasuredFrame(frame(0, 0.2));
corrections.pushMeasuredFrame(frame(100, 0.3));
corrections.pushMeasuredFrame(frame(200, 0.4));
assert.ok((corrections.getStatus().correctionMeanError ?? 1) < 1e-9);
const correctionBeforeInvalid = corrections.getStatus().correctionMeanError;
corrections.pushMeasuredFrame(frame(300, 0.5, { sourceId: "invalid-source" }));
assert.equal(corrections.getStatus().correctionMeanError, correctionBeforeInvalid);

const clamped = createPosePredictor({ maxDisplacement: 0.5, routeEpochPrefix: "clamp" });
clamped.pushMeasuredFrame(frame(0, 0.8));
clamped.pushMeasuredFrame(frame(100, 0.95));
const clampedPrediction = clamped.predict(150);
assert.ok(clampedPrediction);
assert.equal(clampedPrediction.landmarks[6].x, 1);
assert.ok(clamped.getStatus().coordinateClampCount > 0);

const lineageRouter = createPoseInputRouter();
const lineageMeasured = createMeasuredPoseRoutingSample(frame(100, 0.2), { routeEpoch: "lineage" });
const lineageEvents = [
  ...lineageRouter.routePoseSampleBatch(lineageMeasured),
  ...lineageRouter.routePoseSampleBatch(predictedFrom(lineageMeasured, 133)),
  ...lineageRouter.routePoseSampleBatch(predictedFrom(lineageMeasured, 166)),
  ...lineageRouter.routePoseSampleBatch(predictedFrom(lineageMeasured, 199))
];
assert.equal(lineageEvents.filter((event) => event.mode === "boxing" && event.detail.name?.startsWith("straight_")).length, 2);
const nextLineage = createMeasuredPoseRoutingSample(frame(225, 0.21), { routeEpoch: "lineage" });
const nextEvents = lineageRouter.routePoseSampleBatch(nextLineage);
assert.equal(nextEvents.filter((event) => event.mode === "boxing" && event.detail.name?.startsWith("straight_")).length, 2);
assert.equal(lineageRouter.getStatus().measuredSampleCount, 2);
assert.equal(lineageRouter.getStatus().predictedSampleCount, 3);

const transitions = createPoseInputRouter();
const guard = createMeasuredPoseRoutingSample(frame(0, 0.2, { y: 0.4 }), { routeEpoch: "states" });
const guardFirst = transitions.routePoseSampleBatch(guard);
assert.equal(guardFirst.filter((event) => event.mode === "boxing" && event.detail.name === "guard_enabled").length, 1);
assert.equal(guardFirst.filter((event) => event.mode === "flow").length, 3);
const sameState = transitions.routePoseSampleBatch(predictedFrom(guard, 20));
assert.equal(sameState.length, 0);
const squat = { ...predictedFrom(guard, 40), landmarks: frame(40, 0.2, { y: 0.6 }).landmarks };
const squatEvents = transitions.routePoseSampleBatch(squat);
assert.equal(squatEvents.filter((event) => event.mode === "boxing" && event.detail.name === "squat_enabled").length, 1);
assert.equal(squatEvents.filter((event) => event.mode === "flow" && event.detail.anchor === "nose").length, 1);
const movedWrist = {
  ...predictedFrom(guard, 60),
  landmarks: guard.landmarks.map((landmark) => landmark.name === "left_wrist" ? { ...landmark, x: 0.8 } : landmark)
};
const movedEvents = transitions.routePoseSampleBatch(movedWrist);
assert.equal(movedEvents.filter((event) => event.mode === "flow" && event.detail.anchor === "left_wrist").length, 1);

const accounting = createPoseInputRouter();
const bothModes = accounting.routePoseSampleBatch(createMeasuredPoseRoutingSample(frame(0, 0.2), { routeEpoch: "batch" }));
assert.equal(bothModes.length, 6);
assert.equal(accounting.getStatus().measuredSampleCount, 1);
assert.equal(accounting.getStatus().emittedEventCount, 6);
accounting.setMode("flow");
assert.equal(accounting.routePoseSample(predictedFrom(createMeasuredPoseRoutingSample(frame(0, 0.2), { routeEpoch: "batch" }), 10)).length, 0);
accounting.setMode("boxing");
assert.equal(accounting.routePoseSample(createMeasuredPoseRoutingSample(frame(125, 0.2), { routeEpoch: "batch" })).filter((event) => event.detail.name?.startsWith("straight_")).length, 2);

const reentry = createPoseInputRouter();
const visible = createMeasuredPoseRoutingSample(frame(0, 0.2), { routeEpoch: "reentry" });
reentry.routePoseSampleBatch(visible);
const hidden = { ...predictedFrom(visible, 10), landmarks: frame(10, 0.2, { confidence: 0.1 }).landmarks };
assert.equal(reentry.routePoseSampleBatch(hidden).length, 0);
const reentered = reentry.routePoseSampleBatch(predictedFrom(visible, 20));
assert.equal(reentered.filter((event) => event.mode === "boxing" && event.detail.name === "guard_enabled").length, 1);
assert.equal(reentered.filter((event) => event.mode === "flow").length, 3);
assert.equal(reentered.filter((event) => event.mode === "boxing" && event.detail.name?.startsWith("straight_")).length, 0);

const trace = Array.from({ length: 21 }, (_, index) => frame(index * 25, 0.2 + index * 0.005));
const oracle = evaluateHeldOutPoseTrace(trace);
assert.equal(oracle.referenceFrameCount, 21);
assert.equal(oracle.measuredFrameCount, 5);
assert.equal(oracle.heldOutFrameCount, 16);
assert.equal(oracle.heldOutPredictionCount, 12);
assert.equal(oracle.treatmentPredictionCoverage, 0.75);
assert.ok((oracle.control.landmarkErrorMean ?? 0) > (oracle.treatment.landmarkErrorMean ?? 1));
assert.ok((oracle.treatmentMinusControl.landmarkMeanErrorReductionRatio ?? 0) > 0.7);
assert.ok((oracle.treatmentMinusControl.bodyGridCellAgreement ?? 0) > 0);
assert.ok((oracle.treatmentMinusControl.intentRecall ?? 0) > 0);
assert.ok((oracle.treatmentMinusControl.intentF1 ?? 0) >= oracle.thresholds.minimumIntentF1Delta);
assert.equal(oracle.control.falseRepeatedEventCount, 0);
assert.equal(oracle.treatment.falseRepeatedEventCount, 0);
assert.equal(oracle.treatment.emittedEventCount, oracle.control.emittedEventCount, "improvement must not come from emitting fewer events");
assert.equal(oracle.predictionImprovesControl, true);
assert.equal(oracle.recommendation, "prediction-improves-control");
assert.equal(oracle.normalizedMeanJointError, oracle.treatment.landmarkErrorMean, "legacy aliases must remain treatment metrics");

const occludedTrace = [
  frame(0, 0.2),
  frame(125, 0.3, { confidence: 0.1 }),
  frame(150, 0.32),
  frame(250, 0.4),
  frame(375, 0.5)
];
const occludedOracle = evaluateHeldOutPoseTrace(occludedTrace);
assert.ok(occludedOracle.suppressedPredictionCount > 0);
assert.ok((occludedOracle.treatmentPredictionCoverage ?? 1) < occludedOracle.thresholds.minimumTreatmentPredictionCoverage);
assert.equal(occludedOracle.predictionImprovesControl, false);
assert.equal(occludedOracle.recommendation, "prediction-does-not-improve-control");
assert.equal(occludedOracle.treatment.falseRepeatedEventCount, 0);

console.log("Predictive pose routing validation passed.");
