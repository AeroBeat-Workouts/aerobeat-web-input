// @ts-check

/** @type {"aero.input.router"} */
export const aeroInputRouterServiceId = "aero.input.router";

/** @type {readonly ["nose", "left_wrist", "left_elbow", "left_shoulder", "right_shoulder", "right_elbow", "right_wrist"]} */
export const aeroGameplayPoseLandmarkNames = Object.freeze([
  "nose",
  "left_wrist",
  "left_elbow",
  "left_shoulder",
  "right_shoulder",
  "right_elbow",
  "right_wrist"
]);

export const aeroPosePredictionMaxHorizonMs = 125;
export const aeroPosePredictionWindowCapacity = 120;

/**
 * @typedef {"live-camera" | "video-feed" | "replay-fixture"} PoseInputFeedKind
 * @typedef {"boxing" | "flow"} InputGameplayMode
 * @typedef {import("@aerobeat/web-contracts").NormalizedPoseFrame} NormalizedPoseFrame
 * @typedef {import("@aerobeat/web-contracts").NormalizedPoseLandmark} NormalizedPoseLandmark
 * @typedef {import("@aerobeat/web-contracts").AeroPoseRoutingSample} AeroPoseRoutingSample
 * @typedef {import("@aerobeat/web-contracts").BoxingInputEvent} BoxingInputEvent
 * @typedef {import("@aerobeat/web-contracts").FlowInputEvent} FlowInputEvent
 */

/**
 * @typedef {Object} PoseInputDraftEvent
 * @property {"aero.input.draft"} schema
 * @property {1} version
 * @property {InputGameplayMode} mode
 * @property {string} eventName
 * @property {BoxingInputEvent | FlowInputEvent} detail
 */

/**
 * @typedef {Object} PoseInputRouterStatus
 * @property {number} measuredSampleCount
 * @property {number} predictedSampleCount
 * @property {number} emittedEventCount
 * @property {number} measuredEventCount
 * @property {number} predictedEventCount
 * @property {number} suppressedRepeatedEventCount
 * @property {Readonly<Record<string, number>>} eventCountByIntent
 */

/**
 * @typedef {Object} PoseInputRouter
 * @property {"aero.input.router"} serviceId
 * @property {readonly PoseInputFeedKind[]} expectedFeeds
 * @property {(mode: InputGameplayMode) => void} setMode
 * @property {() => InputGameplayMode} getMode
 * @property {(frame: NormalizedPoseFrame) => readonly PoseInputDraftEvent[]} routePoseFrame
 * @property {(sample: AeroPoseRoutingSample) => readonly PoseInputDraftEvent[]} routePoseSample
 * @property {(sample: AeroPoseRoutingSample, modes?: readonly InputGameplayMode[]) => readonly PoseInputDraftEvent[]} routePoseSampleBatch
 * @property {(reason?: string) => void} reset
 * @property {() => PoseInputRouterStatus} getStatus
 */

/**
 * @typedef {Object} PosePredictorStatus
 * @property {number} measuredSampleCount
 * @property {number} predictedSampleCount
 * @property {number} resetCount
 * @property {number} sourceResetCount
 * @property {number} discontinuityCount
 * @property {number} reversalResetCount
 * @property {number} incompleteMeasurementCount
 * @property {number} insufficientHistorySuppressionCount
 * @property {number} invalidHorizonSuppressionCount
 * @property {number} lowVisibilitySuppressionCount
 * @property {number} staleSuppressionCount
 * @property {number} coordinateClampCount
 * @property {number} displacementClampCount
 * @property {number} routeGeneration
 * @property {string} routeEpoch
 * @property {number | undefined} latestMeasurementTimestampMs
 * @property {number | undefined} latestPredictionHorizonMs
 * @property {number | undefined} predictionHorizonP50Ms
 * @property {number | undefined} predictionHorizonP95Ms
 * @property {number | undefined} predictionHorizonMaxMs
 * @property {number | undefined} correctionMeanError
 * @property {number | undefined} correctionP95Error
 * @property {number | undefined} correctionMaxError
 */

/**
 * @typedef {Object} PosePredictor
 * @property {(frame: NormalizedPoseFrame) => AeroPoseRoutingSample} pushMeasuredFrame
 * @property {(targetTimestampMs: number) => AeroPoseRoutingSample | undefined} predict
 * @property {(reason?: string) => void} reset
 * @property {() => PosePredictorStatus} getStatus
 */

