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
 * @typedef {Object} PoseInputRouter
 * @property {"aero.input.router"} serviceId Stable input router service ID.
 * @property {readonly PoseInputFeedKind[]} expectedFeeds Feed kinds the first proving scenes must support.
 * @property {(mode: InputGameplayMode) => void} setMode Selects the gameplay input mode.
 */

/**
 * Creates the normalized pose-data to gameplay-event router boundary.
 *
 * @returns {PoseInputRouter}
 */
export function createPoseInputRouter() {
  /** @type {InputGameplayMode} */
  let selectedMode = "boxing";

  return {
    serviceId: aeroInputRouterServiceId,
    expectedFeeds: ["live-camera", "video-feed", "replay-fixture"],
    setMode(mode) {
      selectedMode = mode;
      void selectedMode;
    }
  };
}
