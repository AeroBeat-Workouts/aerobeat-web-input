// @ts-check

import {
  athleteBodyGrid4x3,
  athleteBodySubgrid8x6,
  calibrationDefaults,
  cameraPreviewToAthlete,
  lossDecisionAnchorNames,
  normalizedPointToGridCell,
  prototypeJudgementDefaults,
  recoveryHoldMs,
  trackingLossHysteresisConsecutiveFails,
  upperBodyAnchorNames
} from "@aerobeat/web-contracts";

/** @typedef {import("@aerobeat/web-contracts").AeroPoseRoutingSample} AeroPoseRoutingSample */
/** @typedef {import("@aerobeat/web-contracts").NormalizedPoseFrame} NormalizedPoseFrame */
/** @typedef {import("@aerobeat/web-contracts").NormalizedPoseLandmark} NormalizedPoseLandmark */
/** @typedef {import("@aerobeat/web-contracts").AeroUpperBodyAnchorName} AeroUpperBodyAnchorName */
/** @typedef {import("@aerobeat/web-contracts").AeroBodyGridAnchorSnapshot} AeroBodyGridAnchorSnapshot */
/** @typedef {import("@aerobeat/web-contracts").AeroBodyGridCellEntry} AeroBodyGridCellEntry */
/** @typedef {import("@aerobeat/web-contracts").AeroGameplayEvidenceSnapshot} AeroGameplayEvidenceSnapshot */
/** @typedef {import("@aerobeat/web-contracts").AeroBoxingAction} AeroBoxingAction */
/** @typedef {import("@aerobeat/web-contracts").AeroCalibratedBounds} AeroCalibratedBounds */

/** @type {"aero.input.body-grid"} */
export const aeroBodyGridServiceId = "aero.input.body-grid";

const internalMeasuredNoseParallaxSymbol = Symbol.for("aerobeat.web-input.internal-measured-nose-parallax");
const minimumParallaxHeadroom = 1e-6;

/**
 * @typedef {Readonly<{
 *   calibrationId: string,
 *   sourceIdentity: string,
 *   measurementTimestampMs: number,
 *   measuredSourceFrameId: string,
 *   xDeflection: number,
 *   yDeflection: number
 * }>} InternalMeasuredNoseParallaxSample
 */

/**
 * @typedef {Object} AeroBodyGridPadding
 * @property {number} left Non-negative fraction of calibrated base width.
 * @property {number} right Non-negative fraction of calibrated base width.
 * @property {number} top Non-negative fraction of calibrated base height.
 * @property {number} bottom Non-negative fraction of calibrated base height.
 */

/**
 * @typedef {Object} AeroBodyGridSampleContext
 * @property {number} [sourceAspectRatio] Source pixel width divided by height.
 * @property {string} [sourceChangeId] Media lifecycle source identity.
 */

/**
 * @typedef {Object} AeroStraightQualificationSnapshot
 * @property {"left" | "right"} hand Athlete hand.
 * @property {number | null} semanticStartTimestampMs Start of uninterrupted measured straight pose.
 * @property {number} semanticDurationMs Current semantic straight duration.
 * @property {boolean} semanticQualified Whether semantic continuity reached 100ms.
 * @property {number | null} spatialStartTimestampMs Start of uninterrupted measured accepted-subcell occupancy.
 * @property {number} spatialDurationMs Current spatial straight duration.
 * @property {boolean} spatialQualified Whether pose plus accepted-subcell occupancy reached 100ms.
 * @property {readonly number[]} acceptedSubcellColumns Accepted 8x6 subcolumns.
 */

/**
 * @typedef {Object} AeroBodyGridServiceSnapshot
 * @property {"aerobeat/body_grid_service_snapshot"} schema Snapshot schema.
 * @property {1} version Snapshot version.
 * @property {"aero.input.body-grid"} serviceId Service ID.
 * @property {number} timestampMs Latest service timestamp.
 * @property {Readonly<Record<string, unknown>>} calibration Public calibration contract plus service display state.
 * @property {Readonly<Record<string, unknown>>} tracking Public tracking-safety contract.
 * @property {readonly AeroBodyGridAnchorSnapshot[]} anchors Latest measured anchors against retained geometry.
 * @property {readonly AeroBodyGridCellEntry[]} entries Entries produced by the latest measurement.
 * @property {AeroGameplayEvidenceSnapshot | null} latestEvidence Latest evidence: the most recent measured frame, or — while `tracking.anchorsFrozen` is true — the held last-measured frame republished under `provenance:"frozen"` with an incrementing `frozenTickId`.
 * @property {readonly AeroStraightQualificationSnapshot[]} straightQualifications Measured continuity state.
 * @property {boolean} retainedGeometryDimmed Whether retained geometry must be displayed dimmed.
 * @property {boolean} countdownFrozen Whether tracking safety freezes countdown time.
 * @property {string | null} sourceIdentity Current source/mirror/aspect identity.
 * @property {Readonly<{sampleCount: number, latestTargetTimestampMs: number | null}>} predictedDiagnostics Separate non-scoring prediction diagnostics.
 */

/**
 * @typedef {Object} AeroBodyGridService
 * @property {"aero.input.body-grid"} serviceId Service ID.
 * @property {(sample: AeroPoseRoutingSample | NormalizedPoseFrame, context?: AeroBodyGridSampleContext) => AeroBodyGridServiceSnapshot} processPoseSample Process one measured or explicitly predicted sample.
 * @property {(timestampMs: number) => AeroBodyGridServiceSnapshot} advanceTime Detect no-frame tracking loss without inventing pose evidence. While the anchors are frozen, also ticks the held-evidence publication (new frozenTickId) without touching the anchors.
 * @property {(reason?: string) => AeroBodyGridServiceSnapshot} resetCalibration Explicitly invalidate and retain dim geometry pending replacement.
 * @property {(timestampMs: number, maximumAgeMs?: number) => AeroGameplayEvidenceSnapshot | null} getFreshEvidence Return current measured evidence only when safe and fresh.
 * @property {() => readonly AeroGameplayEvidenceSnapshot[]} getEvidenceHistory Return bounded immutable measured history.
 * @property {() => AeroBodyGridServiceSnapshot} getSnapshot Return latest immutable snapshot.
 * @property {(listener: (snapshot: AeroBodyGridServiceSnapshot) => void) => () => void} subscribe Subscribe to immutable snapshots.
 * @property {() => void} destroy Destroy session-only state and subscribers.
 */

/** @typedef {{semanticStart: number | null, semanticLast: number | null, spatialStart: number | null, spatialLast: number | null}} StraightState */
/** @typedef {{point: {x: number, y: number} | null, cell: import("@aerobeat/web-contracts").AeroGridCellRef | null, subcell: import("@aerobeat/web-contracts").AeroGridCellRef | null}} AnchorHistory */
/** @typedef {{timestampMs: number, x: number, y: number}} WristMotionPoint */

let bodyGridInstanceSequence = 0;

/**
 * Create one session-only calibrated body-grid service per game instance.
 *
 * @param {{
 *   sourceAspectRatio?: number,
 *   padding?: Partial<AeroBodyGridPadding>,
 *   hysteresisRatio?: number,
 *   historyCapacity?: number,
 *   directionHistoryWindowMs?: number,
 *   directionMinimumMagnitude?: number,
 *   calibrationIdPrefix?: string,
 *   onListenerError?: (error: unknown) => void
 * }} [options] Service options.
 * @returns {AeroBodyGridService} Service.
 */