/**
 * @typedef {Object} PoseTraceOracleResult
 * @property {number} referenceFrameCount
 * @property {number} measuredFrameCount
 * @property {number} heldOutPredictionCount
 * @property {number | undefined} normalizedMeanJointError
 * @property {number | undefined} normalizedP95JointError
 * @property {number | undefined} normalizedMaxJointError
 * @property {number | undefined} wristNoseCellAgreement
 * @property {number | undefined} bodyGridCellAgreement
 * @property {number | undefined} intentPrecision
 * @property {number | undefined} intentRecall
 * @property {number | undefined} transitionTimingMeanErrorMs
 * @property {number} falseRepeatedEventCount
 * @property {number} suppressedPredictionCount
 */

/**
 * Creates a router whose legacy frame path remains event-for-event compatible,
 * while the routing-sample path applies gameplay-safe lineage and transition rules.
 * The former deduplicateEvents option remains accepted for caller compatibility;
 * routing samples are always stateful because predicted cadence must never inflate events.
 *
 * @param {{ mode?: InputGameplayMode, deduplicateEvents?: boolean }} [options]
 * @returns {PoseInputRouter}
 */
export function createPoseInputRouter(options = {}) {
  /** @type {InputGameplayMode} */
  let selectedMode = options.mode ?? "boxing";
  /** @type {Map<InputGameplayMode, string>} */
  const pulseLineages = new Map();
  /** @type {Map<InputGameplayMode, Set<string>>} */
  const emittedPulses = new Map();
  /** @type {Map<InputGameplayMode, Map<string, string>>} */
  const semanticStates = new Map();
  let measuredSampleCount = 0;
  let predictedSampleCount = 0;
  let emittedEventCount = 0;
  let measuredEventCount = 0;
  let predictedEventCount = 0;
  let suppressedRepeatedEventCount = 0;
  /** @type {Record<string, number>} */
  const eventCountByIntent = {};

  /**
   * @param {AeroPoseRoutingSample} sample
   * @param {readonly InputGameplayMode[]} modes
   * @returns {readonly PoseInputDraftEvent[]}
   */
  const routeBatch = (sample, modes) => {
    if (sample.provenance === "predicted") {
      predictedSampleCount += 1;
    } else {
      measuredSampleCount += 1;
    }
    /** @type {PoseInputDraftEvent[]} */
    const emitted = [];
    for (const mode of [...new Set(modes)]) {
      const events = mode === "boxing"
        ? routeStatefulBoxingSample(sample, pulseLineages, emittedPulses, semanticStates)
        : routeStatefulFlowSample(sample, semanticStates);
      const potentialCount = mode === "boxing" ? potentialBoxingEventCount(sample) : potentialFlowEventCount(sample);
      suppressedRepeatedEventCount += Math.max(0, potentialCount - events.length);
      emitted.push(...events);
    }
    for (const event of emitted) {
      emittedEventCount += 1;
      if (sample.provenance === "predicted") {
        predictedEventCount += 1;
      } else {
        measuredEventCount += 1;
      }
      const intent = eventIntent(event);
      eventCountByIntent[intent] = (eventCountByIntent[intent] ?? 0) + 1;
    }
    return emitted;
  };

  return {
    serviceId: aeroInputRouterServiceId,
    expectedFeeds: ["live-camera", "video-feed", "replay-fixture"],
    setMode(mode) {
      selectedMode = mode;
    },
    getMode() {
      return selectedMode;
    },
    routePoseFrame(frame) {
      return createLegacyPoseInputDraftEvents(frame, selectedMode);
    },
    routePoseSample(sample) {
      return routeBatch(sample, [selectedMode]);
    },
    routePoseSampleBatch(sample, modes = ["boxing", "flow"]) {
      return routeBatch(sample, modes);
    },
    reset() {
      pulseLineages.clear();
      emittedPulses.clear();
      semanticStates.clear();
    },
    getStatus() {
      return {
        measuredSampleCount,
        predictedSampleCount,
        emittedEventCount,
        measuredEventCount,
        predictedEventCount,
        suppressedRepeatedEventCount,
        eventCountByIntent: Object.freeze({ ...eventCountByIntent })
      };
    }
  };
}

/**
 * Wraps a real measurement for the enriched route. Routing owners should pass
 * their current routeEpoch; the default exists only for simple legacy callers.
 *
 * @param {NormalizedPoseFrame} frame
 * @param {{ routeEpoch?: string }} [options]
 * @returns {AeroPoseRoutingSample}
 */
