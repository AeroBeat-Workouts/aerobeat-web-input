// @ts-check

// Proves the eight-way Flow direction behavior against the real
// `flow_colliders_v1` scoring path. The 0.0.50 Flow Grid deletion retired the
// `flow_grid_v2` semantic cell-entry matching this script was originally
// written against; the previous lane re-pointed the fixture `rulesetId` to
// `flow_colliders_v1` without rebuilding the fixture, so the run fell back to
// the default collider settings (overlap-only) and produced no hits at all
// (`ERR_ASSERTION actual: [] expected: [[ 'hit', [] ]]`).
//
// This rewrite drives the session coordinator
// (`session-coordinator.js` `evaluateFlowColliderNotesAndBombs`, ~:752-794)
// end to end with the real swept 2.5D wrist-segment collision
// (`flow-collider-collision.js`):
//
//   1. enforceAuthoredDirection: true — each of the eight authored directions
//      (up/down/left/right + the four diagonals, the BEAT_SABER_FLOW_DIRECTIONS
//      order at session-coordinator.js:1546) produces exactly one clean hit,
//      and a crossing outside the 45° tolerance misses with `wrong_direction`.
//   2. The 45° tolerance boundary is pinned on both sides: the check is
//      `cosine + Number.EPSILON >= Math.cos(tolerance)`
//      (flow-collider-collision.js:129), so exactly 45° is INCLUSIVE (hits)
//      and just beyond it misses with `wrong_direction`.
//   3. enforceAuthoredDirection: false — the same out-of-tolerance crossing
//      still hits (direction ignored, overlap-only).
//   4. A directionless cue (`direction` omitted) hits regardless of movement
//      direction with the toggle ON (session-coordinator.js:779 gates on
//      `event.direction !== undefined`).
//   5. Mode-isolation sanity: the score partition is bound to
//      `flow_colliders_v1` with a `sha256:` Flow Collider settings identity.
//
// Fixture shape (what the coordinator actually requires):
//   * `configureContent` carries an exact v1 `flowColliderSettings` record
//     (schema/version/algorithm/colliderRadius/enforceAuthoredDirection/
//     directionToleranceDegrees/timingWindowMs — validated by
//     `createFlowColliderSettings`, flow-collider-collision.js:16-44, and
//     normalized at session-coordinator.js:1384-1391).
//   * Every advance input carries `sourceIdentity` (a non-empty string).
//     `measuredColliderSample` returns null without it
//     (flow-collider-collision.js:67), so the whole collider path is skipped
//     — the sibling gameplay fixture does the same
//     (aerobeat-web-gameplay/scripts/validate-flow-collider-collision.js:14, 18).
//
// Coordinate note: the collision math works in measured athlete-grid
// coordinates lifted to the swept collider plane as `sx = 4*x - 0.5`,
// `sy = 2.5 - 3*y` (flow-collider-collision.js:74). In collider space `sy` is
// UP, so an athlete "up" motion (y decreasing) is a `+sy` sweep. All
// trajectories below are derived in collider space against the real
// `DIRECTIONS` table (flow-collider-collision.js:54-58) and the target
// footprint `targetCenterForPlacement(6)` = (2, 1)
// (flow-collider-collision.js:78-80) with half-extent 0.375 + radius 0.12 =
// 0.495, i.e. footprint sx ∈ [1.505, 2.495], sy ∈ [0.505, 1.495].
//
// Three-frame pattern: the first measured frame seeds the left-wrist baseline
// (`leftWristBaselineRequired`, session-coordinator.js:766-767), the second
// frame establishes `previousLeftWristSample`, and the third frame is the
// first that can produce a swept-segment hit. Frames are 80ms apart in both
// measurement time and song time, so each segment passes
// `isContinuousColliderSegment` (gap ≤ maximumColliderSampleGapMs = 150ms,
// flow-collider-collision.js:10, 115-117) and the sweep stays inside the
// ±180ms timing window [4820, 5180] around the event center 5000ms. Each
// swept segment is 1.0 unit long (above MINIMUM_DIRECTION_TRAVEL = 0.05,
// flow-collider-collision.js:53) and clips through the footprint in time.

