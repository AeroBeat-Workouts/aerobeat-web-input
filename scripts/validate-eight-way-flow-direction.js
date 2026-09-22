// @ts-check

// Proves the eight-way Flow direction behavior against the real
// `flow_colliders_v1` scoring path under the 0.0.61 L-F2 saber-capsule
// detector. The swept 2.5D wrist-segment collision model this script was
// originally written against is retired: `swept-segment` hit detection is
// replaced by a per-frame saber-capsule test that reads the current wrist
// sample and orients the beam from a 100 ms wrist-history direction oracle
// (see `session-coordinator.js` `evaluateFlowColliderNotesAndBombs`,
// ~:999-1069, and `flow-collider-collision.js` `saberDirectionFromWristHistory`,
// `saberCapsuleContactsFlowTarget`, `matchesAuthoredDirection`).
//
// This script drives the session coordinator end to end with the current
// capsule detector:
//
//   1. enforceAuthoredDirection: true — each of the eight authored directions
//      (up/down/left/right + the four diagonals, the BEAT_SABER_FLOW_DIRECTIONS
//      order at session-coordinator.js:1890) produces exactly one clean hit,
//      and a crossing outside the 45° tolerance misses with `wrong_direction`.
//   2. The 45° tolerance boundary is pinned on both sides: the check is
//      `cosine + Number.EPSILON >= Math.cos(tolerance)`
//      (flow-collider-collision.js:313), so exactly 45° is INCLUSIVE (hits)
//      and just beyond it misses with `wrong_direction`.
//   3. enforceAuthoredDirection: false — the same out-of-tolerance crossing
//      still hits (direction gate skipped).
//   4. A directionless cue (`direction` omitted) hits regardless of movement
//      direction with the toggle ON (the direction gate is skipped when
//      `event.direction === undefined`, session-coordinator.js:1053).
//   5. Mode-isolation sanity: the score partition is bound to
//      `flow_colliders_v1` with a `sha256:` Flow Collider settings identity.
//
// Fixture shape (what the coordinator actually requires):
//   * `configureContent` carries an exact v1 `flowColliderSettings` record
//     (schema/version/algorithm/colliderRadius/enforceAuthoredDirection/
//     directionToleranceDegrees/timingWindowMs — validated by
//     `createFlowColliderSettings`, flow-collider-collision.js:35-46).
//   * Every advance input carries `sourceIdentity` (a non-empty string).
//     `measuredColliderSample` returns null without it
//     (flow-collider-collision.js:84), so the whole collider path is skipped.
//
// Coordinate note: the collision math works in measured athlete-grid
// coordinates lifted to the judge plane as `sx = 4*x - 0.5`,
// `sy = 2.5 - 3*y` (flow-collider-collision.js:96). In judge space `sy` is
// UP, so an athlete "up" motion (y decreasing) is a `+sy` sweep. The target
// for placement 6 is a 1×1 judge-space cell centered at (2, 1)
// (`flowNoteCellBox`, flow-collider-collision.js:123-126). All trajectories
// below are derived in judge space against the real `DIRECTIONS` table
// (flow-collider-collision.js:61-65) and the saber capsule geometry
// (length 0.75, radius 0.18, `saberGeometry` from
// `@aerobeat/web-contracts/equipment-contracts`).
//
// Frame-choreography pattern (saber-capsule era):
//
//   The capsule detector evaluates ONE frame at a time: the wrist sample
//   `current` is checked against the 1×1 cell box with the saber axis
//   `saberDirection = saberDirectionFromWristHistory(history, nowMs)` — a
//   100 ms lookback over the prior wrist positions — and the authored
//   direction gate uses `matchesAuthoredDirection(direction, prior, current,
//   45°)`, where `prior` is the PREVIOUS measured sample. Because of this
//   windowed oracle, the judged frame needs enough PRIOR samples in its
//   100 ms window so the saber axis matches the authored direction. The
//   four-frame clean-direction sweep (4760 → 4840 → 4920 → 5000 ms, 80 ms
//   gaps) gives the judged frame (pos 4920) two samples inside the 100 ms
//   window (4840 + 4920) so the saber axis resolves to the correct
//   direction, AND gives `matchesAuthoredDirection` a valid `prior` from the
//   immediately preceding frame. The first frame (4760) is a pure baseline
//   seed (it is skipped by the coordinator's `leftWristBaselineRequired`
//   path, session-coordinator.js:1028). Frames stay inside the ±180 ms
//   timing window [4820, 5180] around the event center 5000 ms.
//
//   For the miss cases the judged frame is held well past the late window
//   bound (pos 5300 > 5180) so the coordinator finalizes the miss with the
//   `wrong_direction` diagnostic (`colliderMissDiagnostics`,
//   session-coordinator.js:1139-1145).

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
// The eight authored directions and their four-frame trajectories.
//
// Under the saber-capsule detector, the judged frame needs PRIOR wrist
// positions inside the 100 ms direction-oracle window so the saber axis
// matches the authored direction. Four frames (80 ms apart in both wall and
// song time) give the judged frame two prior samples in-window and a valid
// `prior` for `matchesAuthoredDirection`.
//
// Frame 1 is a baseline seed at the start of the sweep (athlete coordinates
// at -0.5·dir from the cell center (2,1) in judge space). Frames 2 and 3
// build up the motion; frame 3 (song time 4920 ms) is the judged frame and
// lands inside the ±180 ms timing window. Frame 4 completes the sweep but is
// never reached because the hit is recorded at frame 3.
//
//   direction   frames 1→4 (athlete x, y)               song ms  wall ms
//   up          (0.625,0.667)→(0.625,0.550)→(0.625,0.450)→(0.625,0.333)  4760 4840 4920 5000
//   down        (0.625,0.333)→(0.625,0.450)→(0.625,0.550)→(0.625,0.667)  4760 4840 4920 5000
//   left        (0.750,0.500)→(0.663,0.500)→(0.588,0.500)→(0.500,0.500)  4760 4840 4920 5000
//   right       (0.500,0.500)→(0.588,0.500)→(0.663,0.500)→(0.750,0.500)  4760 4840 4920 5000
//   up-left     (0.713,0.618)→(0.652,0.535)→(0.598,0.465)→(0.537,0.382)  4760 4840 4920 5000
//   up-right    (0.537,0.618)→(0.598,0.535)→(0.652,0.465)→(0.713,0.382)  4760 4840 4920 5000
//   down-left   (0.713,0.382)→(0.652,0.465)→(0.598,0.535)→(0.537,0.618)  4760 4840 4920 5000
//   down-right  (0.537,0.382)→(0.598,0.465)→(0.652,0.535)→(0.713,0.618)  4760 4840 4920 5000
// ─────────────────────────────────────────────────────────────────────────────