export function createMeasuredPoseRoutingSample(frame, options = {}) {
  const routeEpoch = options.routeEpoch ?? "route-0";
  return {
    schema: "aerobeat/pose_routing_sample",
    version: 1,
    sourceId: frame.sourceId,
    routeEpoch,
    measuredSourceFrameId: measuredFrameId(frame, routeEpoch),
    targetTimestampMs: frame.timestampMs,
    measurementTimestampMs: frame.timestampMs,
    predictionHorizonMs: 0,
    provenance: "measured",
    landmarks: frame.landmarks,
    mirrored: frame.mirrored
  };
}

let predictorInstanceSequence = 0;

/**
 * @param {{ maxHorizonMs?: number, minConfidence?: number, maxDisplacement?: number, maxMeasurementGapMs?: number, routeEpochPrefix?: string }} [options]
 * @returns {PosePredictor}
 */
export function createPosePredictor(options = {}) {
  const maxHorizonMs = Math.min(
    aeroPosePredictionMaxHorizonMs,
    finitePositive(options.maxHorizonMs, aeroPosePredictionMaxHorizonMs)
  );
  const minConfidence = clamp01(options.minConfidence ?? 0.5);
  const maxDisplacement = finitePositive(options.maxDisplacement, 0.2);
  const maxMeasurementGapMs = finitePositive(options.maxMeasurementGapMs, 500);
  const routeEpochPrefix = options.routeEpochPrefix ?? `predictor-${++predictorInstanceSequence}`;
  /** @type {NormalizedPoseFrame | undefined} */
  let previous;
  /** @type {NormalizedPoseFrame | undefined} */
  let latest;
  let routeGeneration = 0;
  let measuredSampleCount = 0;
  let predictedSampleCount = 0;
  let resetCount = 0;
  let sourceResetCount = 0;
  let discontinuityCount = 0;
  let reversalResetCount = 0;
  let incompleteMeasurementCount = 0;
  let insufficientHistorySuppressionCount = 0;
  let invalidHorizonSuppressionCount = 0;
  let lowVisibilitySuppressionCount = 0;
  let staleSuppressionCount = 0;
  let coordinateClampCount = 0;
  let displacementClampCount = 0;
  /** @type {number[]} */
  const horizons = [];
  /** @type {number[]} */
  const correctionErrors = [];

  const currentRouteEpoch = () => `${routeEpochPrefix}-${routeGeneration}`;

  /** @param {string} reason */
  const reset = (reason = "manual") => {
    previous = undefined;
    latest = undefined;
    routeGeneration += 1;
    resetCount += 1;
    if (reason === "source") {
      sourceResetCount += 1;
    } else if (reason === "discontinuity") {
      discontinuityCount += 1;
    } else if (reason === "reversal") {
      reversalResetCount += 1;
    }
  };

  /**
   * @param {number} targetTimestampMs
   * @param {boolean} record
   * @returns {AeroPoseRoutingSample | undefined}
   */
  const evaluate = (targetTimestampMs, record) => {
    if (!previous || !latest) {
      if (record) {
        insufficientHistorySuppressionCount += 1;
      }
      return undefined;
    }
    if (!hasCompleteVisibleLandmarks(previous, minConfidence) || !hasCompleteVisibleLandmarks(latest, minConfidence)) {
      if (record) {
        lowVisibilitySuppressionCount += 1;
      }
      return undefined;
    }
    const measuredDeltaMs = latest.timestampMs - previous.timestampMs;
    const horizonMs = targetTimestampMs - latest.timestampMs;
    if (!Number.isFinite(targetTimestampMs) || measuredDeltaMs <= 0 || measuredDeltaMs > maxMeasurementGapMs) {
      if (record) {
        discontinuityCount += 1;
      }
      return undefined;
    }
    if (!(horizonMs > 0)) {
      if (record) {
        invalidHorizonSuppressionCount += 1;
      }
      return undefined;
    }
    if (horizonMs > maxHorizonMs) {
      if (record) {
        staleSuppressionCount += 1;
      }
      return undefined;
    }
    /** @type {NormalizedPoseLandmark[]} */
    const landmarks = [];
    for (const name of aeroGameplayPoseLandmarkNames) {
      const older = findLandmark(previous, name);
      const newer = findLandmark(latest, name);
      if (!older || !newer || older.confidence < minConfidence || newer.confidence < minConfidence) {
        if (record) {
          lowVisibilitySuppressionCount += 1;
        }
        return undefined;
      }
      let displacementX = ((newer.x - older.x) / measuredDeltaMs) * horizonMs;
      let displacementY = ((newer.y - older.y) / measuredDeltaMs) * horizonMs;
      const magnitude = Math.hypot(displacementX, displacementY);
      if (magnitude > maxDisplacement) {
        const scale = maxDisplacement / magnitude;
        displacementX *= scale;
        displacementY *= scale;
        if (record) {
          displacementClampCount += 1;
        }
      }
      const rawX = newer.x + displacementX;
      const rawY = newer.y + displacementY;
      const x = clamp01(rawX);
      const y = clamp01(rawY);
      if (record && (x !== rawX || y !== rawY)) {
        coordinateClampCount += 1;
      }
      const confidenceDecay = 1 - (0.5 * (horizonMs / maxHorizonMs));
      landmarks.push({
        name,
        x,
        y,
        confidence: clamp01(Math.min(older.confidence, newer.confidence) * confidenceDecay)
      });
    }
    if (record) {
      predictedSampleCount += 1;
      pushBounded(horizons, horizonMs);
    }
    const routeEpoch = currentRouteEpoch();
    return {
      schema: "aerobeat/pose_routing_sample",
      version: 1,
      sourceId: latest.sourceId,
      routeEpoch,
      measuredSourceFrameId: measuredFrameId(latest, routeEpoch),
      targetTimestampMs,
      measurementTimestampMs: latest.timestampMs,
      predictionHorizonMs: horizonMs,
      provenance: "predicted",
      landmarks,
      mirrored: latest.mirrored
    };
  };

  return {
    pushMeasuredFrame(frame) {
      measuredSampleCount += 1;
      if (!hasCompleteVisibleLandmarks(frame, minConfidence)) {
        incompleteMeasurementCount += 1;
        reset("incomplete");
        return createMeasuredPoseRoutingSample(frame, { routeEpoch: currentRouteEpoch() });
      }
      if (latest && (frame.sourceId !== latest.sourceId || frame.mirrored !== latest.mirrored)) {
        reset("source");
      } else if (latest && (frame.timestampMs <= latest.timestampMs || frame.timestampMs - latest.timestampMs > maxMeasurementGapMs)) {
        reset("discontinuity");
      } else if (previous && latest && isAbruptReversal(previous, latest, frame)) {
        reset("reversal");
      } else if (previous && latest) {
        const predictedAtMeasurement = evaluate(frame.timestampMs, false);
        if (predictedAtMeasurement) {
          pushBounded(correctionErrors, meanJointError(predictedAtMeasurement.landmarks, frame.landmarks));
        }
      }
      previous = latest;
      latest = frame;
      return createMeasuredPoseRoutingSample(frame, { routeEpoch: currentRouteEpoch() });
    },
    predict(targetTimestampMs) {
      return evaluate(targetTimestampMs, true);
    },
    reset,
    getStatus() {
      return {
        measuredSampleCount,
        predictedSampleCount,
        resetCount,
        sourceResetCount,
        discontinuityCount,
        reversalResetCount,
        incompleteMeasurementCount,
        insufficientHistorySuppressionCount,
        invalidHorizonSuppressionCount,
        lowVisibilitySuppressionCount,
        staleSuppressionCount,
        coordinateClampCount,
        displacementClampCount,
        routeGeneration,
        routeEpoch: currentRouteEpoch(),
        latestMeasurementTimestampMs: latest?.timestampMs,
        latestPredictionHorizonMs: horizons.at(-1),
        predictionHorizonP50Ms: percentile(horizons, 0.5),
        predictionHorizonP95Ms: percentile(horizons, 0.95),
        predictionHorizonMaxMs: horizons.length > 0 ? Math.max(...horizons) : undefined,
        correctionMeanError: average(correctionErrors),
        correctionP95Error: percentile(correctionErrors, 0.95),
        correctionMaxError: correctionErrors.length > 0 ? Math.max(...correctionErrors) : undefined
      };
    }
  };
}

