// @ts-check

/**
 * Input router service ID consumed through assembly wiring.
 *
 * @type {"aero.input.router"}
 */
export const aeroInputRouterServiceId = "aero.input.router";

/**
 * @typedef {"live-camera" | "video-feed" | "replay-fixture"} PoseInputFeedKind
 */

/**
 * @typedef {"boxing" | "flow"} InputGameplayMode
 */

/**
 * @typedef {import("@aerobeat/web-contracts").NormalizedPoseFrame} NormalizedPoseFrame
 * @typedef {import("@aerobeat/web-contracts").NormalizedPoseLandmark} NormalizedPoseLandmark
 * @typedef {import("@aerobeat/web-contracts").BodyGridAnchorName} BodyGridAnchorName
 * @typedef {import("@aerobeat/web-contracts").BoxingInputEvent} BoxingInputEvent
 * @typedef {import("@aerobeat/web-contracts").FlowInputEvent} FlowInputEvent
 */

/**
 * @typedef {Object} PoseInputDraftEvent
 * @property {"aero.input.draft"} schema Draft input event schema.
 * @property {1} version Draft input event schema version.
 * @property {InputGameplayMode} mode Gameplay mode targeted by the event.
 * @property {string} eventName Canonical AeroBeat browser event name.
 * @property {BoxingInputEvent | FlowInputEvent} detail Gameplay-facing draft event payload.
 */

/**
 * @typedef {Object} PoseInputRouter
 * @property {"aero.input.router"} serviceId Stable input router service ID.
 * @property {readonly PoseInputFeedKind[]} expectedFeeds Feed kinds the first proving scenes must support.
 * @property {(mode: InputGameplayMode) => void} setMode Selects the gameplay input mode.
 * @property {() => InputGameplayMode} getMode Reads the selected gameplay input mode.
 * @property {(frame: NormalizedPoseFrame) => readonly PoseInputDraftEvent[]} routePoseFrame Converts a normalized pose frame into gameplay-facing draft events.
 */

/**
 * Creates the normalized pose-data to gameplay-event router boundary.
 *
 * @param {{ mode?: InputGameplayMode }} [options]
 * @returns {PoseInputRouter}
 */
export function createPoseInputRouter(options = {}) {
  /** @type {InputGameplayMode} */
  let selectedMode = options.mode ?? "boxing";

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
      return selectedMode === "boxing" ? routeBoxingFrame(frame) : routeFlowFrame(frame);
    }
  };
}

/**
 * Runs the deterministic input proving conversion for a single frame.
 *
 * @param {NormalizedPoseFrame} frame
 * @param {InputGameplayMode} [mode]
 * @returns {readonly PoseInputDraftEvent[]}
 */
export function createPoseInputDraftEvents(frame, mode = "boxing") {
  const router = createPoseInputRouter({ mode });
  return router.routePoseFrame(frame);
}

/**
 * @param {NormalizedPoseFrame} frame
 * @returns {readonly PoseInputDraftEvent[]}
 */
function routeBoxingFrame(frame) {
  const leftWrist = findLandmark(frame, "left_wrist");
  const rightWrist = findLandmark(frame, "right_wrist");
  const nose = findLandmark(frame, "nose");
  /** @type {PoseInputDraftEvent[]} */
  const events = [];

  if (leftWrist && leftWrist.confidence >= 0.5) {
    events.push(createBoxingDraftEvent("straight_left", frame.timestampMs, leftWrist.confidence));
  }
  if (rightWrist && rightWrist.confidence >= 0.5) {
    events.push(createBoxingDraftEvent("straight_right", frame.timestampMs, rightWrist.confidence));
  }
  if (nose && nose.confidence >= 0.5) {
    events.push(createBoxingDraftEvent(
      nose.y > 0.5 ? "squat_enabled" : "guard_enabled",
      frame.timestampMs,
      nose.confidence
    ));
  }

  return events;
}

/**
 * @param {NormalizedPoseFrame} frame
 * @returns {readonly PoseInputDraftEvent[]}
 */
function routeFlowFrame(frame) {
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
function createBoxingDraftEvent(name, timestampMs, confidence) {
  return {
    schema: "aero.input.draft",
    version: 1,
    mode: "boxing",
    eventName: "aero:input:boxing-intent",
    detail: {
      name,
      timestampMs,
      confidence
    }
  };
}

/**
 * @param {NormalizedPoseFrame} frame
 * @param {BodyGridAnchorName} name
 * @returns {NormalizedPoseLandmark | undefined}
 */
function findLandmark(frame, name) {
  return frame.landmarks.find((landmark) => landmark.name === name);
}

/**
 * @param {NormalizedPoseLandmark} landmark
 * @returns {{ column: number, row: number }}
 */
function toBodyGridCell(landmark) {
  return {
    column: clampIndex(Math.floor(clamp01(landmark.x) * 4), 4),
    row: clampIndex(Math.floor(clamp01(landmark.y) * 3), 3)
  };
}

/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * @param {number} value
 * @param {number} size
 * @returns {number}
 */
function clampIndex(value, size) {
  return Math.min(size - 1, Math.max(0, value));
}