const EIGHT_WAYS = Object.freeze([
  Object.freeze(["up", 0,
    Object.freeze([{ x: 0.625, y: 0.6667 }, { x: 0.625, y: 0.55 }, { x: 0.625, y: 0.45 }, { x: 0.625, y: 0.3333 }])]),
  Object.freeze(["down", 1,
    Object.freeze([{ x: 0.625, y: 0.3333 }, { x: 0.625, y: 0.45 }, { x: 0.625, y: 0.55 }, { x: 0.625, y: 0.6667 }])]),
  Object.freeze(["left", 2,
    Object.freeze([{ x: 0.75, y: 0.5 }, { x: 0.6625, y: 0.5 }, { x: 0.5875, y: 0.5 }, { x: 0.5, y: 0.5 }])]),
  Object.freeze(["right", 3,
    Object.freeze([{ x: 0.5, y: 0.5 }, { x: 0.5875, y: 0.5 }, { x: 0.6625, y: 0.5 }, { x: 0.75, y: 0.5 }])]),
  Object.freeze(["up-left", 4,
    Object.freeze([{ x: 0.7134, y: 0.6179 }, { x: 0.6515, y: 0.5354 }, { x: 0.5985, y: 0.4646 }, { x: 0.5366, y: 0.3821 }])]),
  Object.freeze(["up-right", 5,
    Object.freeze([{ x: 0.5366, y: 0.6179 }, { x: 0.5985, y: 0.5354 }, { x: 0.6515, y: 0.4646 }, { x: 0.7134, y: 0.3821 }])]),
  Object.freeze(["down-left", 6,
    Object.freeze([{ x: 0.7134, y: 0.3821 }, { x: 0.6515, y: 0.4646 }, { x: 0.5985, y: 0.5354 }, { x: 0.5366, y: 0.6179 }])]),
  Object.freeze(["down-right", 7,
    Object.freeze([{ x: 0.5366, y: 0.3821 }, { x: 0.5985, y: 0.4646 }, { x: 0.6515, y: 0.5354 }, { x: 0.7134, y: 0.6179 }])])
]);