/**
 * Replays a full-cadence measured trace through a stateful reference router and
 * compares it with the same stateful treatment router fed by 8fps measurements
 * plus predictions at omitted timestamps.
 *
 * @param {readonly NormalizedPoseFrame[]} frames
 * @param {{ measuredRateFps?: number }} [options]
 * @returns {PoseTraceOracleResult}
 */
export function evaluateHeldOutPoseTrace(frames, options = {}) {
  const intervalMs = 1000 / finitePositive(options.measuredRateFps, 8);
  const predictor = createPosePredictor({ routeEpochPrefix: "oracle-candidate" });
  const referenceRouter = createPoseInputRouter();
  const candidateRouter = createPoseInputRouter();
  /** @type {number[]} */
  const jointErrors = [];
  /** @type {Map<string, number[]>} */
  const referenceTransitions = new Map();
  /** @type {Map<string, number[]>} */
  const candidateTransitions = new Map();
  /** @type {Set<string>} */
  const emittedPulseLineages = new Set();
  let measuredFrameCount = 0;
  let heldOutPredictionCount = 0;
  let cellComparisons = 0;
  let cellMatches = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let falseRepeatedEventCount = 0;
  let suppressedPredictionCount = 0;
  let lastMeasuredTimestampMs = Number.NEGATIVE_INFINITY;

  for (const frame of [...frames].sort((a, b) => a.timestampMs - b.timestampMs)) {
    const referenceSample = createMeasuredPoseRoutingSample(frame, { routeEpoch: "oracle-reference" });
    const referenceEvents = referenceRouter.routePoseSampleBatch(referenceSample);
    recordTransitions(referenceTransitions, referenceEvents);

    /** @type {AeroPoseRoutingSample | undefined} */
    let candidateSample;
    if (frame.timestampMs - lastMeasuredTimestampMs + Number.EPSILON >= intervalMs) {
      candidateSample = predictor.pushMeasuredFrame(frame);
      lastMeasuredTimestampMs = frame.timestampMs;
      measuredFrameCount += 1;
    } else {
      candidateSample = predictor.predict(frame.timestampMs);
      if (!candidateSample) {
        suppressedPredictionCount += 1;
        falseNegative += new Set(referenceEvents.map(eventSignature)).size;
        continue;
      }
      heldOutPredictionCount += 1;
      for (const name of aeroGameplayPoseLandmarkNames) {
        const actual = findLandmark(frame, name);
        const estimate = findRoutingLandmark(candidateSample, name);
        if (actual && estimate) {
          jointErrors.push(Math.hypot(actual.x - estimate.x, actual.y - estimate.y));
        }
      }
      for (const name of ["left_wrist", "right_wrist", "nose"]) {
        const actual = findLandmark(frame, name);
        const estimate = findRoutingLandmark(candidateSample, name);
        if (actual && estimate) {
          cellComparisons += 1;
          if (sameCell(actual, estimate)) {
            cellMatches += 1;
          }
        }
      }
    }

    const candidateEvents = candidateRouter.routePoseSampleBatch(candidateSample);
    recordTransitions(candidateTransitions, candidateEvents);
    for (const event of candidateEvents) {
      if (event.mode === "boxing" && isPulseIntent(event.detail.name)) {
        const key = `${event.detail.name}:${event.detail.routeEpoch}:${event.detail.measuredSourceFrameId}`;
        if (emittedPulseLineages.has(key)) {
          falseRepeatedEventCount += 1;
        }
        emittedPulseLineages.add(key);
      }
    }
    const reference = new Set(referenceEvents.map(eventSignature));
    const candidate = new Set(candidateEvents.map(eventSignature));
    for (const signature of candidate) {
      if (reference.has(signature)) {
        truePositive += 1;
      } else {
        falsePositive += 1;
      }
    }
    for (const signature of reference) {
      if (!candidate.has(signature)) {
        falseNegative += 1;
      }
    }
  }

  const transitionErrors = transitionTimingErrors(referenceTransitions, candidateTransitions);
  return {
    referenceFrameCount: frames.length,
    measuredFrameCount,
    heldOutPredictionCount,
    normalizedMeanJointError: average(jointErrors),
    normalizedP95JointError: percentile(jointErrors, 0.95),
    normalizedMaxJointError: jointErrors.length > 0 ? Math.max(...jointErrors) : undefined,
    wristNoseCellAgreement: ratio(cellMatches, cellComparisons),
    bodyGridCellAgreement: ratio(cellMatches, cellComparisons),
    intentPrecision: ratio(truePositive, truePositive + falsePositive),
    intentRecall: ratio(truePositive, truePositive + falseNegative),
    transitionTimingMeanErrorMs: average(transitionErrors),
    falseRepeatedEventCount,
    suppressedPredictionCount
  };
}