import assert from "node:assert/strict";
import { isGameplayEvidenceSnapshot, isBodyGridAnchorSnapshot } from "@aerobeat/web-contracts";
import { createAeroGameplaySessionCoordinator } from "../../aerobeat-web-gameplay/src/index.js";

const SOURCE_IDENTITY = "eight-way-camera";

// Static (non-moving) anchors for the evidence snapshots.
const ATHLETE_BASE = Object.freeze({ nose: { x: 0.5, y: 0.3 }, left_shoulder: { x: 0.6, y: 0.4 }, right_shoulder: { x: 0.4, y: 0.4 }, left_elbow: { x: 0.7, y: 0.4 }, right_elbow: { x: 0.3, y: 0.4 }, left_wrist: { x: 0.8, y: 0.4 }, right_wrist: { x: 0.2, y: 0.4 } });
const ANCHOR_NAMES = Object.freeze(["nose", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist"]);
const CALIBRATION_ID = "cal-eight-way";

// Exact v1 Flow Collider settings record the coordinator requires
// (flow-collider-collision.js:16-24, 26; normalized at
// session-coordinator.js:1384-1391).
const flowColliderSettings = Object.freeze({
  schema: "aerobeat/flow_collider_settings",
  version: 1,
  algorithm: "swept_athlete_plane_v1",
  colliderRadius: 0.12,
  enforceAuthoredDirection: true,
  directionToleranceDegrees: 45,
  timingWindowMs: 180
});

// The same record with the authored-direction toggle disabled (the rest of
// the v1 record is byte-identical so every other collision term is held
// constant).
const flowColliderSettingsDirectionOff = Object.freeze({
  schema: "aerobeat/flow_collider_settings",
  version: 1,
  algorithm: "swept_athlete_plane_v1",
  colliderRadius: 0.12,
  enforceAuthoredDirection: false,
  directionToleranceDegrees: 45,
  timingWindowMs: 180
});

const gameplayHash = "b".repeat(64);
const flowVariant = Object.freeze({
  variantId: "variant",
  chartId: "chart-variant",
  mode: "flow",
  rulesetId: "flow_colliders_v1",
  recipeId: null,
  modifierIds: Object.freeze([]),
  ranked: false,
  mapHash: Object.freeze({ schema: "aerobeat/content_hash", version: 1, algorithm: "sha256", value: gameplayHash }),
  scoreIdentityHash: Object.freeze({ schema: "aerobeat/content_hash", version: 1, algorithm: "sha256", value: gameplayHash }),
  provenance: Object.freeze({ baseVariantId: "variant" })
});
const profileIdentity = Object.freeze({ schema: "aerobeat/prototype_tuning_identity", version: 1, profileId: "profile", profileVersion: "1", contentHash: gameplayHash, class: "between_run_ruleset", regenerationRequired: false });

/**
 * Build a minimal, contract-valid measured gameplay evidence snapshot.
 *
 * The Flow Colliders path consumes only the wrist anchors it needs
 * (`measuredColliderSample`, flow-collider-collision.js:66-75), but the public
 * `isGameplayEvidenceSnapshot` contract is enforced by the coordinator on
 * input (session-coordinator.js:529), so every anchor must be a valid
 * `AeroBodyGridAnchorSnapshot`.
 *
 * @param {{x:number,y:number,confidence?:number}} leftWrist Athlete-space left-wrist position.
 * @param {number} timestampMs Real measured timestamp.
 * @param {number} frameIndex Unique measured source-frame identity per frame.
 */
function evidenceSnapshot(leftWrist, timestampMs, frameIndex) {
  const makeAnchor = /** @param {string} name @param {{x:number,y:number,confidence?:number}} point */ (name, point) => ({
    schema: "aerobeat/body_grid_anchor_snapshot",
    version: 1,
    anchor: name,
    calibrationId: CALIBRATION_ID,
    measurementTimestampMs: timestampMs,
    valid: true,
    confidence: point.confidence ?? 0.95,
    rawX: point.x,
    rawY: point.y,
    x: point.x,
    y: point.y,
    cell: 6,
    subcell: 24
  });
  const anchors = ANCHOR_NAMES.map((name) => makeAnchor(name, name === "left_wrist" ? leftWrist : ATHLETE_BASE[name]));
  return Object.freeze({
    schema: "aerobeat/gameplay_evidence_snapshot",
    version: 1,
    calibrationId: CALIBRATION_ID,
    measuredSourceFrameId: `frame-${frameIndex}`,
    measurementTimestampMs: timestampMs,
    provenance: "measured",
    activeBoxingActions: Object.freeze([]),
    anchors: Object.freeze(anchors),
    entries: Object.freeze([])
  });
}

/** @param {string} eventId @param {number | undefined} direction */
function flowEvent(eventId, direction) {
  return Object.freeze({
    schema: "aerobeat/resolved_content_event",
    version: 3,
    eventId,
    variantId: "variant",
    chartId: "chart-variant",
    centerTimestampMs: 5000,
    sourceEventIds: Object.freeze([`source-${eventId}`]),
    type: "note",
    hand: "left",
    placement: 6,
    ...(direction === undefined ? {} : { direction })
  });
}

/**
 * Start a playing `flow_colliders_v1` session.
 *
 * @param {ReturnType<typeof createAeroGameplaySessionCoordinator>} coordinator
 * @param {Readonly<Record<string, unknown>>} event
 * @param {Readonly<Record<string, unknown>>} settings
 */
function readyGameplay(coordinator, event, settings) {
  coordinator.configureContent({
    packageId: "package-1",
    selectedVariant: flowVariant,
    resolvedEvents: [event],
    profileIdentity,
    flowColliderSettings: settings,
    shadowVariants: []
  });
  // Frozen clock: the session sits in `countdown` (positionMs pinned at 0),
  // so the wall-clock countdown ticks three -> two -> one -> playing
  // (session-coordinator.js:621-642).
  const clock = { contextTimeSeconds: 0, positionSeconds: 0, playing: false };
  const input = {
    sourceIdentity: SOURCE_IDENTITY,
    calibration: { calibrationId: CALIBRATION_ID, readiness: "countdown" },
    tracking: { gameplayPaused: false, freshCalibrationRequired: false },
    countdownFrozen: false,
    latestEvidence: null,
    straightQualifications: []
  };
  coordinator.advance({ timestampMs: 0, clock, input });
  assert.equal(coordinator.requestStart(0).accepted, true, "the session accepts start and enters the countdown");
  for (const timestampMs of [1000, 2000, 3000]) coordinator.advance({ timestampMs, clock, input });
  assert.equal(coordinator.getSnapshot().session.state, "playing", "the session reaches the playing state");
}

/**
 * Advance one playing frame carrying a measured left-wrist evidence snapshot.
 *
 * The input must carry `sourceIdentity` (the connection's bounded source
 * identity; see aerobeat-web-gameplay/README.md — "Flow Colliders
 * additionally requires the snapshot's bounded `sourceIdentity`").
 * `measuredColliderSample` returns null without it, so the whole collider
 * path is skipped. The clock advances to `positionMs` (playing) so
 * `timelinePositionMs` tracks the event timeline; the wall `wallMs` keeps the
 * sample fresh (wall - measurement < maximumColliderSampleFreshnessMs = 150ms).
 *
 * @param {ReturnType<typeof createAeroGameplaySessionCoordinator>} coordinator
 * @param {{x:number,y:number}} leftWrist Athlete-space left-wrist position.
 * @param {number} positionMs Song timeline position for this frame.
 * @param {number} wallMs Wall timestamp for this frame (kept monotonic + fresh).
 * @param {number} frameIndex
 * @returns {readonly (readonly ["hit"|"miss"|"ignored", readonly string[]])[]}
 */
function judgeFrame(coordinator, leftWrist, positionMs, wallMs, frameIndex) {
  const evidence = evidenceSnapshot(leftWrist, wallMs, frameIndex);
  assert.ok(isGameplayEvidenceSnapshot(evidence), "the hand-built evidence satisfies the public contract");
  assert.ok(evidence.anchors.every(isBodyGridAnchorSnapshot), "every anchor satisfies the public anchor contract");
  coordinator.advance({
    timestampMs: wallMs,
    clock: { contextTimeSeconds: positionMs / 1000, positionSeconds: positionMs / 1000, playing: true },
    input: {
      sourceIdentity: SOURCE_IDENTITY,
      calibration: { calibrationId: CALIBRATION_ID, readiness: "countdown" },
      tracking: { gameplayPaused: false, freshCalibrationRequired: false },
      countdownFrozen: false,
      latestEvidence: evidence,
      straightQualifications: []
    }
  });
  return Object.freeze(coordinator.getJudgements().map((entry) => Object.freeze([entry.result, Object.freeze([...entry.diagnostics])] /** @satisfies {readonly ["hit"|"miss"|"ignored", readonly string[]]} */ )));
}

// ─────────────────────────────────────────────────────────────────────────────
// The eight authored directions and their three-frame trajectories.
//
// Frame 1 is always at the target center (athlete 0.625, 0.5 = collider
// sx = 2, sy = 1) — the baseline seed. Frames 2 and 3 form the swept segment,
// oriented along the authored direction's own unit vector
// (flow-collider-collision.js:54-58) with length 1.0:
//
//   direction   frame 2 (athlete)    frame 3 (athlete)
//   up          (0.625, 0.667) -> (0.625, 0.333)   [sx 2, sy 0.5->1.5]
//   down        (0.625, 0.333) -> (0.625, 0.667)   [sx 2, sy 1.5->0.5]
//   left        (0.750, 0.500) -> (0.500, 0.500)   [sy 1, sx 2.5->1.5]
//   right       (0.500, 0.500) -> (0.750, 0.500)   [sy 1, sx 1.5->2.5]
//   up-left     (0.713, 0.618) -> (0.537, 0.382)   [sx 2.354->1.646, sy 0.646->1.354]
//   up-right    (0.537, 0.618) -> (0.713, 0.382)   [sx 1.646->2.354, sy 0.646->1.354]
//   down-left   (0.713, 0.382) -> (0.537, 0.618)   [sx 2.354->1.646, sy 1.354->0.646]
//   down-right  (0.537, 0.382) -> (0.713, 0.618)   [sx 1.646->2.354, sy 1.354->0.646]
//
// Wall timestamps: 3120 -> 3200 -> 3280 (80ms gaps, all fresh < 150ms).
// Song timeline: 4920 -> 5000 -> 5080 (80ms gaps, all within [4820, 5180]).
// ─────────────────────────────────────────────────────────────────────────────

const FRAME1 = Object.freeze({ x: 0.625, y: 0.5 }); // target center (baseline seed)
const EIGHT_WAYS = Object.freeze([
  Object.freeze(["up", 0, { x: 0.625, y: 0.667 }, { x: 0.625, y: 0.333 }]),
  Object.freeze(["down", 1, { x: 0.625, y: 0.333 }, { x: 0.625, y: 0.667 }]),
  Object.freeze(["left", 2, { x: 0.75, y: 0.5 }, { x: 0.5, y: 0.5 }]),
  Object.freeze(["right", 3, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.5 }]),
  Object.freeze(["up-left", 4, { x: 0.713, y: 0.618 }, { x: 0.537, y: 0.382 }]),
  Object.freeze(["up-right", 5, { x: 0.537, y: 0.618 }, { x: 0.713, y: 0.382 }]),
  Object.freeze(["down-left", 6, { x: 0.713, y: 0.382 }, { x: 0.537, y: 0.618 }]),
  Object.freeze(["down-right", 7, { x: 0.537, y: 0.382 }, { x: 0.713, y: 0.618 }])
]);

// ── (1a) enforceAuthoredDirection: true — each authored direction hits ──────
for (const [name, direction, mid, end] of EIGHT_WAYS) {
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: `hit-${name}` });
  readyGameplay(coordinator, flowEvent(`hit-${name}`, direction), flowColliderSettings);
  judgeFrame(coordinator, FRAME1, 4920, 3120, 1);
  judgeFrame(coordinator, mid, 5000, 3200, 2);
  const judgements = judgeFrame(coordinator, end, 5080, 3280, 3);
  assert.deepEqual(judgements, [["hit", []]], `${name} (authored ${direction}) is a single clean hit with empty diagnostics`);
  coordinator.destroy();
}

