// @ts-check

import assert from "node:assert/strict";
import { isBodyGridCellEntry } from "@aerobeat/web-contracts";
import { createAeroGameplaySessionCoordinator } from "../../aerobeat-web-gameplay/src/index.js";
import { createAeroBodyGridService } from "../src/index.js";

const names = ["nose", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist"];
const released = {
  left_elbow: { x: 0.61, y: 0.52 },
  right_elbow: { x: 0.39, y: 0.52 },
  left_wrist: { x: 0.56, y: 0.55 },
  right_wrist: { x: 0.44, y: 0.55 }
};
const center = { x: 0.375, y: 0.5 };
const shoulder = { x: 0.5, y: 0.5 };

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
    sourceId: options.sourceId ?? "eight-way-camera",
    timestampMs,
    mirrored: options.mirrored ?? true,
    landmarks: names.map((name) => ({ name, ...base[name], ...changes[name], confidence: changes[name]?.confidence ?? 0.95 }))
  };
}

/** Convert calibrated raw grid coordinates back to camera-preview coordinates. @param {{x:number,y:number}} raw */
function cameraPoint(raw) {
  return { x: 1 - (0.2 + raw.x * 0.6), y: raw.y * 0.8 };
}

/** @param {ReturnType<typeof createAeroBodyGridService>} service */
function ready(service) {
  for (let at = 0; at <= 4000; at += 250) service.processPoseSample(pose(at));
  for (let at = 4250; at <= 8250; at += 250) service.processPoseSample(pose(at, released));
  assert.equal(service.getSnapshot().calibration.state, "calibrated");
}

/** @param {{left?:{wrist:{x:number,y:number},shoulder?:{x:number,y:number}},right?:{wrist:{x:number,y:number},shoulder?:{x:number,y:number}}}} hands */
function handChanges(hands) {
  const changes = { ...released };
  for (const hand of /** @type {const} */ (["left", "right"])) {
    const state = hands[hand];
    if (!state) continue;
    changes[`${hand}_shoulder`] = cameraPoint(state.shoulder ?? shoulder);
    changes[`${hand}_wrist`] = cameraPoint(state.wrist);
  }
  return changes;
}