/**
 * Legacy deterministic conversion. These objects intentionally contain no
 * routing provenance so existing Boxing/Flow consumers retain deep equality.
 *
 * @param {NormalizedPoseFrame} frame
 * @param {InputGameplayMode} [mode]
 * @returns {readonly PoseInputDraftEvent[]}
 */
export function createPoseInputDraftEvents(frame, mode = "boxing") {
  return createLegacyPoseInputDraftEvents(frame, mode);
}

/** @param {NormalizedPoseFrame} frame @param {InputGameplayMode} mode */
function createLegacyPoseInputDraftEvents(frame, mode) {
  return mode === "boxing" ? routeLegacyBoxingFrame(frame) : routeLegacyFlowFrame(frame);
}

/** @param {NormalizedPoseFrame} frame @returns {PoseInputDraftEvent[]} */
function routeLegacyBoxingFrame(frame) {
  const leftWrist = findLandmark(frame, "left_wrist");
  const rightWrist = findLandmark(frame, "right_wrist");
  const nose = findLandmark(frame, "nose");
  /** @type {PoseInputDraftEvent[]} */
  const events = [];
  if (leftWrist && leftWrist.confidence >= 0.5) {
    events.push(createLegacyBoxingDraftEvent("straight_left", frame.timestampMs, leftWrist.confidence));
  }
  if (rightWrist && rightWrist.confidence >= 0.5) {
    events.push(createLegacyBoxingDraftEvent("straight_right", frame.timestampMs, rightWrist.confidence));
  }
  if (nose && nose.confidence >= 0.5) {
    events.push(createLegacyBoxingDraftEvent(nose.y > 0.5 ? "squat_enabled" : "guard_enabled", frame.timestampMs, nose.confidence));
  }
  return events;
}