export function createAeroBodyGridService(options = {}) {
  const defaultAspect = positive(options.sourceAspectRatio, 16 / 9);
  const padding = normalizePadding(options.padding);
  const hysteresisRatio = bounded(options.hysteresisRatio, 0.025, 0, 0.2);
  const historyCapacity = Math.max(8, Math.trunc(positive(options.historyCapacity, 120)));
  const directionHistoryWindowMs = bounded(options.directionHistoryWindowMs, 180, 40, 500);
  const directionMinimumMagnitude = bounded(options.directionMinimumMagnitude, 0.12, 0.01, 2);
  const instanceId = options.calibrationIdPrefix ?? `body-grid-${++bodyGridInstanceSequence}`;
  const onListenerError = typeof options.onListenerError === "function" ? options.onListenerError : null;
  /** @type {Set<(snapshot: AeroBodyGridServiceSnapshot) => void>} */
  const listeners = new Set();
  /** @type {AeroGameplayEvidenceSnapshot[]} */
  const evidenceHistory = [];
  /** @type {Map<AeroUpperBodyAnchorName, AnchorHistory>} */
  const anchorHistory = new Map();
  /** @type {Map<"left" | "right", WristMotionPoint[]>} */
  const wristMotionHistories = new Map([
    ["left", []],
    ["right", []]
  ]);
  /** @type {Map<"left" | "right", StraightState>} */
  const straightStates = new Map([
    ["left", emptyStraightState()],
    ["right", emptyStraightState()]
  ]);
  /** @type {NormalizedPoseLandmark[][]} */
  let holdFrames = [];
  let holdStartedAt = /** @type {number | null} */ (null);
  let cooldownUntil = 0;
  let releaseObserved = true;
  let calibrationSequence = 0;
  let calibrationId = /** @type {string | null} */ (null);
  let bounds = /** @type {AeroCalibratedBounds | null} */ (null);
  let baselineNose = /** @type {{x: number, y: number} | null} */ (null);
  let calibrationState = /** @type {import("@aerobeat/web-contracts").AeroCalibrationState} */ ("uncalibrated");
  let readiness = /** @type {import("@aerobeat/web-contracts").AeroReadinessState} */ ("calibration_required");
  let invalidationReason = /** @type {string | null} */ (null);
  let sourceIdentity = /** @type {string | null} */ (null);
  let sourceAspect = defaultAspect;
  let timestampMs = 0;
  let lossStartedAt = /** @type {number | null} */ (null);
  let lossConsecutiveFails = 0;
  let lastMeasuredAt = /** @type {number | null} */ (null);
  let lastMeasuredSourceFrameKey = /** @type {string | null} */ (null);
  let lossDurationMs = 0;
  // 0.0.60 F4 anchor freeze (calibrated mid-run loss): the session keeps
  // playing, anchors hold their last positions, and the last measured frame is
  // republished as provenance:"frozen" evidence with a per-tick identity.
  let anchorsFrozen = false;
  let frozenTickId = 0;
  let heldEvidence = /** @type {AeroGameplayEvidenceSnapshot | null} */ (null);
  /** Loss-decision anchors currently below requiredConfidence (drives the per-marker dim). */
  let degradedAnchors = /** @type {AeroUpperBodyAnchorName[]} */ ([]);
  let recoveryHoldStartedAt = /** @type {number | null} */ (null);
  let recoveryHoldElapsedMs = 0;
  let recoveryInProgress = false;
  // Partial auto-recovery is a post-loss exit path, never the initial setup:
  // it only runs once this service has actually published calibration bounds.
  let recoveryArmed = false;
  /** Alias for the contracts constant; the local accumulator is named after its semantics. */
  const recoveryHoldMsContract = recoveryHoldMs;
  let allRequiredAnchorsVisible = false;
  let trackingPaused = false;
  let freshCalibrationRequired = true;
  let latestEvidence = /** @type {AeroGameplayEvidenceSnapshot | null} */ (null);
  /** @type {AeroBodyGridAnchorSnapshot[]} */
  let latestAnchors = [];
  /** @type {AeroBodyGridCellEntry[]} */
  let latestEntries = [];
  let predictedSampleCount = 0;
  let latestPredictedTimestamp = /** @type {number | null} */ (null);
  let latestMeasuredNoseParallax = /** @type {InternalMeasuredNoseParallaxSample | null} */ (null);
  let destroyed = false;
  let latestSnapshot = buildSnapshot();

  /** @returns {AeroBodyGridServiceSnapshot} */
  function buildSnapshot() {
    const holdProgressMs = holdStartedAt === null ? 0 : Math.min(calibrationDefaults.holdDurationMs, Math.max(0, timestampMs - holdStartedAt));
    const cooldownRemainingMs = Math.max(0, cooldownUntil - timestampMs);
    const calibration = {
      schema: "aerobeat/calibration_snapshot",
      version: 1,
      state: destroyed ? "invalidated" : calibrationState,
      readiness: destroyed ? "destroyed" : readiness,
      calibrationId,
      timestampMs,
      holdDurationMs: calibrationDefaults.holdDurationMs,
      holdProgressMs,
      cooldownRemainingMs,
      releaseRequired: !releaseObserved,
      bounds,
      grid: athleteBodyGrid4x3,
      subgrid: athleteBodySubgrid8x6,
      invalidationReason
    };
    const tracking = {
      schema: "aerobeat/tracking_safety_snapshot",
      version: 1,
      timestampMs,
      lossThresholdMs: calibrationDefaults.trackingLossPauseMs,
      lossDurationMs,
      allRequiredAnchorsVisible,
      gameplayPaused: trackingPaused,
      freshCalibrationRequired,
      anchorsFrozen,
      degradedAnchors: [...degradedAnchors],
      recoveryInProgress
    };
    return deepFreeze({
      schema: "aerobeat/body_grid_service_snapshot",
      version: 1,
      serviceId: aeroBodyGridServiceId,
      timestampMs,
      calibration,
      tracking,
      anchors: latestAnchors,
      entries: latestEntries,
      latestEvidence,
      straightQualifications: qualificationSnapshots(timestampMs, straightStates),
      retainedGeometryDimmed: bounds !== null && (freshCalibrationRequired || calibrationState === "recalibrating" || calibrationState === "tracking_lost" || calibrationState === "invalidated"),
      countdownFrozen: trackingPaused,
      sourceIdentity,
      predictedDiagnostics: {
        sampleCount: predictedSampleCount,
        latestTargetTimestampMs: latestPredictedTimestamp
      }
    });
  }

  /** @returns {AeroBodyGridServiceSnapshot} */
  function publish() {
    latestSnapshot = buildSnapshot();
    for (const listener of [...listeners]) {
      notifyListener(listener, latestSnapshot);
    }
    return latestSnapshot;
  }

  /** @param {(snapshot: AeroBodyGridServiceSnapshot) => void} listener @param {AeroBodyGridServiceSnapshot} snapshot */
  function notifyListener(listener, snapshot) {
    try {
      listener(snapshot);
    } catch (error) {
      if (onListenerError !== null) {
        try {
          onListenerError(error);
        } catch {
          // Observer diagnostics must not break calibrated input processing.
        }
      }
    }
  }

  /**
   * Full calibration invalidation: source change, manual reset, or an
   * uncalibrated tracking loss. A CALIBRATED mid-run tracking loss never
   * reaches this function — triggerTrackingPause routes it to
   * enterTrackingFreeze instead, because the anchor freeze keeps the
   * calibration, its bounds, and its latest anchors intact.
   *
   * @param {string} reason
   */
  function invalidateCalibration(reason) {
    calibrationState = reason === "tracking_lost" ? "tracking_lost" : "invalidated";
    readiness = reason === "tracking_lost" ? "paused_tracking" : "calibration_required";
    invalidationReason = reason;
    freshCalibrationRequired = true;
    latestEvidence = null;
    latestEntries = [];
    latestMeasuredNoseParallax = null;
    holdStartedAt = null;
    holdFrames = [];
    releaseObserved = true;
    cooldownUntil = 0;
    // Partial auto-recovery is only for tracking losses: the player was lost
    // mid-song and the same calibration bounds are still valid. Source changes,
    // badge resets, and other invalidations require a full T-pose recalibration
    // because the geometry itself has changed.
    recoveryArmed = reason === "tracking_lost" && bounds !== null;
    // A full invalidation voids any in-flight anchor freeze (the held frame
    // belonged to a calibration generation that is going away).
    anchorsFrozen = false;
    frozenTickId = 0;
    degradedAnchors = [];
    heldEvidence = null;
    resetLossAndRecoveryClocks();
    resetMeasuredHistories();
  }

  /**
   * Enter the anchor freeze (0.0.60 F4, calibrated mid-run loss). Consequence
   * of the tracking-loss gate CHANGES from pause to freeze when calibrated:
   * - readiness stays "countdown"; trackingPaused and freshCalibrationRequired
   *   stay false; the calibration generation and bounds are untouched;
   * - latestAnchors and the held frame keep the last measured positions, so
   *   the markers freeze at their last location;
   * - calibrationState reads "tracking_lost" so the grid's retained-geometry
   *   debug dim applies, while the per-marker dim reads degradedAnchors;
   * - the last measured frame is republished as provenance:"frozen" evidence
   *   on every subsequent tick, so scoring stays live on the held positions.
   *
   * The degraded set comes from the caller: a failing measured sample
   * already refreshed it from the current frame's confidences, a no-frame
   * trigger keeps the last measured set, and an empty set (player absent,
   * nothing below-gate on record) counts every loss-decision anchor as
   * degraded.
   */
  function enterTrackingFreeze() {
    anchorsFrozen = true;
    frozenTickId = 0;
    calibrationState = "tracking_lost";
    // Markers freeze at their last position: the failing frame that tripped
    // the gate (or the preceding failing frames) already left invalid anchor
    // entries in the live list, so restore the held frame's anchors for the
    // published snapshot. The held anchor snapshots are the byte-identical
    // objects the good frame originally published.
    if (heldEvidence !== null) {
      latestAnchors = heldEvidence.anchors;
    }
    if (degradedAnchors.length === 0) {
      degradedAnchors = [...lossDecisionAnchorNames];
    }
  }

  /**
   * Exit the anchor freeze on the first passing sample (all loss-decision
   * anchors back above the gate): normal measured frames resume on the very
   * next good frame — no hold, no gesture, no T-pose. updateCalibration then
   * reconciles the calibration state (restoring "cooldown" if the
   * post-calibration window is still open).
   */
  function clearTrackingFreeze() {
    anchorsFrozen = false;
    frozenTickId = 0;
    degradedAnchors = [];
    calibrationState = "calibrated";
    readiness = "countdown";
  }

  /**
   * Republish the held last-measured frame as the latest evidence under a
   * fresh per-tick identity. The held position data, calibrationId,
   * measuredSourceFrameId, and measurementTimestampMs stay byte-identical to
   * the last measured frame (a frozen frame is never a re-stamped measured
   * frame); only frozenTickId advances, so every frozen publication is a
   * distinct per-tick identity the coordinator can re-evaluate new events
   * against. Frozen frames carry no new semantic or motion evidence, and
   * they never enter the measured evidence history.
   */
  function publishFrozenEvidence() {
    if (heldEvidence === null || calibrationId === null) {
      return;
    }
    frozenTickId += 1;
    latestEvidence = deepFreeze({
      schema: "aerobeat/gameplay_evidence_snapshot",
      version: 1,
      calibrationId,
      measuredSourceFrameId: heldEvidence.measuredSourceFrameId,
      measurementTimestampMs: heldEvidence.measurementTimestampMs,
      provenance: "frozen",
      frozenTickId,
      activeBoxingActions: [],
      anchors: heldEvidence.anchors,
      entries: []
    });
  }

  /**
   * The tracking-loss gate has tripped. Calibrated (bounds published and a
   * held frame available): enter the anchor freeze instead of pausing.
   * Uncalibrated (or no held frame): the old full-pause +
   * fresh-calibration path, unchanged.
   *
   * @param {number} sampleTimestamp
   */
  function triggerTrackingPause(sampleTimestamp) {
    timestampMs = Math.max(timestampMs, sampleTimestamp);
    lossDurationMs = Math.max(calibrationDefaults.trackingLossPauseMs, lossDurationMs);
    if (bounds === null || heldEvidence === null) {
      trackingPaused = true;
      invalidateCalibration("tracking_lost");
      return;
    }
    if (anchorsFrozen) {
      // Already frozen: the gate stays latched and the loss window keeps
      // counting; the per-tick republish happens at the publish sites.
      return;
    }
    enterTrackingFreeze();
  }

  /** Resets both loss and recovery hysteresis clocks. */
  function resetLossAndRecoveryClocks() {
    lossStartedAt = null;
    lossConsecutiveFails = 0;
    lossDurationMs = 0;
    recoveryHoldStartedAt = null;
    recoveryHoldElapsedMs = 0;
    recoveryInProgress = false;
  }

  /** @param {number} sampleTimestamp */
  function commitTrackingRecovery(sampleTimestamp) {
    // Partial auto-recovery: anchors are visible and stable, so clear the
    // recalibration requirement WITHOUT minting a new calibrationId. Bounds stay
    // byte-identical; the invalidated-ID guard in the coordinator keeps this
    // recovery from silently resuming on the old calibration. Only reachable
    // while already calibrated (bounds non-null), so committed bounds never change.
    freshCalibrationRequired = false;
    trackingPaused = false;
    calibrationState = "calibrated";
    readiness = "countdown";
    invalidationReason = null;
    holdStartedAt = null;
    holdFrames = [];
    resetLossAndRecoveryClocks();
  }

  /** @param {AeroPoseRoutingSample | NormalizedPoseFrame} input @param {AeroBodyGridSampleContext} context */
  function processPoseSample(input, context = {}) {
    if (destroyed) {
      return latestSnapshot;
    }
    const sample = normalizeSample(input);
    if (sample === null) {
      latestMeasuredNoseParallax = null;
      return latestSnapshot;
    }
    if (sample.provenance === "predicted") {
      predictedSampleCount += 1;
      latestPredictedTimestamp = sample.targetTimestampMs;
      return publish();
    }
    if (lastMeasuredAt !== null && sample.measurementTimestampMs < lastMeasuredAt) {
      latestMeasuredNoseParallax = null;
      resetWristMotionHistories();
      return latestSnapshot;
    }
    if (
      (lastMeasuredAt !== null && sample.measurementTimestampMs === lastMeasuredAt) ||
      `${sample.sourceId}\u0000${sample.measuredSourceFrameId}` === lastMeasuredSourceFrameKey
    ) {
      latestMeasuredNoseParallax = null;
      return latestSnapshot;
    }
    if (lastMeasuredAt !== null && sample.measurementTimestampMs - lastMeasuredAt >= calibrationDefaults.trackingLossPauseMs) {
      // A full silent window counts as the required consecutive misses, so
      // the loss clock latches immediately without inventing intermediate samples.
      lossConsecutiveFails = trackingLossHysteresisConsecutiveFails;
      lossStartedAt = lastMeasuredAt;
      lossDurationMs = sample.measurementTimestampMs - lastMeasuredAt;
      triggerTrackingPause(sample.measurementTimestampMs);
    }
    timestampMs = Math.max(timestampMs, sample.measurementTimestampMs);
    lastMeasuredAt = sample.measurementTimestampMs;
    lastMeasuredSourceFrameKey = `${sample.sourceId}\u0000${sample.measuredSourceFrameId}`;
    const nextAspect = positive(context.sourceAspectRatio, sourceAspect);
    const nextSourceIdentity = `media:${context.sourceChangeId ?? ""}|pose:${sample.sourceId}|mirror:${sample.mirrored ? "1" : "0"}|aspect:${nextAspect}`;
    if (sourceIdentity === null) {
      sourceIdentity = nextSourceIdentity;
      sourceAspect = nextAspect;
    } else if (sourceIdentity !== nextSourceIdentity) {
      sourceIdentity = nextSourceIdentity;
      sourceAspect = nextAspect;
      trackingPaused = calibrationId !== null;
      invalidateCalibration("source_changed");
    }

    const landmarks = measuredLandmarkMap(sample);
    const lossAnchorsVisible = lossDecisionAnchorNames.every((name) => (landmarks.get(name)?.confidence ?? 0) >= calibrationDefaults.requiredConfidence);
    allRequiredAnchorsVisible = lossAnchorsVisible && upperBodyAnchorNames.every((name) => (landmarks.get(name)?.confidence ?? 0) >= calibrationDefaults.requiredConfidence);
    if (lossAnchorsVisible) {
      // Passing sample: reset the consecutive-fail counter and the 750 ms clock.
      lossStartedAt = null;
      lossConsecutiveFails = 0;
      lossDurationMs = 0;
      degradedAnchors = [];
      if (anchorsFrozen) {
        // 0.0.60 F4: the very next good frame clears the anchor freeze — no
        // hold, no gesture, no T-pose. Normal measured frames resume from
        // this sample.
        clearTrackingFreeze();
      } else if (freshCalibrationRequired && recoveryArmed) {
        updateRecoveryHold(sample.measurementTimestampMs);
      }
    } else {
      // The per-anchor degraded set tracks the latest measured frame even
      // before the freeze latches, so the per-marker dim shows the dropout
      // as it happens; an anchor leaves the set when it passes again.
      degradedAnchors = degradedSetFromLandmarks(landmarks);
      lossConsecutiveFails += 1;
      lossStartedAt ??= sample.measurementTimestampMs;
      lossDurationMs = Math.max(0, sample.measurementTimestampMs - lossStartedAt);
      latestEntries = [];
      resetWristMotionHistories();
      resetRecoveryHold();
      // The loss clock only starts accumulating after the hysteresis latch:
      // a single dropped frame can never trip the pause window.
      if (lossConsecutiveFails >= trackingLossHysteresisConsecutiveFails) {
        if (lossDurationMs >= calibrationDefaults.trackingLossPauseMs) {
          triggerTrackingPause(sample.measurementTimestampMs);
        }
      }
    }

    updateCalibration(sample, landmarks);
    if (calibrationId !== null && bounds !== null) {
      mapMeasuredAnchors(sample, landmarks);
    } else {
      latestAnchors = [];
      latestEntries = [];
    }
    return publish();
  }

  /** @param {number} sampleTimestamp */
  function updateRecoveryHold(sampleTimestamp) {
    // Partial auto-recovery accumulates measured time while the loss-decision
    // anchors stay visible; the same hysteresis discipline applies, so any
    // failed sample restarts the hold from zero.
    if (recoveryHoldStartedAt === null) {
      recoveryHoldStartedAt = sampleTimestamp;
    }
    recoveryHoldElapsedMs = sampleTimestamp - recoveryHoldStartedAt;
    recoveryInProgress = true;
    if (recoveryHoldElapsedMs >= recoveryHoldMsContract) {
      commitTrackingRecovery(sampleTimestamp);
    }
  }

  function resetRecoveryHold() {
    recoveryHoldStartedAt = null;
    recoveryHoldElapsedMs = 0;
    recoveryInProgress = false;
  }

  /** @param {AeroPoseRoutingSample} sample @param {Map<string, NormalizedPoseLandmark>} landmarks */
  function updateCalibration(sample, landmarks) {
    const qualified = allRequiredAnchorsVisible && qualifiesTPose(landmarks);
    if (calibrationId !== null && !releaseObserved && !qualified) {
      releaseObserved = true;
    }
    if (calibrationId !== null && timestampMs < cooldownUntil) {
      calibrationState = "cooldown";
      readiness = trackingPaused ? "paused_tracking" : "countdown";
      return;
    }
    if (calibrationId !== null && !releaseObserved) {
      calibrationState = "cooldown";
      readiness = trackingPaused ? "paused_tracking" : "countdown";
      return;
    }
    if (calibrationId !== null && !freshCalibrationRequired && !qualified) {
      // Keep the post-loss auto-recovery state (calibrated/countdown) intact;
      // only reconcile a cooldown or plain calibrated state here.
      if (!trackingPaused && (calibrationState === "cooldown" || calibrationState === "calibrated")) {
        calibrationState = "calibrated";
        readiness = "countdown";
      } else if (calibrationState === "recalibrating") {
        // 0.0.60 W6 (in0o): this non-hold frame interrupted an in-progress
        // mid-song recalibration hold; cancel the incomplete hold and
        // reconcile back to the healthy state the player left (the bounds
        // are still valid — the aborted hold committed nothing).
        holdStartedAt = null;
        holdFrames = [];
        calibrationState = "calibrated";
        readiness = "countdown";
      }
      return;
    }
    if (!qualified) {
      holdStartedAt = null;
      holdFrames = [];
      if (freshCalibrationRequired) {
        calibrationState = trackingPaused && !allRequiredAnchorsVisible
          ? "tracking_lost"
          : bounds === null ? "uncalibrated" : "recalibrating";
        readiness = trackingPaused ? "paused_tracking" : "calibration_required";
      }
      return;
    }
    if (holdStartedAt === null) {
      holdStartedAt = sample.measurementTimestampMs;
      holdFrames = [];
    }
    holdFrames.push([...landmarks.values()].map((item) => ({ ...item })));
    calibrationState = bounds === null ? "holding" : "recalibrating";
    readiness = trackingPaused ? "paused_tracking" : "calibration_required";
    if (sample.measurementTimestampMs - holdStartedAt < calibrationDefaults.holdDurationMs) {
      return;
    }
    const averaged = averageLandmarks(holdFrames);
    const nextGeometry = calibratedGeometry(averaged, sourceAspect, padding);
    if (nextGeometry === null) {
      holdStartedAt = null;
      holdFrames = [];
      invalidationReason = "invalid_calibration_geometry";
      return;
    }
    calibrationSequence += 1;
    calibrationId = `${instanceId}-${calibrationSequence}`;
    bounds = nextGeometry.bounds;
    baselineNose = nextGeometry.nose;
    invalidationReason = null;
    freshCalibrationRequired = false;
    trackingPaused = false;
    calibrationState = "cooldown";
    readiness = "countdown";
    releaseObserved = false;
    cooldownUntil = sample.measurementTimestampMs + calibrationDefaults.cooldownDurationMs;
    holdStartedAt = null;
    holdFrames = [];
    resetMeasuredHistories();
  }

  /** @param {AeroPoseRoutingSample} sample @param {Map<string, NormalizedPoseLandmark>} landmarks */
  function mapMeasuredAnchors(sample, landmarks) {
    latestMeasuredNoseParallax = null;
    if (calibrationId === null || bounds === null) {
      return;
    }
    const scoringValid = allRequiredAnchorsVisible && !trackingPaused && !freshCalibrationRequired;
    /** @type {AeroBodyGridAnchorSnapshot[]} */
    const anchors = [];
    /** @type {AeroBodyGridCellEntry[]} */
    const entries = [];
    /** @type {Map<AeroUpperBodyAnchorName, AeroBodyGridAnchorSnapshot>} */
    const byName = new Map();
    if (scoringValid) {
      recordWristMotionSamples(sample.measurementTimestampMs, landmarks, bounds);
    } else {
      resetWristMotionHistories();
    }
    for (const name of upperBodyAnchorNames) {
      const landmark = landmarks.get(name);
      if (!landmark) {
        continue;
      }
      const athlete = cameraPreviewToAthlete(landmark);
      const raw = normalizeAgainstBounds(athlete, bounds);
      const history = anchorHistory.get(name) ?? { point: null, cell: null, subcell: null };
      const signalValid = scoringValid && landmark.confidence >= calibrationDefaults.requiredConfidence;
      const cell = signalValid ? hystereticGridCell(raw, athleteBodyGrid4x3, history.cell, hysteresisRatio) : null;
      const subcell = signalValid ? hystereticGridCell(raw, athleteBodySubgrid8x6, history.subcell, hysteresisRatio) : null;
      const inGrid = signalValid && normalizedPointToGridCell(raw, athleteBodyGrid4x3) !== null;
      // D1(b): off-grid anchors are now staged — valid follows signal validity
      // (scoringValid + confidence gate) with finite raw x/y, so the app keeps
      // rendering and tracking the marker and its equipment outside the
      // calibrated grid. cell/subcell stay gated on inGrid, so an off-grid
      // point can never occupy a grid cell or produce a scoring entry.
      const anchor = /** @type {AeroBodyGridAnchorSnapshot} */ ({
        schema: "aerobeat/body_grid_anchor_snapshot",
        version: 1,
        anchor: name,
        calibrationId,
        measurementTimestampMs: sample.measurementTimestampMs,
        valid: signalValid,
        confidence: clamp01(landmark.confidence),
        rawX: raw.x,
        rawY: raw.y,
        x: signalValid ? raw.x : null,
        y: signalValid ? raw.y : null,
        cell: inGrid ? cell?.id ?? null : null,
        subcell: inGrid ? subcell?.id ?? null : null
      });
      anchors.push(anchor);
      byName.set(name, anchor);
      if ((name === "nose" || name === "left_wrist" || name === "right_wrist") && inGrid && history.cell !== null && cell !== null && history.cell.id !== cell.id && history.point !== null) {
        const direction = name === "nose"
          ? cardinalDirection(history.point, raw)
          : rollingWristDirection(name === "left_wrist" ? "left" : "right", sample.measurementTimestampMs);
        const entry = {
          schema: /** @type {const} */ ("aerobeat/body_grid_cell_entry"),
          version: /** @type {const} */ (1),
          anchor: name,
          calibrationId,
          measurementTimestampMs: sample.measurementTimestampMs,
          fromCell: history.cell.id,
          toCell: cell.id
        };
        entries.push(direction === null
          ? { ...entry, provenance: "measured" }
          : { ...entry, direction, provenance: "measured" });
      }
      anchorHistory.set(name, {
        point: inGrid ? raw : null,
        cell: inGrid ? cell : null,
        subcell: inGrid ? subcell : null
      });
    }
    if (anchorsFrozen) {
      // Freeze: failing/absent frames never clobber the held anchors or
      // positions. Republish the held frame under a fresh per-tick identity
      // so the coordinator keeps re-evaluating new events against it.
      publishFrozenEvidence();
      return;
    }
    latestAnchors = anchors;
    latestEntries = entries;
    if (scoringValid) {
      latestMeasuredNoseParallax = measuredNoseParallaxSample(sample, landmarks.get("nose"));
    }
    if (!scoringValid) {
      latestEvidence = null;
      resetStraightStates();
      return;
    }
    const actions = detectBoxingActions(sample, landmarks, byName);
    latestEvidence = deepFreeze({
      schema: "aerobeat/gameplay_evidence_snapshot",
      version: 1,
      calibrationId,
      measuredSourceFrameId: sample.measuredSourceFrameId,
      measurementTimestampMs: sample.measurementTimestampMs,
      provenance: "measured",
      activeBoxingActions: actions,
      anchors,
      entries
    });
    // The measured frame just published becomes the frame a future anchor
    // freeze would hold (held separately from latestEvidence, which a
    // failing frame may already have nulled by the time the gate trips).
    heldEvidence = latestEvidence;
    evidenceHistory.push(latestEvidence);
    if (evidenceHistory.length > historyCapacity) {
      evidenceHistory.splice(0, evidenceHistory.length - historyCapacity);
    }
  }

  /** @param {AeroPoseRoutingSample} sample @param {NormalizedPoseLandmark | undefined} nose */
  function measuredNoseParallaxSample(sample, nose) {
    if (
      nose === undefined ||
      nose.confidence < calibrationDefaults.requiredConfidence ||
      calibrationId === null ||
      sourceIdentity === null ||
      bounds === null ||
      baselineNose === null ||
      !allRequiredAnchorsVisible ||
      trackingPaused ||
      freshCalibrationRequired
    ) {
      return null;
    }
    const current = normalizeAgainstBounds(cameraPreviewToAthlete(nose), bounds);
    if (
      normalizedPointToGridCell(current, athleteBodyGrid4x3) === null ||
      !hasDirectionalParallaxHeadroom(baselineNose.x) ||
      !hasDirectionalParallaxHeadroom(baselineNose.y)
    ) {
      return null;
    }
    const xDeflection = directionalDeflection(current.x, baselineNose.x);
    const yDeflection = directionalDeflection(current.y, baselineNose.y);
    if (!Number.isFinite(xDeflection) || !Number.isFinite(yDeflection)) {
      return null;
    }
    return Object.freeze({
      calibrationId,
      sourceIdentity,
      measurementTimestampMs: sample.measurementTimestampMs,
      measuredSourceFrameId: sample.measuredSourceFrameId,
      xDeflection,
      yDeflection
    });
  }

  /**
   * @param {AeroPoseRoutingSample} sample
   * @param {Map<string, NormalizedPoseLandmark>} landmarks
   * @param {Map<AeroUpperBodyAnchorName, AeroBodyGridAnchorSnapshot>} anchors
   * @returns {readonly AeroBoxingAction[]}
   */
  function detectBoxingActions(sample, landmarks, anchors) {
    /** @type {AeroBoxingAction[]} */
    const actions = [];
    for (const hand of /** @type {const} */ (["left", "right"])) {
      const shoulder = landmarks.get(`${hand}_shoulder`);
      const elbow = landmarks.get(`${hand}_elbow`);
      const wrist = landmarks.get(`${hand}_wrist`);
      const wristAnchor = anchors.get(/** @type {AeroUpperBodyAnchorName} */ (`${hand}_wrist`));
      if (!shoulder || !elbow || !wrist || !wristAnchor?.valid) {
        resetStraightHand(hand);
        continue;
      }
      const elbowAngle = angleDegrees(shoulder, elbow, wrist);
      const athleteElbow = cameraPreviewToAthlete(elbow);
      const athleteWrist = cameraPreviewToAthlete(wrist);
      const dx = athleteWrist.x - athleteElbow.x;
      const dy = athleteWrist.y - athleteElbow.y;
      const straightPose = elbowAngle >= calibrationDefaults.minimumElbowAngleDeg;
      const acceptedColumns = hand === "left" ? [2, 3, 4] : [3, 4, 5];
      const spatialAccepted = straightPose && wristAnchor.subcell !== null && acceptedColumns.includes(wristAnchor.subcell % 8);
      const straight = updateStraightHand(hand, sample.measurementTimestampMs, straightPose, spatialAccepted);
      if (straight.semanticQualified) {
        actions.push(hand === "left" ? "straight_left" : "straight_right");
      } else if (elbowAngle < calibrationDefaults.minimumElbowAngleDeg && Math.abs(dx) > Math.abs(dy) * 1.15) {
        actions.push(hand === "left" ? "hook_left" : "hook_right");
      } else if (elbowAngle < calibrationDefaults.minimumElbowAngleDeg && dy < 0 && Math.abs(dy) > Math.abs(dx) * 1.05) {
        actions.push(hand === "left" ? "uppercut_left" : "uppercut_right");
      }
    }
    const nose = anchors.get("nose");
    const left = anchors.get("left_wrist");
    const right = anchors.get("right_wrist");
    if (nose?.valid && left?.valid && right?.valid && left.x !== null && left.y !== null && right.x !== null && right.y !== null && nose.x !== null && nose.y !== null) {
      const handsNearFace = Math.max(Math.abs(left.x - nose.x), Math.abs(right.x - nose.x)) <= 0.38 &&
        Math.max(Math.abs(left.y - nose.y), Math.abs(right.y - nose.y)) <= 0.34 &&
        Math.abs(left.y - right.y) <= 0.24;
      if (handsNearFace) {
        actions.push(left.x > right.x ? "crossed_guard" : "guard");
      }
      if (baselineNose !== null) {
        if (nose.y - baselineNose.y >= 0.12) {
          actions.push("squat");
        }
        const lateral = nose.x - baselineNose.x;
        if (lateral <= -0.12) {
          actions.push("weave_left");
        } else if (lateral >= 0.12) {
          actions.push("weave_right");
        }
      }
    }
    return Object.freeze(actions);
  }

  /** @param {"left" | "right"} hand @param {number} now @param {boolean} semantic @param {boolean} spatial */
  function updateStraightHand(hand, now, semantic, spatial) {
    const state = straightStates.get(hand) ?? emptyStraightState();
    updateContinuity(state, "semanticStart", "semanticLast", now, semantic);
    updateContinuity(state, "spatialStart", "spatialLast", now, spatial);
    straightStates.set(hand, state);
    return {
      semanticQualified: state.semanticStart !== null && now - state.semanticStart >= prototypeJudgementDefaults.straightQualificationMs,
      spatialQualified: state.spatialStart !== null && now - state.spatialStart >= prototypeJudgementDefaults.straightQualificationMs
    };
  }

  /** @param {"left" | "right"} hand */
  function resetStraightHand(hand) {
    straightStates.set(hand, emptyStraightState());
  }

  function resetStraightStates() {
    resetStraightHand("left");
    resetStraightHand("right");
  }

  /** @param {number} atTimestampMs @param {Map<string, NormalizedPoseLandmark>} landmarks @param {AeroCalibratedBounds} calibratedBounds */
  function recordWristMotionSamples(atTimestampMs, landmarks, calibratedBounds) {
    for (const hand of /** @type {const} */ (["left", "right"])) {
      const wrist = landmarks.get(`${hand}_wrist`);
      const shoulder = landmarks.get(`${hand}_shoulder`);
      if (!wrist || !shoulder || wrist.confidence < calibrationDefaults.requiredConfidence || shoulder.confidence < calibrationDefaults.requiredConfidence) {
        wristMotionHistories.set(hand, []);
        continue;
      }
      const wristRaw = normalizeAgainstBounds(cameraPreviewToAthlete(wrist), calibratedBounds);
      const shoulderRaw = normalizeAgainstBounds(cameraPreviewToAthlete(shoulder), calibratedBounds);
      const history = wristMotionHistories.get(hand) ?? [];
      history.push({
        timestampMs: atTimestampMs,
        x: (wristRaw.x - shoulderRaw.x) * athleteBodyGrid4x3.columns,
        y: (wristRaw.y - shoulderRaw.y) * athleteBodyGrid4x3.rows
      });
      const cutoff = atTimestampMs - directionHistoryWindowMs;
      while (history.length > 0 && history[0].timestampMs < cutoff) history.shift();
      if (history.length > 64) history.splice(0, history.length - 64);
      wristMotionHistories.set(hand, history);
    }
  }

  /** @param {"left" | "right"} hand @param {number} atTimestampMs @returns {import("@aerobeat/web-contracts").AeroBodyGridDirection | null} */
  function rollingWristDirection(hand, atTimestampMs) {
    const history = (wristMotionHistories.get(hand) ?? []).filter((point) => point.timestampMs >= atTimestampMs - directionHistoryWindowMs && point.timestampMs <= atTimestampMs);
    if (history.length < 2) return null;
    const origin = history[0].timestampMs;
    const elapsed = history.at(-1).timestampMs - origin;
    if (elapsed <= 0) return null;
    let meanTime = 0;
    let meanX = 0;
    let meanY = 0;
    for (const point of history) {
      meanTime += point.timestampMs - origin;
      meanX += point.x;
      meanY += point.y;
    }
    meanTime /= history.length;
    meanX /= history.length;
    meanY /= history.length;
    let denominator = 0;
    let numeratorX = 0;
    let numeratorY = 0;
    for (const point of history) {
      const centeredTime = point.timestampMs - origin - meanTime;
      denominator += centeredTime * centeredTime;
      numeratorX += centeredTime * (point.x - meanX);
      numeratorY += centeredTime * (point.y - meanY);
    }
    if (denominator <= Number.EPSILON) return null;
    const dx = numeratorX / denominator * elapsed;
    const dy = numeratorY / denominator * elapsed;
    if (Math.hypot(dx, dy) < directionMinimumMagnitude) return null;
    return eightWayDirection(dx, dy);
  }

  function resetWristMotionHistories() {
    wristMotionHistories.set("left", []);
    wristMotionHistories.set("right", []);
  }

  function resetMeasuredHistories() {
    anchorHistory.clear();
    resetWristMotionHistories();
    resetStraightStates();
    latestAnchors = [];
    latestEntries = [];
    latestEvidence = null;
    heldEvidence = null;
    evidenceHistory.length = 0;
  }

  /** @param {number} nextTimestamp */
  function advanceTime(nextTimestamp) {
    if (destroyed || !Number.isFinite(nextTimestamp) || nextTimestamp < timestampMs) {
      return latestSnapshot;
    }
    timestampMs = nextTimestamp;
    latestMeasuredNoseParallax = null;
    allRequiredAnchorsVisible = false;
    // No fresh measured sample arrived: the missed frame counts as one
    // consecutive failure. The latch is what admits the measured window;
    // before it the window keeps counting but cannot trip the pause.
    lossConsecutiveFails += 1;
    lossStartedAt ??= lastMeasuredAt ?? nextTimestamp;
    lossDurationMs = Math.max(0, nextTimestamp - lossStartedAt);
    resetRecoveryHold();
    if (lossConsecutiveFails >= trackingLossHysteresisConsecutiveFails &&
        lossDurationMs >= calibrationDefaults.trackingLossPauseMs) {
      triggerTrackingPause(nextTimestamp);
    }
    if (anchorsFrozen) {
      // Frozen: tick the held-evidence publication (fresh per-tick identity)
      // and keep counting the loss window; the anchors themselves are never
      // touched by a no-frame tick.
      publishFrozenEvidence();
    }
    return publish();
  }

  /** @param {string} reason */
  function resetCalibration(reason = "manual_reset") {
    if (destroyed) {
      return latestSnapshot;
    }
    trackingPaused = true;
    invalidateCalibration(reason);
    return publish();
  }

  /** @param {number} atTimestampMs @param {number} maximumAgeMs */
  function getFreshEvidence(atTimestampMs, maximumAgeMs = prototypeJudgementDefaults.checkpointFreshnessMs) {
    if (latestEvidence === null || trackingPaused || freshCalibrationRequired || !Number.isFinite(atTimestampMs)) {
      return null;
    }
    const age = atTimestampMs - latestEvidence.measurementTimestampMs;
    return age >= 0 && age <= Math.max(0, maximumAgeMs) ? latestEvidence : null;
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    calibrationState = "invalidated";
    readiness = "destroyed";
    invalidationReason = "destroyed";
    trackingPaused = true;
    freshCalibrationRequired = true;
    anchorsFrozen = false;
    frozenTickId = 0;
    degradedAnchors = [];
    heldEvidence = null;
    latestEvidence = null;
    latestMeasuredNoseParallax = null;
    baselineNose = null;
    latestAnchors = [];
    latestEntries = [];
    holdFrames = [];
    anchorHistory.clear();
    resetWristMotionHistories();
    evidenceHistory.length = 0;
    publish();
    listeners.clear();
  }

  function readMeasuredNoseParallax() {
    const sample = latestMeasuredNoseParallax;
    if (
      destroyed ||
      sample === null ||
      calibrationId === null ||
      sourceIdentity === null ||
      sample.calibrationId !== calibrationId ||
      sample.sourceIdentity !== sourceIdentity ||
      sample.measurementTimestampMs !== lastMeasuredAt ||
      trackingPaused ||
      freshCalibrationRequired ||
      !allRequiredAnchorsVisible
    ) {
      return null;
    }
    return sample;
  }

  const serviceValue = {
    serviceId: aeroBodyGridServiceId,
    processPoseSample,
    advanceTime,
    resetCalibration,
    getFreshEvidence,
    getEvidenceHistory() {
      return Object.freeze([...evidenceHistory]);
    },
    getSnapshot() {
      return latestSnapshot;
    },
    subscribe(listener) {
      if (destroyed || typeof listener !== "function") {
        return () => {};
      }
      listeners.add(listener);
      notifyListener(listener, latestSnapshot);
      return () => listeners.delete(listener);
    },
    destroy
  };
  Object.defineProperty(serviceValue, internalMeasuredNoseParallaxSymbol, {
    configurable: false,
    enumerable: false,
    get() {
      return destroyed || sourceIdentity === null ? undefined : readMeasuredNoseParallax;
    }
  });
  return serviceValue;
}