// Four wall timestamps: 80 ms apart, starting at 4920 (well within the
// ±180 ms timing window around the 5000 ms event center).
const FRAME_WALLS = Object.freeze([4760, 4840, 4920, 5000]);
// Song timeline mirrors the wall timestamps (position == wall in this fixture).
const FRAME_SONG = Object.freeze([4760, 4840, 4920, 5000]);

// ── (1a) enforceAuthoredDirection: true — each authored direction hits ──────
for (const [name, direction, frames] of EIGHT_WAYS) {
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: `hit-${name}` });
  readyGameplay(coordinator, flowEvent(`hit-${name}`, direction), flowColliderSettings);
  // Frame 1: baseline seed (coordinator skips evaluation on the seed frame).
  judgeFrame(coordinator, frames[0], FRAME_SONG[0], FRAME_WALLS[0], 1);
  // Frame 2: first real sample — establishes the wrist-history window.
  judgeFrame(coordinator, frames[1], FRAME_SONG[1], FRAME_WALLS[1], 2);
  // Frame 3: the judged frame — prior is frames[1], the 100 ms window
  // contains frames[1] (80 ms back), and the capsule contacts the cell.
  const judgements = judgeFrame(coordinator, frames[2], FRAME_SONG[2], FRAME_WALLS[2], 3);
  assert.deepEqual(judgements, [["hit", []]], `${name} (authored ${direction}) is a single clean hit with empty diagnostics`);
  coordinator.destroy();
}

// ── (1b) out-of-tolerance crossing misses with `wrong_direction` ────────────
// The authored `up` cue (direction 0) met by a purely horizontal (rightward)
// motion: each frame's step is ~90° off the authored `up` vector (cosine ~0
// << cos(45°)), so `matchesAuthoredDirection` fails on every in-window frame
// and no hit is produced. When the timeline passes the late bound (center +
// 180ms = 5180ms, strict) the coordinator finalizes a miss and emits
// `wrong_direction` (session-coordinator.js:1053, 1139-1145). The 5300ms
// miss frame deliberately holds the wrist still: the held capsule no longer
// contacts the cell, so the miss can only come from the direction-evidence
// path.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "wrong-direction" });
  readyGameplay(coordinator, flowEvent("wrong-direction", 0), flowColliderSettings);
  // Frames 1-4: rightward sweep (baseline seed, then 0.35-unit steps), no hit.
  judgeFrame(coordinator, { x: 0.5, y: 0.5 }, 4760, 4760, 1);
  judgeFrame(coordinator, { x: 0.5875, y: 0.5 }, 4840, 4840, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.6625, y: 0.5 }, 4920, 4920, 3), [], "an out-of-tolerance in-window crossing produces no judgement yet");
  judgeFrame(coordinator, { x: 0.75, y: 0.5 }, 5000, 5000, 4);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.75, y: 0.5 }, 5300, 5300, 5), [["miss", ["wrong_direction"]]], "an out-of-tolerance crossing finalizes as a miss with the wrong_direction diagnostic");
  coordinator.destroy();
}

// ── (2) tolerance boundary — inclusive at 45°, exclusive just beyond ────────
// The tolerance check is `cosine + Number.EPSILON >= Math.cos(tolerance)`
// (flow-collider-collision.js:313), so the boundary is INCLUSIVE. Each sweep
// is a run of 0.35-unit steps (each above MINIMUM_SABER_DIRECTION_TRAVEL =
// 0.05) tilted to the right of the authored `up` axis by the given angle,
// passing through the cell center:
//   inclusive: step direction (sin 45°, cos 45°) -> (0.5366,0.6179) (0.625,0.5) (0.7134,0.3821)
//   exclusive: step direction (sin 48°, cos 48°) -> (0.5321,0.6115) (0.625,0.5) (0.7179,0.3885)
// (both sweeps stay inside the 1x1 cell on the judged frame, so the only term
// that changes between the two runs is the direction check).