/** @param {NormalizedPoseFrame} frame @returns {PoseInputDraftEvent[]} */
function routeLegacyFlowFrame(frame) {
  /** @type {PoseInputDraftEvent[]} */
  const events = [];
  for (const anchor of ["left_wrist", "right_wrist", "nose"]) {
    const landmark = findLandmark(frame, anchor);
    if (!landmark || landmark.confidence < 0.5) {
      continue;
    }
    const cell = toBodyGridCell(landmark);
    events.push({
      schema: "aero.input.draft",
      version: 1,
      mode: "flow",
      eventName: "aero:input:flow-intent",
      detail: {
        kind: anchor === "nose" && landmark.y > 0.5 ? "squat_enabled" : "cell_entered",
        anchor,
        column: cell.column,
        row: cell.row,
        timestampMs: frame.timestampMs,
        confidence: landmark.confidence
      }
    });
  }
  return events;
}

/**
 * @param {import("@aerobeat/web-contracts").BoxingInputIntentName} name
 * @param {number} timestampMs
 * @param {number} confidence
 * @returns {PoseInputDraftEvent}
 */
function createLegacyBoxingDraftEvent(name, timestampMs, confidence) {
  return {
    schema: "aero.input.draft",
    version: 1,
    mode: "boxing",
    eventName: "aero:input:boxing-intent",
    detail: { name, timestampMs, confidence }
  };
}

/**
 * @param {AeroPoseRoutingSample} sample
 * @param {Map<InputGameplayMode, string>} pulseLineages
 * @param {Map<InputGameplayMode, Set<string>>} emittedPulses
 * @param {Map<InputGameplayMode, Map<string, string>>} semanticStates
 * @returns {PoseInputDraftEvent[]}
 */
function routeStatefulBoxingSample(sample, pulseLineages, emittedPulses, semanticStates) {
  const mode = "boxing";
  const lineage = `${sample.routeEpoch}:${sample.measuredSourceFrameId}`;
  if (pulseLineages.get(mode) !== lineage) {
    pulseLineages.set(mode, lineage);
    emittedPulses.set(mode, new Set());
  }
  const pulses = emittedPulses.get(mode) ?? new Set();
  emittedPulses.set(mode, pulses);
  const states = semanticStates.get(mode) ?? new Map();
  semanticStates.set(mode, states);
  const leftWrist = findRoutingLandmark(sample, "left_wrist");
  const rightWrist = findRoutingLandmark(sample, "right_wrist");
  const nose = findRoutingLandmark(sample, "nose");
  /** @type {PoseInputDraftEvent[]} */
  const events = [];
  for (const [intent, landmark] of [["straight_left", leftWrist], ["straight_right", rightWrist]]) {
    if (landmark && landmark.confidence >= 0.5 && !pulses.has(intent)) {
      pulses.add(intent);
      events.push(createEnrichedBoxingDraftEvent(intent, sample, landmark.confidence));
    }
  }
  if (!nose || nose.confidence < 0.5) {
    states.delete("stance");
  } else {
    const intent = nose.y > 0.5 ? "squat_enabled" : "guard_enabled";
    if (states.get("stance") !== intent) {
      states.set("stance", intent);
      events.push(createEnrichedBoxingDraftEvent(intent, sample, nose.confidence));
    }
  }
  return events;
}