/** @param {AeroPoseRoutingSample | NormalizedPoseFrame} input @returns {AeroPoseRoutingSample | null} */
function normalizeSample(input) {
  try {
    if (input === null || typeof input !== "object") {
      return null;
    }
    if ("provenance" in input) {
      if (
        (input.provenance !== "measured" && input.provenance !== "predicted") ||
        !isNonEmptyString(input.sourceId) ||
        !isNonEmptyString(input.measuredSourceFrameId) ||
        !isNonNegativeFinite(input.measurementTimestampMs) ||
        !isNonNegativeFinite(input.targetTimestampMs) ||
        !Array.isArray(input.landmarks) ||
        typeof input.mirrored !== "boolean"
      ) {
        return null;
      }
      return input;
    }
    if (
      !isNonEmptyString(input.sourceId) ||
      !isNonNegativeFinite(input.timestampMs) ||
      !Array.isArray(input.landmarks) ||
      typeof input.mirrored !== "boolean"
    ) {
      return null;
    }
    return {
      schema: "aerobeat/pose_routing_sample",
      version: 1,
      sourceId: input.sourceId,
      routeEpoch: "measured-frame",
      measuredSourceFrameId: `measured-frame:${input.sourceId}:${input.timestampMs}`,
      targetTimestampMs: input.timestampMs,
      measurementTimestampMs: input.timestampMs,
      predictionHorizonMs: 0,
      provenance: "measured",
      landmarks: input.landmarks,
      mirrored: input.mirrored
    };
  } catch {
    return null;
  }
}