// ── (1b) out-of-tolerance crossing misses with `wrong_direction` ────────────
// The authored `up` cue (direction 0) met by a purely horizontal (rightward)
// sweep: the segment's deviation from the authored `up` vector is ~90°
// (cosine ~0 << cos(45°)) -> not a hit while in-window. When the timeline
// passes the late bound (center + 180ms = 5180ms, strict) the coordinator
// finalizes a miss and emits `wrong_direction`
// (session-coordinator.js:820, 838). The 5300ms miss frame deliberately moves
// no wrist: a held wrist produces no segment (and no point contact here), so
// the miss can only come from the direction-evidence path.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "wrong-direction" });
  readyGameplay(coordinator, flowEvent("wrong-direction", 0), flowColliderSettings);
  judgeFrame(coordinator, FRAME1, 4920, 3120, 1);
  judgeFrame(coordinator, { x: 0.5, y: 0.5 }, 5000, 3200, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.75, y: 0.5 }, 5080, 3280, 3), [], "an out-of-tolerance in-window crossing produces no judgement yet");
  assert.deepEqual(judgeFrame(coordinator, { x: 0.75, y: 0.5 }, 5300, 3480, 4), [["miss", ["wrong_direction"]]], "an out-of-tolerance crossing finalizes as a miss with the wrong_direction diagnostic");
  coordinator.destroy();
}

