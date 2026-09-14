// @ts-check

import assert from "node:assert/strict";
import {
  createAeroBodyGridService,
  createMeasuredPoseRoutingSample
} from "../src/index.js";

const privateParallaxSymbol = Symbol.for("aerobeat.web-input.internal-measured-nose-parallax");
const names = ["nose", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist"];
const releasedChanges = {
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
};

/** @param {number} timestampMs @param {Partial<Record<string, {x?: number, y?: number, confidence?: number}>>} [changes] @param {{sourceId?: string, mirrored?: boolean}} [options] */
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

/** @param {ReturnType<typeof createAeroBodyGridService>} service */
function privateReader(service) {
  return /** @type {(() => Readonly<{calibrationId: string, sourceIdentity: string, measurementTimestampMs: number, measuredSourceFrameId: string, xDeflection: number, yDeflection: number} | null>) | undefined} */ (service[privateParallaxSymbol]);
}

/** @param {ReturnType<typeof createAeroBodyGridService>} service @param {Partial<Record<string, {x?: number, y?: number, confidence?: number}>>} [calibrationChanges] @param {{sourceAspectRatio?: number, sourceChangeId?: string}} [context] */
function calibrate(service, calibrationChanges = {}, context = {}) {
  for (let offset = 0; offset <= 2000; offset += 250) {
    service.processPoseSample(pose(offset, calibrationChanges), context);
  }
  for (let at = 2250; at <= 8250; at += 250) {
    service.processPoseSample(pose(at, { ...releasedChanges, nose: calibrationChanges.nose ?? {} }), context);
  }
}

/** Default calibration camera coordinates for an athlete-grid normalized point. */
function cameraForRaw(x, y) {
  return { x: 1 - (0.2 + x * 0.6), y: y * 0.8 };
}

/** @param {number} actual @param {number} expected @param {string} message */
function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

const lifecycle = createAeroBodyGridService({ calibrationIdPrefix: "private-lifecycle" });
assert.equal(privateReader(lifecycle), undefined, "private capability is absent before a measured source connects");
assert.equal(Object.keys(lifecycle).includes(String(privateParallaxSymbol)), false);
assert.equal(JSON.stringify(lifecycle).includes("parallax"), false);
lifecycle.processPoseSample(pose(0));
const lifecycleReader = privateReader(lifecycle);
assert.equal(typeof lifecycleReader, "function", "a measured source connection installs the private capability");
assert.equal(lifecycleReader?.(), null, "uncalibrated input fails closed");
const descriptor = Object.getOwnPropertyDescriptor(lifecycle, privateParallaxSymbol);
assert.deepEqual(
  { enumerable: descriptor?.enumerable, configurable: descriptor?.configurable, setter: descriptor?.set },
  { enumerable: false, configurable: false, setter: undefined },
  "private capability is non-enumerable and immutable"
);
lifecycle.destroy();
assert.equal(privateReader(lifecycle), undefined, "destroy removes access to the private capability");
assert.equal(lifecycleReader?.(), null, "a retained lifecycle capability fails closed after destroy");

const service = createAeroBodyGridService({ calibrationIdPrefix: "private-default" });
calibrate(service);
const read = privateReader(service);
assert.equal(typeof read, "function");
let sample = read?.();
assert.ok(sample);
close(sample.xDeflection, 0, "calibration baseline is neutral on X");
close(sample.yDeflection, 0, "calibration baseline is neutral on Y");
assert.ok(Object.isFrozen(sample));
assert.deepEqual(Object.keys(sample), ["calibrationId", "sourceIdentity", "measurementTimestampMs", "measuredSourceFrameId", "xDeflection", "yDeflection"]);

for (const [timestampMs, rawX, rawY, expectedX, expectedY, label] of [
  [8500, 0.75, 0.375, 0.5, 0, "+X"],
  [8525, 0.25, 0.375, -0.5, 0, "-X"],
  [8550, 0.5, 0.6875, 0, 0.5, "+Y"],
  [8575, 0.5, 0.1875, 0, -0.5, "-Y"],
  [8600, 0.999999, 0.999999, 0.999998, 0.9999984, "+X/+Y corner"],
  [8625, 0.000001, 0.000001, -0.999998, -0.9999973333333333, "-X/-Y corner"]
]) {
  service.processPoseSample(pose(timestampMs, { ...releasedChanges, nose: cameraForRaw(rawX, rawY) }));
  sample = read?.();
  assert.ok(sample, `${label} produces a measured sample`);
  close(sample.xDeflection, expectedX, `${label} X deflection`);
  close(sample.yDeflection, expectedY, `${label} Y deflection`);
  assert.equal(sample.measurementTimestampMs, timestampMs);
  assert.ok(Number.isFinite(sample.xDeflection) && sample.xDeflection >= -1 && sample.xDeflection <= 1);
  assert.ok(Number.isFinite(sample.yDeflection) && sample.yDeflection >= -1 && sample.yDeflection <= 1);
}

const asymmetric = createAeroBodyGridService({ calibrationIdPrefix: "private-asymmetric" });
calibrate(asymmetric, { nose: cameraForRaw(0.25, 0.25) });
const readAsymmetric = privateReader(asymmetric);
for (const [timestampMs, rawX, rawY, expectedX, expectedY] of [
  [8500, 0.625, 0.625, 0.5, 0.5],
  [8525, 0.125, 0.125, -0.5, -0.5]
]) {
  asymmetric.processPoseSample(pose(timestampMs, { ...releasedChanges, nose: cameraForRaw(rawX, rawY) }));
  const asymmetricSample = readAsymmetric?.();
  assert.ok(asymmetricSample);
  close(asymmetricSample.xDeflection, expectedX, "directional X headroom is baseline-to-selected-edge");
  close(asymmetricSample.yDeflection, expectedY, "directional Y headroom is baseline-to-selected-edge");
}

const averaged = createAeroBodyGridService({ calibrationIdPrefix: "private-average" });
for (let index = 0; index <= 8; index += 1) {
  const raw = index % 2 === 0 ? 0.25 : 0.75;
  averaged.processPoseSample(pose(index * 250, { nose: cameraForRaw(raw, raw) }));
}
for (let at = 2250; at <= 8250; at += 250) {
  averaged.processPoseSample(pose(at, { ...releasedChanges, nose: cameraForRaw(17 / 36, 17 / 36) }));
}
const averagedSample = privateReader(averaged)?.();
assert.ok(averagedSample);
close(averagedSample.xDeflection, 0, "neutral uses the complete hold-window averaged nose baseline X");
close(averagedSample.yDeflection, 0, "neutral uses the complete hold-window averaged nose baseline Y");

for (const [axis, nose] of [["x", cameraForRaw(0, 0.5)], ["y", cameraForRaw(0.5, 0)]]) {
  const noHeadroom = createAeroBodyGridService({ calibrationIdPrefix: `private-no-headroom-${axis}` });
  calibrate(noHeadroom, { nose });
  assert.equal(privateReader(noHeadroom)?.(), null, `${axis} baseline without bidirectional headroom fails closed`);
}

const invalid = createAeroBodyGridService({ calibrationIdPrefix: "private-invalid" });
calibrate(invalid);
const readInvalid = privateReader(invalid);
assert.ok(readInvalid?.());
invalid.processPoseSample(pose(8500, { ...releasedChanges, nose: { x: Number.NaN } }));
assert.equal(readInvalid?.(), null, "non-finite nose resets the private sample");
invalid.processPoseSample(pose(8525, releasedChanges));
assert.ok(readInvalid?.());
invalid.processPoseSample(pose(8550, { ...releasedChanges, nose: { confidence: 0.49 } }));
assert.equal(readInvalid?.(), null, "hidden nose resets the private sample");
invalid.processPoseSample(pose(8575, releasedChanges));
assert.ok(readInvalid?.());
invalid.processPoseSample(pose(8600, { ...releasedChanges, left_shoulder: { confidence: 0.49 } }));
assert.equal(readInvalid?.(), null, "any hidden required anchor resets the private sample");
invalid.processPoseSample(pose(8625, releasedChanges));
assert.ok(readInvalid?.());
invalid.processPoseSample(pose(8650, { ...releasedChanges, nose: { x: 0.1 } }));
assert.equal(readInvalid?.(), null, "out-of-calibration-grid nose resets the private sample");
invalid.processPoseSample(pose(8675, releasedChanges));
const beforePrediction = readInvalid?.();
assert.ok(beforePrediction);
invalid.processPoseSample({
  ...createMeasuredPoseRoutingSample(pose(8700, { ...releasedChanges, nose: cameraForRaw(0.9, 0.9) }), { routeEpoch: "private-predicted" }),
  provenance: "predicted",
  targetTimestampMs: 8750,
  predictionHorizonMs: 75
});
assert.equal(readInvalid?.(), beforePrediction, "prediction cannot replace or extrapolate the measured sample");
invalid.advanceTime(8700);
assert.equal(readInvalid?.(), null, "no-frame advancement resets rather than freezing a sample");

const duplicate = createAeroBodyGridService({ calibrationIdPrefix: "private-duplicate" });
calibrate(duplicate);
const readDuplicate = privateReader(duplicate);
duplicate.processPoseSample(pose(8500, releasedChanges));
assert.ok(readDuplicate?.());
duplicate.processPoseSample(pose(8500, { ...releasedChanges, nose: cameraForRaw(0.9, 0.9) }));
assert.equal(readDuplicate?.(), null, "duplicate timestamp fails closed");
duplicate.processPoseSample(pose(8525, releasedChanges));
assert.ok(readDuplicate?.());
duplicate.processPoseSample(pose(8510, releasedChanges));
assert.equal(readDuplicate?.(), null, "timestamp rollback fails closed");
const routed = createMeasuredPoseRoutingSample(pose(8550, releasedChanges), { routeEpoch: "private-frame" });
duplicate.processPoseSample(routed);
assert.ok(readDuplicate?.());
duplicate.processPoseSample({
  ...createMeasuredPoseRoutingSample(pose(8575, releasedChanges), { routeEpoch: "private-frame" }),
  measuredSourceFrameId: routed.measuredSourceFrameId
});
assert.equal(readDuplicate?.(), null, "duplicate measured-frame identity fails closed");

for (const kind of ["source", "mirror", "aspect"]) {
  const identity = createAeroBodyGridService({ calibrationIdPrefix: `private-${kind}` });
  calibrate(identity);
  const identityReader = privateReader(identity);
  assert.ok(identityReader?.());
  const changedPose = kind === "source"
    ? pose(8500, releasedChanges, { sourceId: "camera-b" })
    : pose(8500, releasedChanges, { mirrored: false });
  identity.processPoseSample(changedPose, kind === "aspect" ? { sourceAspectRatio: 4 / 3 } : {});
  assert.equal(identityReader?.(), null, `${kind} identity change resets the private sample`);
  assert.equal(identity.getSnapshot().calibration.invalidationReason, "source_changed");
}

const reset = createAeroBodyGridService({ calibrationIdPrefix: "private-reset" });
calibrate(reset);
const resetReader = privateReader(reset);
assert.ok(resetReader?.());
reset.resetCalibration("private-test-reset");
assert.equal(resetReader?.(), null, "calibration reset clears private sample and identity validity");

const instanceA = createAeroBodyGridService({ calibrationIdPrefix: "private-instance-a" });
const instanceB = createAeroBodyGridService({ calibrationIdPrefix: "private-instance-b" });
calibrate(instanceA);
calibrate(instanceB);
const sampleA = privateReader(instanceA)?.();
const sampleB = privateReader(instanceB)?.();
assert.ok(sampleA && sampleB);
assert.notEqual(sampleA.calibrationId, sampleB.calibrationId);
instanceA.processPoseSample(pose(8500, { ...releasedChanges, nose: cameraForRaw(0.75, 0.375) }));
close(privateReader(instanceA)?.()?.xDeflection ?? Number.NaN, 0.5, "instance A moves independently");
close(privateReader(instanceB)?.()?.xDeflection ?? Number.NaN, 0, "instance B remains neutral");
instanceA.destroy();
assert.equal(privateReader(instanceA), undefined);
assert.ok(privateReader(instanceB)?.());
const reconnected = createAeroBodyGridService({ calibrationIdPrefix: "private-instance-a-reconnect" });
assert.equal(privateReader(reconnected), undefined, "a replacement instance starts disconnected and empty");
reconnected.processPoseSample(pose(0));
assert.equal(typeof privateReader(reconnected), "function");
assert.equal(privateReader(reconnected)?.(), null, "reconnect cannot retain prior calibration/sample state");

const publicSnapshotJson = JSON.stringify(instanceB.getSnapshot());
const serviceJson = JSON.stringify(instanceB);
for (const forbidden of ["xDeflection", "yDeflection", "internal-measured-nose-parallax", "private-instance-a"]) {
  assert.equal(publicSnapshotJson.includes(forbidden), false, `public snapshot excludes private ${forbidden}`);
  assert.equal(serviceJson.includes(forbidden), false, `service serialization excludes private ${forbidden}`);
}
assert.equal(Object.keys(instanceB).some((key) => /nose|parallax|baseline|bounds|frame/iu.test(key)), false);
assert.equal(Object.keys(instanceB.getSnapshot()).some((key) => /parallax|deflection/iu.test(key)), false);
assert.equal(JSON.stringify(instanceB.getEvidenceHistory()).includes("Deflection"), false);

console.log("Private measured-nose parallax validation passed.");