/**
 * The loss-decision anchors that are below the required confidence in a
 * measured frame — the per-anchor degraded set that drives the per-marker
 * dim. Returns an empty list for a null landmark map, or when every
 * loss-decision anchor passes the confidence gate.
 *
 * @param {Map<string, NormalizedPoseLandmark> | null} landmarks
 * @returns {AeroUpperBodyAnchorName[]}
 */
function degradedSetFromLandmarks(landmarks) {
  if (landmarks === null) {
    return [];
  }
  return lossDecisionAnchorNames.filter((name) => (landmarks.get(name)?.confidence ?? 0) < calibrationDefaults.requiredConfidence);
}

/** @param {AeroPoseRoutingSample} sample @returns {Map<string, NormalizedPoseLandmark>} */
function measuredLandmarkMap(sample) {
  /** @type {Map<string, NormalizedPoseLandmark>} */
  const map = new Map();
  const rejectedNames = new Set();
  for (const candidate of sample.landmarks) {
    if (candidate === null || typeof candidate !== "object") {
      continue;
    }
    const name = candidate.name;
    if (!upperBodyAnchorNames.includes(/** @type {AeroUpperBodyAnchorName} */ (name)) || rejectedNames.has(name)) {
      continue;
    }
    if (map.has(name)) {
      map.delete(name);
      rejectedNames.add(name);
      continue;
    }
    if (
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y) ||
      !isNormalized(candidate.confidence)
    ) {
      rejectedNames.add(name);
      continue;
    }
    map.set(name, /** @type {NormalizedPoseLandmark} */ (candidate));
  }
  return map;
}