// ── (2) tolerance boundary — inclusive at 45°, exclusive just beyond ────────
// The tolerance check is `cosine + Number.EPSILON >= Math.cos(tolerance)`
// (flow-collider-collision.js:129), so the boundary is INCLUSIVE. The sweep is
// a 1.0-length segment (frame 2 -> frame 3) centered on the target, tilted to
// the right of the authored `up` axis by the given angle:
//   inclusive: direction (sin 45°, cos 45°) -> frame 2 (0.537,0.618) frame 3 (0.713,0.382)
//   exclusive: direction (sin 48°, cos 48°) -> frame 2 (0.532,0.612) frame 3 (0.718,0.388)
// (both segments still clip the footprint in time, so the only term that
// changes between the two runs is the direction check).

// (2a) exactly-45° sweep — inclusive, hits.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "boundary-inclusive" });
  readyGameplay(coordinator, flowEvent("boundary-inclusive", 0), flowColliderSettings);
  judgeFrame(coordinator, FRAME1, 4920, 3120, 1);
  judgeFrame(coordinator, { x: 0.537, y: 0.618 }, 5000, 3200, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.713, y: 0.382 }, 5080, 3280, 3), [["hit", []]], "a sweep exactly at the 45° tolerance boundary is inclusive and hits");
  coordinator.destroy();
}