/** @param {{x:number,y:number}} from @param {{x:number,y:number}} to @param {number} ratio */
function interpolate(from, to, ratio) {
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

/** @param {{x:number,y:number}} target @param {readonly number[]} cadence @param {Partial<Parameters<typeof createAeroBodyGridService>[0]>} [options] */
function runLeftTransition(target, cadence, options = {}) {
  const service = createAeroBodyGridService({ calibrationIdPrefix: "direction", ...options });
  ready(service);
  let at = 8500;
  for (const offset of [-80, -40, 0]) service.processPoseSample(pose(at + offset, handChanges({ left: { wrist: center } })));
  /** @type {import("@aerobeat/web-contracts").AeroBodyGridCellEntry[]} */
  const entries = [];
  for (let index = 0; index < cadence.length; index += 1) {
    const ratio = (index + 1) / cadence.length;
    const snapshot = service.processPoseSample(pose(at + cadence[index], handChanges({ left: { wrist: interpolate(center, target, ratio) } })));
    entries.push(...snapshot.entries.filter((entry) => entry.anchor === "left_wrist"));
  }
  service.destroy();
  return entries;
}

const gameplayHash = "a".repeat(64);
const flowVariant = Object.freeze({
  variantId: "variant",
  chartId: "chart-variant",
  mode: "flow",
  rulesetId: "flow_grid_v2",
  recipeId: null,
  modifierIds: Object.freeze([]),
  ranked: false,
  mapHash: Object.freeze({ schema: "aerobeat/content_hash", version: 1, algorithm: "sha256", value: gameplayHash }),
  scoreIdentityHash: Object.freeze({ schema: "aerobeat/content_hash", version: 1, algorithm: "sha256", value: gameplayHash }),
  provenance: Object.freeze({ baseVariantId: "variant" })
});

/** @param {string} eventId @param {number | undefined} direction */
function flowEvent(eventId, direction) {
  return Object.freeze({
    schema: "aerobeat/resolved_content_event",
    version: 3,
    eventId,
    variantId: "variant",
    chartId: "chart-variant",
    centerTimestampMs: 500,
    sourceEventIds: Object.freeze([`source-${eventId}`]),
    type: "note",
    hand: "left",
    placement: 6,
    ...(direction === undefined ? {} : { direction })
  });
}

/** @param {ReturnType<typeof createAeroGameplaySessionCoordinator>} coordinator @param {Readonly<Record<string, unknown>>} event */
function readyGameplay(coordinator, event) {
  coordinator.configureContent({
    packageId: "package-1",
    selectedVariant: flowVariant,
    resolvedEvents: [event],
    profileIdentity: { schema: "aerobeat/prototype_tuning_identity", version: 1, profileId: "profile", profileVersion: "1", contentHash: gameplayHash, class: "between_run_ruleset", regenerationRequired: false },
    shadowVariants: []
  });
  const clock = { contextTimeSeconds: 0, positionSeconds: 0, playing: false };
  const input = { calibration: { calibrationId: "cal-1", readiness: "countdown" }, tracking: { gameplayPaused: false, freshCalibrationRequired: false }, countdownFrozen: false, latestEvidence: null, straightQualifications: [] };
  coordinator.advance({ timestampMs: 0, clock, input });
  assert.equal(coordinator.requestStart(0).accepted, true);
  for (const timestampMs of [1000, 2000, 3000]) coordinator.advance({ timestampMs, clock });
  assert.equal(coordinator.getSnapshot().session.state, "playing");
}

/** @param {ReturnType<typeof createAeroGameplaySessionCoordinator>} coordinator @param {import("@aerobeat/web-contracts").AeroGameplayEvidenceSnapshot} evidence @param {number} positionMs */
function judgeGameplay(coordinator, evidence, positionMs) {
  coordinator.advance({
    timestampMs: evidence.measurementTimestampMs,
    clock: { contextTimeSeconds: positionMs / 1000, positionSeconds: positionMs / 1000, playing: true },
    input: {
      calibration: { calibrationId: evidence.calibrationId, readiness: "countdown" },
      tracking: { gameplayPaused: false, freshCalibrationRequired: false },
      countdownFrozen: false,
      latestEvidence: evidence,
      straightQualifications: []
    }
  });
  return coordinator.getJudgements().map((entry) => [entry.result, entry.diagnostics]);
}

const octants = [
  ["up", { x: 0.375, y: 1 / 6 }],
  ["up-right", { x: 0.625, y: 1 / 6 }],
  ["right", { x: 0.625, y: 0.5 }],
  ["down-right", { x: 0.625, y: 5 / 6 }],
  ["down", { x: 0.375, y: 5 / 6 }],
  ["down-left", { x: 0.125, y: 5 / 6 }],
  ["left", { x: 0.125, y: 0.5 }],
  ["up-left", { x: 0.125, y: 1 / 6 }]
];

for (const [expected, target] of octants) {
  const entries = runLeftTransition(/** @type {{x:number,y:number}} */ (target), [20, 40, 60, 80, 100]);
  assert.equal(entries.length, 1, `${expected} emits one measured cell entry`);
  assert.ok(isBodyGridCellEntry(entries[0]));
  assert.equal(entries[0].direction, expected, `${expected} is quantized in athlete-space`);
  assert.equal(entries[0].provenance, "measured");
}

for (const cadence of [[16, 32, 48, 64, 80], [33, 66, 99, 132, 165]]) {
  assert.equal(runLeftTransition({ x: 0.625, y: 1 / 6 }, cadence)[0]?.direction, "up-right", `cadence ${cadence[0]}ms preserves the octant`);
}

// Values on each side of the 22.5deg and 67.5deg boundaries choose deterministic neighboring octants.
for (const [expected, target] of [
  ["right", { x: 0.625, y: 0.5 - 0.4 / 3 }],
  ["up-right", { x: 0.625, y: 0.5 - 0.45 / 3 }],
  ["up", { x: 0.375 + 0.4 / 4, y: 1 / 6 }],
  ["up-right", { x: 0.375 + 0.45 / 4, y: 1 / 6 }]
]) {
  assert.equal(runLeftTransition(/** @type {{x:number,y:number}} */ (target), [20, 40, 60, 80, 100])[0]?.direction, expected, `${expected} side of octant boundary is stable`);
}

// A final-frame perturbation cannot override the smoothed recent diagonal.
{
  const service = createAeroBodyGridService({ calibrationIdPrefix: "smooth" });
  ready(service);
  let observed = null;
  for (const [at, wrist] of [
    [8420, center], [8460, center], [8500, center],
    [8520, { x: 0.425, y: 0.43 }], [8540, { x: 0.49, y: 0.34 }], [8560, { x: 0.56, y: 0.25 }],
    [8580, { x: 0.625, y: 0.19 }], [8600, { x: 0.615, y: 1 / 6 }]
  ]) {
    const entry = service.processPoseSample(pose(at, handChanges({ left: { wrist } }))).entries.find((candidate) => candidate.anchor === "left_wrist" && candidate.toCell === 2);
    observed ??= entry?.direction ?? null;
  }
  assert.equal(observed, "up-right");
}

// Shoulder translation cancels out: an absolute cell crossing with no wrist-relative motion is ambiguous.
{
  const service = createAeroBodyGridService({ calibrationIdPrefix: "shoulder-frame" });
  ready(service);
  for (const [at, ratio] of [[8420, 0], [8460, 0], [8500, 0], [8540, 0.5], [8580, 1]]) {
    const translated = { x: shoulder.x + 0.25 * ratio, y: shoulder.y };
    const wrist = { x: center.x + 0.25 * ratio, y: center.y };
    service.processPoseSample(pose(at, handChanges({ left: { shoulder: translated, wrist } })));
  }
  assert.equal(service.getSnapshot().anchors.find((anchor) => anchor.anchor === "left_wrist")?.cell, 6);
  const entry = service.getSnapshot().entries.find((candidate) => candidate.anchor === "left_wrist");
  assert.ok(entry, "shoulder translation preserves the measured cell transition");
  assert.equal(Object.hasOwn(entry, "direction"), false, "shoulder translation does not invent wrist direction");
  assert.ok(isBodyGridCellEntry(entry), "the directionless transition satisfies the shared contract");
}

// Both hands own independent rolling histories and can emit opposite diagonals in one measured frame.
{
  const service = createAeroBodyGridService({ calibrationIdPrefix: "hands" });
  ready(service);
  const rightCenter = { x: 0.625, y: 0.5 };
  for (const [at, ratio] of [[8420, 0], [8460, 0], [8500, 0], [8540, 0.5], [8580, 1]]) {
    service.processPoseSample(pose(at, handChanges({
      left: { wrist: interpolate(center, { x: 0.625, y: 1 / 6 }, ratio) },
      right: { wrist: interpolate(rightCenter, { x: 0.375, y: 5 / 6 }, ratio) }
    })));
  }
  const entries = service.getSnapshot().entries;
  assert.equal(entries.find((entry) => entry.anchor === "left_wrist")?.direction, "up-right");
  assert.equal(entries.find((entry) => entry.anchor === "right_wrist")?.direction, "down-left");
}

// Hysteresis can produce a tiny boundary crossing. Preserve the entry for dot notes without fabricating direction.
{
  const service = createAeroBodyGridService({ calibrationIdPrefix: "minimum", directionHistoryWindowMs: 40, directionMinimumMagnitude: 0.12 });
  ready(service);
  let snapshot = service.getSnapshot();
  /** @type {import("@aerobeat/web-contracts").AeroBodyGridCellEntry[]} */
  const entries = [];
  /** @type {import("@aerobeat/web-contracts").AeroGameplayEvidenceSnapshot | null} */
  let transitionEvidence = null;
  for (const [at, x] of [[8400, 0.52], [8450, 0.52], [8500, 0.52], [8550, 0.526]]) {
    snapshot = service.processPoseSample(pose(at, handChanges({ left: { wrist: { x, y: 0.5 } } })));
    const wristEntries = snapshot.entries.filter((entry) => entry.anchor === "left_wrist");
    entries.push(...wristEntries);
    if (wristEntries.length > 0) transitionEvidence = snapshot.latestEvidence;
  }
  assert.equal(snapshot.anchors.find((anchor) => anchor.anchor === "left_wrist")?.cell, 6);
  assert.equal(entries.length, 1, "sub-threshold movement emits exactly one measured cell entry");
  assert.equal(Object.hasOwn(entries[0], "direction"), false, "ambiguous movement omits the direction property");
  assert.ok(isBodyGridCellEntry(entries[0]), "the shared contract validates a directionless entry");
  assert.equal(entries[0].provenance, "measured");
  assert.ok(transitionEvidence);

  const dot = createAeroGameplaySessionCoordinator({ sessionId: "directionless-dot" });
  readyGameplay(dot, flowEvent("directionless-dot", undefined));
  assert.deepEqual(judgeGameplay(dot, transitionEvidence, 500), [["hit", []]], "dot gameplay consumes the directionless entry");

  const arrow = createAeroGameplaySessionCoordinator({ sessionId: "directionless-arrow" });
  readyGameplay(arrow, flowEvent("directionless-arrow", 3));
  assert.deepEqual(judgeGameplay(arrow, transitionEvidence, 681), [["miss", ["wrong_direction"]]], "arrow gameplay rejects missing directional evidence");
}

// Timestamp rollback discards rolling direction truth before the next accepted frame.
{
  const service = createAeroBodyGridService({ calibrationIdPrefix: "rollback" });
  ready(service);
  for (const [at, x] of [[8420, 0.375], [8460, 0.42], [8500, 0.48], [8540, 0.52]]) {
    service.processPoseSample(pose(at, handChanges({ left: { wrist: { x, y: 0.5 } } })));
  }
  service.processPoseSample(pose(8530, handChanges({ left: { wrist: { x: 0.6, y: 0.5 } } })));
  const snapshot = service.processPoseSample(pose(8580, handChanges({ left: { wrist: { x: 0.6, y: 0.5 } } })));
  assert.equal(snapshot.anchors.find((anchor) => anchor.anchor === "left_wrist")?.cell, 6);
  const entry = snapshot.entries.find((candidate) => candidate.anchor === "left_wrist");
  assert.ok(entry, "rollback preserves the next measured cell transition");
  assert.equal(Object.hasOwn(entry, "direction"), false, "rollback reset prevents stale direction reuse");
}

// Tracking invalidity clears both wrist histories; prediction never repopulates them.
{
  const service = createAeroBodyGridService({ calibrationIdPrefix: "tracking-reset" });
  ready(service);
  for (const [at, x] of [[8420, 0.375], [8460, 0.42], [8500, 0.48], [8540, 0.52]]) {
    service.processPoseSample(pose(at, handChanges({ left: { wrist: { x, y: 0.5 } } })));
  }
  service.processPoseSample(pose(8560, { ...handChanges({ left: { wrist: { x: 0.52, y: 0.5 } } }), right_wrist: { ...cameraPoint({ x: 0.625, y: 0.5 }), confidence: 0.2 } }));
  const snapshot = service.processPoseSample(pose(8580, handChanges({ left: { wrist: { x: 0.6, y: 0.5 } } })));
  assert.equal(snapshot.entries.some((entry) => entry.anchor === "left_wrist"), false, "tracking invalidity clears rolling motion");
}

console.log("Validated rolling shoulder-relative eight-way Flow direction evidence.");