/**
 * @param {AeroPoseRoutingSample} sample
 * @param {Map<InputGameplayMode, Map<string, string>>} semanticStates
 * @returns {PoseInputDraftEvent[]}
 */
function routeStatefulFlowSample(sample, semanticStates) {
  const states = semanticStates.get("flow") ?? new Map();
  semanticStates.set("flow", states);
  /** @type {PoseInputDraftEvent[]} */
  const events = [];
  for (const anchor of ["left_wrist", "right_wrist", "nose"]) {
    const landmark = findRoutingLandmark(sample, anchor);
    if (!landmark || landmark.confidence < 0.5) {
      states.delete(anchor);
      continue;
    }
    const cell = toBodyGridCell(landmark);
    const kind = anchor === "nose" && landmark.y > 0.5 ? "squat_enabled" : "cell_entered";
    const signature = `${kind}:${cell.column}:${cell.row}`;
    if (states.get(anchor) === signature) {
      continue;
    }
    states.set(anchor, signature);
    events.push({
      schema: "aero.input.draft",
      version: 1,
      mode: "flow",
      eventName: "aero:input:flow-intent",
      detail: {
        kind,
        anchor,
        column: cell.column,
        row: cell.row,
        timestampMs: sample.targetTimestampMs,
        confidence: landmark.confidence,
        ...routingMetadata(sample)
      }
    });
  }
  return events;
}

/**
 * @param {import("@aerobeat/web-contracts").BoxingInputIntentName} name
 * @param {AeroPoseRoutingSample} sample
 * @param {number} confidence
 * @returns {PoseInputDraftEvent}
 */
function createEnrichedBoxingDraftEvent(name, sample, confidence) {
  return {
    schema: "aero.input.draft",
    version: 1,
    mode: "boxing",
    eventName: "aero:input:boxing-intent",
    detail: {
      name,
      timestampMs: sample.targetTimestampMs,
      confidence,
      ...routingMetadata(sample)
    }
  };
}

/** @param {AeroPoseRoutingSample} sample */
function routingMetadata(sample) {
  return {
    provenance: sample.provenance,
    measurementTimestampMs: sample.measurementTimestampMs,
    predictionHorizonMs: sample.predictionHorizonMs,
    measuredSourceFrameId: sample.measuredSourceFrameId,
    routeEpoch: sample.routeEpoch
  };
}

/** @param {AeroPoseRoutingSample} sample */
function potentialBoxingEventCount(sample) {
  let count = 0;
  for (const name of ["left_wrist", "right_wrist", "nose"]) {
    const landmark = findRoutingLandmark(sample, name);
    if (landmark && landmark.confidence >= 0.5) {
      count += 1;
    }
  }
  return count;
}

/** @param {AeroPoseRoutingSample} sample */
function potentialFlowEventCount(sample) {
  let count = 0;
  for (const name of ["left_wrist", "right_wrist", "nose"]) {
    const landmark = findRoutingLandmark(sample, name);
    if (landmark && landmark.confidence >= 0.5) {
      count += 1;
    }
  }
  return count;
}

/** @param {PoseInputDraftEvent} event */
function eventIntent(event) {
  return event.mode === "boxing" ? event.detail.name : `${event.detail.kind}:${event.detail.anchor}`;
}

/** @param {PoseInputDraftEvent} event */
function eventSignature(event) {
  if (event.mode === "boxing") {
    return `boxing:${event.detail.name}`;
  }
  return `flow:${event.detail.kind}:${event.detail.anchor}:${event.detail.column}:${event.detail.row}`;
}

/** @param {string} intent */
function isPulseIntent(intent) {
  return intent === "straight_left" || intent === "straight_right" || intent.startsWith("uppercut_") || intent.startsWith("hook_");
}

/**
 * @param {Map<string, number[]>} target
 * @param {readonly PoseInputDraftEvent[]} events
 */