/** @param {Map<string, NormalizedPoseLandmark>} landmarks */
function qualifiesTPose(landmarks) {
  const leftShoulder = landmarks.get("left_shoulder");
  const rightShoulder = landmarks.get("right_shoulder");
  const leftElbow = landmarks.get("left_elbow");
  const rightElbow = landmarks.get("right_elbow");
  const leftWrist = landmarks.get("left_wrist");
  const rightWrist = landmarks.get("right_wrist");
  if (!leftShoulder || !rightShoulder || !leftElbow || !rightElbow || !leftWrist || !rightWrist) {
    return false;
  }
  const shoulderWidth = distance(leftShoulder, rightShoulder);
  if (shoulderWidth <= Number.EPSILON) {
    return false;
  }
  const aligned = [
    Math.abs(leftWrist.y - leftShoulder.y) / shoulderWidth,
    Math.abs(rightWrist.y - rightShoulder.y) / shoulderWidth,
    Math.abs(leftElbow.y - leftShoulder.y) / shoulderWidth,
    Math.abs(rightElbow.y - rightShoulder.y) / shoulderWidth
  ].every((ratio) => ratio <= calibrationDefaults.wristElbowVerticalRatio);
  return aligned &&
    angleDegrees(leftShoulder, leftElbow, leftWrist) >= calibrationDefaults.minimumElbowAngleDeg &&
    angleDegrees(rightShoulder, rightElbow, rightWrist) >= calibrationDefaults.minimumElbowAngleDeg;
}

