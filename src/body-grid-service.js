// @ts-check

import {
  athleteBodyGrid4x3,
  athleteBodySubgrid8x6,
  calibrationDefaults,
  cameraPreviewToAthlete,
  normalizedPointToGridCell,
  prototypeJudgementDefaults,
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
 * @property {AeroGameplayEvidenceSnapshot | null} latestEvidence Latest valid measured evidence.
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
 * @property {(timestampMs: number) => AeroBodyGridServiceSnapshot} advanceTime Detect no-frame tracking loss without inventing pose evidence.
 * @property {(reason?: string) => AeroBodyGridServiceSnapshot} resetCalibration Explicitly invalidate and retain dim geometry pending replacement.
 * @property {(timestampMs: number, maximumAgeMs?: number) => AeroGameplayEvidenceSnapshot | null} getFreshEvidence Return current measured evidence only when safe and fresh.
 * @property {() => readonly AeroGameplayEvidenceSnapshot[]} getEvidenceHistory Return bounded immutable measured history.
 * @property {() => AeroBodyGridServiceSnapshot} getSnapshot Return latest immutable snapshot.
 * @property {(listener: (snapshot: AeroBodyGridServiceSnapshot) => void) => () => void} subscribe Subscribe to immutable snapshots.
 * @property {() => void} destroy Destroy session-only state and subscribers.
 */

/** @typedef {{semanticStart: number | null, semanticLast: number | null, spatialStart: number | null, spatialLast: number | null}} StraightState */
/** @typedef {{point: {x: number, y: number} | null, cell: import("@aerobeat/web-contracts").AeroGridCellRef | null, subcell: import("@aerobeat/web-contracts").AeroGridCellRef | null}} AnchorHistory */

let bodyGridInstanceSequence = 0;

/**
 * Create one session-only calibrated body-grid service per game instance.
 *
 * @param {{
 *   sourceAspectRatio?: number,
 *   padding?: Partial<AeroBodyGridPadding>,
 *   hysteresisRatio?: number,
 *   historyCapacity?: number,
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
  const instanceId = options.calibrationIdPrefix ?? `body-grid-${++bodyGridInstanceSequence}`;
  const onListenerError = typeof options.onListenerError === "function" ? options.onListenerError : null;
  /** @type {Set<(snapshot: AeroBodyGridServiceSnapshot) => void>} */
  const listeners = new Set();
  /** @type {AeroGameplayEvidenceSnapshot[]} */
  const evidenceHistory = [];
  /** @type {Map<AeroUpperBodyAnchorName, AnchorHistory>} */
  const anchorHistory = new Map();
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
  let lastMeasuredAt = /** @type {number | null} */ (null);
  let lastMeasuredSourceFrameKey = /** @type {string | null} */ (null);
  let lossDurationMs = 0;
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
      freshCalibrationRequired
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

  /** @param {string} reason */
  function invalidateCalibration(reason) {
    calibrationState = reason === "tracking_lost" ? "tracking_lost" : "invalidated";
    readiness = reason === "tracking_lost" ? "paused_tracking" : "calibration_required";
    invalidationReason = reason;
    freshCalibrationRequired = true;
    latestEvidence = null;
    latestEntries = [];
    holdStartedAt = null;
    holdFrames = [];
    releaseObserved = true;
    cooldownUntil = 0;
    resetMeasuredHistories();
  }

  /** @param {number} sampleTimestamp */
  function triggerTrackingPause(sampleTimestamp) {
    timestampMs = Math.max(timestampMs, sampleTimestamp);
    trackingPaused = true;
    lossDurationMs = Math.max(calibrationDefaults.trackingLossPauseMs, lossDurationMs);
    invalidateCalibration("tracking_lost");
  }

  /** @param {AeroPoseRoutingSample | NormalizedPoseFrame} input @param {AeroBodyGridSampleContext} context */
  function processPoseSample(input, context = {}) {
    if (destroyed) {
      return latestSnapshot;
    }
    const sample = normalizeSample(input);
    if (sample === null) {
      return latestSnapshot;
    }
    if (sample.provenance === "predicted") {
      predictedSampleCount += 1;
      latestPredictedTimestamp = sample.targetTimestampMs;
      return publish();
    }
    if (
      (lastMeasuredAt !== null && sample.measurementTimestampMs <= lastMeasuredAt) ||
      `${sample.sourceId}\u0000${sample.measuredSourceFrameId}` === lastMeasuredSourceFrameKey
    ) {
      return latestSnapshot;
    }
    if (lastMeasuredAt !== null && sample.measurementTimestampMs - lastMeasuredAt >= calibrationDefaults.trackingLossPauseMs) {
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
    allRequiredAnchorsVisible = upperBodyAnchorNames.every((name) => (landmarks.get(name)?.confidence ?? 0) >= calibrationDefaults.requiredConfidence);
    if (allRequiredAnchorsVisible) {
      lossStartedAt = null;
      lossDurationMs = 0;
    } else {
      lossStartedAt ??= sample.measurementTimestampMs;
      lossDurationMs = Math.max(0, sample.measurementTimestampMs - lossStartedAt);
      latestEntries = [];
      if (lossDurationMs >= calibrationDefaults.trackingLossPauseMs) {
        triggerTrackingPause(sample.measurementTimestampMs);
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
      calibrationState = "calibrated";
      readiness = "countdown";
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
      const anchor = /** @type {AeroBodyGridAnchorSnapshot} */ ({
        schema: "aerobeat/body_grid_anchor_snapshot",
        version: 1,
        anchor: name,
        calibrationId,
        measurementTimestampMs: sample.measurementTimestampMs,
        valid: inGrid,
        confidence: clamp01(landmark.confidence),
        rawX: raw.x,
        rawY: raw.y,
        x: inGrid ? raw.x : null,
        y: inGrid ? raw.y : null,
        cell: inGrid ? cell?.id ?? null : null,
        subcell: inGrid ? subcell?.id ?? null : null
      });
      anchors.push(anchor);
      byName.set(name, anchor);
      if ((name === "nose" || name === "left_wrist" || name === "right_wrist") && inGrid && history.cell !== null && cell !== null && history.cell.id !== cell.id && history.point !== null) {
        entries.push({
          schema: "aerobeat/body_grid_cell_entry",
          version: 1,
          anchor: name,
          calibrationId,
          measurementTimestampMs: sample.measurementTimestampMs,
          fromCell: history.cell.id,
          toCell: cell.id,
          direction: cardinalDirection(history.point, raw),
          provenance: "measured"
        });
      }
      anchorHistory.set(name, {
        point: inGrid ? raw : null,
        cell: inGrid ? cell : null,
        subcell: inGrid ? subcell : null
      });
    }
    latestAnchors = anchors;
    latestEntries = entries;
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
    evidenceHistory.push(latestEvidence);
    if (evidenceHistory.length > historyCapacity) {
      evidenceHistory.splice(0, evidenceHistory.length - historyCapacity);
    }
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

  function resetMeasuredHistories() {
    anchorHistory.clear();
    resetStraightStates();
    latestAnchors = [];
    latestEntries = [];
    latestEvidence = null;
    evidenceHistory.length = 0;
  }

  /** @param {number} nextTimestamp */
  function advanceTime(nextTimestamp) {
    if (destroyed || !Number.isFinite(nextTimestamp) || nextTimestamp < timestampMs) {
      return latestSnapshot;
    }
    timestampMs = nextTimestamp;
    if (lossStartedAt === null) {
      lossStartedAt = lastMeasuredAt ?? timestampMs;
    }
    lossDurationMs = Math.max(0, timestampMs - lossStartedAt);
    allRequiredAnchorsVisible = false;
    if (lossDurationMs >= calibrationDefaults.trackingLossPauseMs) {
      triggerTrackingPause(timestampMs);
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
    latestEvidence = null;
    latestAnchors = [];
    latestEntries = [];
    holdFrames = [];
    anchorHistory.clear();
    evidenceHistory.length = 0;
    publish();
    listeners.clear();
  }

  return {
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

/** @param {{x: number, y: number}} from @param {{x: number, y: number}} to @returns {import("@aerobeat/web-contracts").AeroCardinalDirection} */
function cardinalDirection(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) + Number.EPSILON * 8 >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "down" : "up";
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