function recordTransitions(target, events) {
  for (const event of events) {
    if (event.mode === "boxing" && isPulseIntent(event.detail.name)) {
      continue;
    }
    const signature = eventSignature(event);
    const values = target.get(signature) ?? [];
    values.push(event.detail.timestampMs);
    target.set(signature, values);
  }
}

/**
 * @param {Map<string, number[]>} reference
 * @param {Map<string, number[]>} candidate
 * @returns {number[]}
 */
function transitionTimingErrors(reference, candidate) {
  /** @type {number[]} */
  const errors = [];
  for (const [signature, referenceTimes] of reference) {
    const candidateTimes = candidate.get(signature) ?? [];
    for (let index = 0; index < Math.min(referenceTimes.length, candidateTimes.length); index += 1) {
      errors.push(Math.abs(referenceTimes[index] - candidateTimes[index]));
    }
  }
  return errors;
}

/** @param {NormalizedPoseFrame} frame @param {string} routeEpoch */
function measuredFrameId(frame, routeEpoch) {
  return `${routeEpoch}:${frame.sourceId}:${frame.timestampMs}`;
}

/** @param {NormalizedPoseFrame} frame @param {string} name */
function findLandmark(frame, name) {
  return frame.landmarks.find((landmark) => landmark.name === name);
}

/** @param {AeroPoseRoutingSample} sample @param {string} name */
function findRoutingLandmark(sample, name) {
  return sample.landmarks.find((landmark) => landmark.name === name);
}

/** @param {NormalizedPoseFrame} frame @param {number} minConfidence */
function hasCompleteVisibleLandmarks(frame, minConfidence) {
  return aeroGameplayPoseLandmarkNames.every((name) => {
    const landmark = findLandmark(frame, name);
    return Boolean(landmark && landmark.confidence >= minConfidence);
  });
}

/**
 * @param {NormalizedPoseFrame} older
 * @param {NormalizedPoseFrame} middle
 * @param {NormalizedPoseFrame} newer
 */
function isAbruptReversal(older, middle, newer) {
  let reversals = 0;
  for (const name of aeroGameplayPoseLandmarkNames) {
    const a = findLandmark(older, name);
    const b = findLandmark(middle, name);
    const c = findLandmark(newer, name);
    if (!a || !b || !c) {
      continue;
    }
    const firstX = b.x - a.x;
    const firstY = b.y - a.y;
    const secondX = c.x - b.x;
    const secondY = c.y - b.y;
    if (Math.hypot(firstX, firstY) >= 0.01 && Math.hypot(secondX, secondY) >= 0.01
      && firstX * secondX + firstY * secondY < 0) {
      reversals += 1;
    }
  }
  return reversals >= 2;
}

/** @param {readonly NormalizedPoseLandmark[]} predicted @param {readonly NormalizedPoseLandmark[]} measured */
function meanJointError(predicted, measured) {
  /** @type {number[]} */
  const errors = [];
  for (const estimate of predicted) {
    const actual = measured.find((landmark) => landmark.name === estimate.name);
    if (actual) {
      errors.push(Math.hypot(actual.x - estimate.x, actual.y - estimate.y));
    }
  }
  return average(errors) ?? 0;
}

/** @param {NormalizedPoseLandmark} landmark */
function toBodyGridCell(landmark) {
  return {
    column: clampIndex(Math.floor(clamp01(landmark.x) * 4), 4),
    row: clampIndex(Math.floor(clamp01(landmark.y) * 3), 3)
  };
}

/** @param {NormalizedPoseLandmark} first @param {NormalizedPoseLandmark} second */
function sameCell(first, second) {
  const a = toBodyGridCell(first);
  const b = toBodyGridCell(second);
  return a.column === b.column && a.row === b.row;
}

/** @param {number[]} values @param {number} value */
function pushBounded(values, value) {
  values.push(value);
  if (values.length > aeroPosePredictionWindowCapacity) {
    values.shift();
  }
}

/** @param {readonly number[]} values */
function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

/** @param {readonly number[]} values @param {number} percentileValue */
function percentile(values, percentileValue) {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

/** @param {number} numerator @param {number} denominator */
function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : undefined;
}

/** @param {number} value */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** @param {number} value @param {number} size */
function clampIndex(value, size) {
  return Math.min(size - 1, Math.max(0, value));
}

/** @param {number | undefined} value @param {number} fallback */
function finitePositive(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