/** @param {readonly NormalizedPoseLandmark[][]} frames */
function averageLandmarks(frames) {
  /** @type {Map<string, {x: number, y: number, confidence: number, count: number}>} */
  const sums = new Map();
  for (const frame of frames) {
    for (const landmark of frame) {
      const sum = sums.get(landmark.name) ?? { x: 0, y: 0, confidence: 0, count: 0 };
      sum.x += landmark.x;
      sum.y += landmark.y;
      sum.confidence += landmark.confidence;
      sum.count += 1;
      sums.set(landmark.name, sum);
    }
  }
  /** @type {Map<string, NormalizedPoseLandmark>} */
  const averaged = new Map();
  for (const [name, sum] of sums) {
    averaged.set(name, { name, x: sum.x / sum.count, y: sum.y / sum.count, confidence: sum.confidence / sum.count });
  }
  return averaged;
}

/** @param {Map<string, NormalizedPoseLandmark>} landmarks @param {number} aspect @param {AeroBodyGridPadding} padding */
function calibratedGeometry(landmarks, aspect, padding) {
  const leftWrist = landmarks.get("left_wrist");
  const rightWrist = landmarks.get("right_wrist");
  const leftShoulder = landmarks.get("left_shoulder");
  const rightShoulder = landmarks.get("right_shoulder");
  const nose = landmarks.get("nose");
  if (!leftWrist || !rightWrist || !leftShoulder || !rightShoulder || !nose) {
    return null;
  }
  const athleteLeftWrist = cameraPreviewToAthlete(leftWrist);
  const athleteRightWrist = cameraPreviewToAthlete(rightWrist);
  const athleteLeftShoulder = cameraPreviewToAthlete(leftShoulder);
  const athleteRightShoulder = cameraPreviewToAthlete(rightShoulder);
  const athleteNose = cameraPreviewToAthlete(nose);
  const baseWidth = Math.abs(athleteLeftWrist.x - athleteRightWrist.x);
  const baseHeight = baseWidth * aspect * (athleteBodyGrid4x3.rows / athleteBodyGrid4x3.columns);
  if (!(baseWidth > Number.EPSILON) || !(baseHeight > Number.EPSILON)) {
    return null;
  }
  const centerX = (athleteLeftWrist.x + athleteRightWrist.x) / 2;
  const centerY = (athleteLeftShoulder.y + athleteRightShoulder.y) / 2;
  const bounds = {
    left: centerX - baseWidth / 2 - baseWidth * padding.left,
    right: centerX + baseWidth / 2 + baseWidth * padding.right,
    top: centerY - baseHeight / 2 - baseHeight * padding.top,
    bottom: centerY + baseHeight / 2 + baseHeight * padding.bottom
  };
  return { bounds, nose: normalizeAgainstBounds(athleteNose, bounds) };
}