// (2b) just-beyond-45° sweep (48°) — exclusive, misses with wrong_direction.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "boundary-exclusive" });
  readyGameplay(coordinator, flowEvent("boundary-exclusive", 0), flowColliderSettings);
  judgeFrame(coordinator, FRAME1, 4920, 3120, 1);
  judgeFrame(coordinator, { x: 0.532, y: 0.612 }, 5000, 3200, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.718, y: 0.388 }, 5080, 3280, 3), [], "a sweep just beyond 45° produces no hit in-window");
  assert.deepEqual(judgeFrame(coordinator, { x: 0.718, y: 0.388 }, 5300, 3480, 4), [["miss", ["wrong_direction"]]], "a sweep just beyond the 45° tolerance finalizes as a wrong_direction miss");
  coordinator.destroy();
}

// ── (3) enforceAuthoredDirection: false — direction is ignored ──────────────
// The same out-of-tolerance rightward sweep against an authored `up` cue now
// HITS because the direction gate is only applied when
// `enforceAuthoredDirection === true && event.direction !== undefined`
// (session-coordinator.js:779) — overlap-only scoring.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "direction-off" });
  readyGameplay(coordinator, flowEvent("direction-off", 0), flowColliderSettingsDirectionOff);
  judgeFrame(coordinator, FRAME1, 4920, 3120, 1);
  judgeFrame(coordinator, { x: 0.5, y: 0.5 }, 5000, 3200, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.75, y: 0.5 }, 5080, 3280, 3), [["hit", []]], "with the toggle off, an out-of-tolerance crossing still hits (overlap-only)");
  coordinator.destroy();
}