// (2a) exactly-45° sweep — inclusive, hits.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "boundary-inclusive" });
  readyGameplay(coordinator, flowEvent("boundary-inclusive", 0), flowColliderSettings);
  judgeFrame(coordinator, { x: 0.5366, y: 0.6179 }, 4840, 4840, 1);
  judgeFrame(coordinator, { x: 0.625, y: 0.5 }, 4920, 4920, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.7134, y: 0.3821 }, 5000, 5000, 3), [["hit", []]], "a sweep exactly at the 45° tolerance boundary is inclusive and hits");
  coordinator.destroy();
}

// (2b) just-beyond-45° sweep (48°) — exclusive, misses with wrong_direction.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "boundary-exclusive" });
  readyGameplay(coordinator, flowEvent("boundary-exclusive", 0), flowColliderSettings);
  judgeFrame(coordinator, { x: 0.5321, y: 0.6115 }, 4840, 4840, 1);
  judgeFrame(coordinator, { x: 0.625, y: 0.5 }, 4920, 4920, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.7179, y: 0.3885 }, 5000, 5000, 3), [], "a sweep just beyond 45° produces no hit in-window");
  judgeFrame(coordinator, { x: 0.7179, y: 0.3885 }, 5080, 5080, 4);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.7179, y: 0.3885 }, 5300, 5300, 5), [["miss", ["wrong_direction"]]], "a sweep just beyond the 45° tolerance finalizes as a wrong_direction miss");
  coordinator.destroy();
}

// ── (3) enforceAuthoredDirection: false — direction is ignored ──────────────
// The same out-of-tolerance rightward sweep against an authored `up` cue now
// HITS because the direction gate is only applied when
// `enforceAuthoredDirection === true && event.direction !== undefined`
// (session-coordinator.js:1053) — direction-agnostic scoring.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "direction-off" });
  readyGameplay(coordinator, flowEvent("direction-off", 0), flowColliderSettingsDirectionOff);
  judgeFrame(coordinator, { x: 0.625, y: 0.5 }, 4840, 4840, 1);
  judgeFrame(coordinator, { x: 0.7, y: 0.5 }, 4920, 4920, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.775, y: 0.5 }, 5000, 5000, 3), [["hit", []]], "with the toggle off, an out-of-tolerance crossing still hits (direction gate skipped)");
  coordinator.destroy();
}

// ── (4) directionless cues accept any direction ─────────────────────────────
// A cue with no `direction` property is a directionless note: the same gate
// at session-coordinator.js:1053 skips the authored-direction check entirely,
// so a plain in-window crossing hits regardless of movement direction.
// (The directionless marker `9` is the Flow source conversion's
// `requireFlowSourceDirection` sentinel
// (session-coordinator.js:1361-1365) and has no resolved-content-event form
// for this path; `direction: undefined` is the canonical directionless cue.)
// A rightward sweep — 90° off the authored up/down axes — still hits the
// directionless cue with the toggle ON.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "directionless" });
  readyGameplay(coordinator, flowEvent("directionless", undefined), flowColliderSettings);
  judgeFrame(coordinator, { x: 0.625, y: 0.5 }, 4840, 4840, 1);
  judgeFrame(coordinator, { x: 0.7, y: 0.5 }, 4920, 4920, 2);
  assert.deepEqual(judgeFrame(coordinator, { x: 0.775, y: 0.5 }, 5000, 5000, 3), [["hit", []]], "a directionless cue hits regardless of movement direction with the toggle on");
  coordinator.destroy();
}

// ── (5) mode-isolation sanity — the fixture IS a flow_colliders_v1 session ──
// Pin the v1 collider setup the coordinator actually bound, surfaced through
// the score partition's `flowColliderSettingsIdentity`
// (session-coordinator.js:1068-1070) plus the hit attribution.
// Authored `right` cue (direction 3) met by a rightward sweep — the same
// geometry as the clean `right` case — so the hit lands at frame 3.
{
  const coordinator = createAeroGameplaySessionCoordinator({ sessionId: "mode-isolation" });
  readyGameplay(coordinator, flowEvent("mode-isolation", 3), flowColliderSettings);
  judgeFrame(coordinator, { x: 0.5, y: 0.5 }, 4760, 4760, 1);
  judgeFrame(coordinator, { x: 0.5875, y: 0.5 }, 4840, 4840, 2);
  judgeFrame(coordinator, { x: 0.6625, y: 0.5 }, 4920, 4920, 3);
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

console.log("Validated eight-way Flow direction against Flow Colliders saber-capsule scoring.");