/** @param {{x: number, y: number}} point @param {AeroCalibratedBounds} bounds */
function normalizeAgainstBounds(point, bounds) {
  return {
    x: (point.x - bounds.left) / (bounds.right - bounds.left),
    y: (point.y - bounds.top) / (bounds.bottom - bounds.top)
  };
}

/** @param {number} baseline */
function hasDirectionalParallaxHeadroom(baseline) {
  return Number.isFinite(baseline) && baseline > minimumParallaxHeadroom && 1 - baseline > minimumParallaxHeadroom;
}

/** @param {number} current @param {number} baseline */
function directionalDeflection(current, baseline) {
  const delta = current - baseline;
  const headroom = delta < 0 ? baseline : 1 - baseline;
  return Math.min(1, Math.max(-1, delta / headroom));
}

/**
 * @param {{x: number, y: number}} point
 * @param {import("@aerobeat/web-contracts").AeroGridDescriptor} descriptor
 * @param {import("@aerobeat/web-contracts").AeroGridCellRef | null} previous
 * @param {number} margin
 */
function hystereticGridCell(point, descriptor, previous, margin) {
  const direct = normalizedPointToGridCell(point, descriptor);
  if (direct === null || previous === null || direct.id === previous.id) {
    return direct;
  }
  const left = previous.column / descriptor.columns - margin;
  const right = (previous.column + 1) / descriptor.columns + margin;
  const top = previous.row / descriptor.rows - margin;
  const bottom = (previous.row + 1) / descriptor.rows + margin;
  return point.x >= left && point.x < right && point.y >= top && point.y < bottom ? previous : direct;
}