// ── (4) directionless cues accept any direction ─────────────────────────────
// A cue with no `direction` property is a directionless note: the same gate
// at session-coordinator.js:779 skips the authored-direction check entirely,
// so a plain in-window crossing hits regardless of movement direction.
// (The directionless marker `9` is the Flow source conversion's
// `requireFlowSourceDirection` sentinel
// (session-coordinator.js:1361-1365) and has no resolved-content-event form
// for this path; `direction: undefined` is the canonical directionless cue.)
// A vertical (upward) sweep (dx = 0) — 90° off any authored horizontal
// direction — still hits the directionless cue with the toggle ON.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "directionless" });
  readyGameplay(coordinator, flowEvent("directionless", undefined), flowColliderSettings);
  judgeFrame(coordinator, FRAME1, 4920, 3120, 1);
  judgeFrame(coordinator, { x: 0.625, y: 0.667 }, 5000, 3200, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.625, y: 0.333 }, 5080, 3280, 3), [["hit", []]], "a directionless cue hits regardless of movement direction with the toggle on");
  coordinator.destroy();
}

// ── (5) mode-isolation sanity — the fixture IS a flow_colliders_v1 session ──
// Pin the v1 collider setup the coordinator actually bound, surfaced through
// the score partition's `flowColliderSettingsIdentity`
// (session-coordinator.js:1068-1070) plus the hit attribution. This is the
// setup the old script omitted, which is why it produced zero hits.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "mode-isolation" });
  readyGameplay(coordinator, flowEvent("mode-isolation", 3), flowColliderSettings);
  judgeFrame(coordinator, FRAME1, 4920, 3120, 1);
  judgeFrame(coordinator, { x: 0.5, y: 0.5 }, 5000, 3200, 2);
  judgeFrame(coordinator, { x: 0.75, y: 0.5 }, 5080, 3280, 3);
  const partitions = coordinator.getScorePartitions();
  assert.equal(partitions.length, 1, "exactly one score partition exists for the run");
  const partition = partitions[0];
  assert.equal(partition.rulesetId, "flow_colliders_v1", "the score partition is bound to the flow_colliders_v1 ruleset");
  assert.equal(typeof partition.flowColliderSettingsIdentity, "string", "the partition records a bound Flow Collider settings identity");
  assert.match(partition.flowColliderSettingsIdentity, /^sha256:[a-f0-9]{64}$/u, "the settings identity is a sha256 digest");
  assert.equal(partition.hits, 1, "the hit is attributed to the flow_colliders_v1 partition");
  assert.equal(partition.misses, 0, "no misses are attributed to the partition");
  coordinator.destroy();
}

console.log("Validated eight-way Flow direction against Flow Colliders swept-segment scoring.");