/** @param {{x: number, y: number}} from @param {{x: number, y: number}} to @returns {import("@aerobeat/web-contracts").AeroBodyGridDirection} */
function cardinalDirection(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) + Number.EPSILON * 8 >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "down" : "up";
}

/** @param {number} dx @param {number} dy @returns {import("@aerobeat/web-contracts").AeroBodyGridDirection} */
function eightWayDirection(dx, dy) {
  const directions = /** @type {const} */ (["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"]);
  const angle = Math.atan2(dy, dx);
  const sector = Math.floor((angle + Math.PI / 8 + Math.PI * 2) % (Math.PI * 2) / (Math.PI / 4));
  return directions[sector];
}

/** @param {StraightState} state @param {"semanticStart" | "spatialStart"} startKey @param {"semanticLast" | "spatialLast"} lastKey @param {number} now @param {boolean} active */
function updateContinuity(state, startKey, lastKey, now, active) {
  if (!active) {
    state[startKey] = null;
    state[lastKey] = null;
    return;
  }
  const last = state[lastKey];
  if (last === null || now - last > prototypeJudgementDefaults.straightContinuityGapMs || now < last) {
    state[startKey] = now;
  }
  state[lastKey] = now;
}

/** @returns {StraightState} */
function emptyStraightState() {
  return { semanticStart: null, semanticLast: null, spatialStart: null, spatialLast: null };
}

/** @param {number} now @param {Map<"left" | "right", StraightState>} states @returns {readonly AeroStraightQualificationSnapshot[]} */
function qualificationSnapshots(now, states) {
  return Object.freeze(["left", "right"].map((value) => {
    const hand = /** @type {"left" | "right"} */ (value);
    const state = states.get(hand) ?? emptyStraightState();
    const semanticDuration = state.semanticStart === null || state.semanticLast === null ? 0 : Math.max(0, state.semanticLast - state.semanticStart);
    const spatialDuration = state.spatialStart === null || state.spatialLast === null ? 0 : Math.max(0, state.spatialLast - state.spatialStart);
    return Object.freeze({
      hand,
      semanticStartTimestampMs: state.semanticStart,
      semanticDurationMs: semanticDuration,
      semanticQualified: semanticDuration >= prototypeJudgementDefaults.straightQualificationMs,
      spatialStartTimestampMs: state.spatialStart,
      spatialDurationMs: spatialDuration,
      spatialQualified: spatialDuration >= prototypeJudgementDefaults.straightQualificationMs,
      acceptedSubcellColumns: Object.freeze(hand === "left" ? [2, 3, 4] : [3, 4, 5])
    });
  }));
}

/** @param {NormalizedPoseLandmark} a @param {NormalizedPoseLandmark} b */
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** @param {NormalizedPoseLandmark} a @param {NormalizedPoseLandmark} vertex @param {NormalizedPoseLandmark} c */
function angleDegrees(a, vertex, c) {
  const firstX = a.x - vertex.x;
  const firstY = a.y - vertex.y;
  const secondX = c.x - vertex.x;
  const secondY = c.y - vertex.y;
  const denominator = Math.hypot(firstX, firstY) * Math.hypot(secondX, secondY);
  if (denominator <= Number.EPSILON) {
    return 0;
  }
  const cosine = Math.min(1, Math.max(-1, (firstX * secondX + firstY * secondY) / denominator));
  return Math.acos(cosine) * 180 / Math.PI;
}

/** @param {Partial<AeroBodyGridPadding> | undefined} value @returns {AeroBodyGridPadding} */
function normalizePadding(value) {
  return {
    left: nonNegative(value?.left, 0),
    right: nonNegative(value?.right, 0),
    top: nonNegative(value?.top, 0),
    bottom: nonNegative(value?.bottom, 0)
  };
}

/** @param {number | undefined} value @param {number} fallback */
function positive(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** @param {number | undefined} value @param {number} fallback */
function nonNegative(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** @param {number | undefined} value @param {number} fallback @param {number} minimum @param {number} maximum */
function bounded(value, fallback, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

/** @param {number} value */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** @param {unknown} value */
function isNonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** @param {unknown} value */
function isNormalized(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** @template T @param {T} value @returns {Readonly<T>} */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
