# aerobeat-web-input

Normalized measured pose data to calibrated AeroBeat athlete-space input evidence.

## Responsibility

This repository owns device-independent pose routing, fake/replay pose input, bounded diagnostic prediction, session-only athlete calibration, calibrated 4x3/8x6 interpretation, measured Boxing/Flow evidence, and tracking-loss safety.

It does not own camera permissions, CV model selection, vendor adapters, UI components, gameplay judgement/scoring, countdown time, rendering, content conversion, or assembly policy.

## Public API

`src/index.js` is the only package entrypoint. It exports:

- `createAeroBodyGridService()` / `aeroBodyGridServiceId` for one reconnectable service per `aero-game`;
- immutable calibration, tracking, anchor, cell-entry, evidence, straight-qualification, and prediction-diagnostic snapshots;
- fresh-evidence/history queries, subscriptions, explicit reset, no-frame timeout advancement, and destroy;
- existing measured/predicted routing, predictor, and held-out oracle exports.

The prior viewport-clamped bucketing path is removed. Legacy draft routing now uses the public camera-preview-to-athlete transform and no-clamp 4x3 descriptor, so athlete-facing columns are intentionally opposed to camera-image columns.

## Calibration contract

- Automatic measured-only T-pose capture; no bootstrap and no persistence.
- Seven upper-body anchors—nose, left/right shoulders, elbows, and wrists—individually require confidence `>= 0.5`. When the composing game enables the Boxing Knee strikes calibration requirement, both measured knees also need `>= 0.5` confidence in the **same T-pose frames**, even if Knee strike chance is 0%; Flow and knee-disabled Boxing still require only the original seven. Knee calibration visibility does not replace the stricter hip+knee+ankle evidence for scoring.
- A T-pose requires nonzero shoulder width; each wrist and elbow must be within `0.35 × shoulder width` vertically of its shoulder, and each shoulder–elbow–wrist angle must be `>= 130°`. A nonzero wrist span is also needed to form the calibrated bounds.
- Qualified hold and cooldown are both **2000ms**; all qualified hold samples are averaged. The captured average shoulder center is exposed as `calibratedShoulderWorldY` in the same judge/world Y space used by measured wrist and knee evidence; a new calibration atomically replaces it alongside the bounds. Pose release is required before a later recalibration refire.
- Ordinary no-frame ticks preserve the last measured calibration checklist, visibility, and hold in both knee modes until the real measurement is **750ms** old. They do not refresh `measuredAt`, add hold samples, or commit calibration. Newly measured absent/low-confidence joints fail their gates immediately; genuine silence expires the checklist and unfinished hold.
- Source/media identity, mirror, or source-aspect changes invalidate scoring. Old bounds remain only as dim display geometry during loss/recalibration and are atomically replaced.
- Once the consecutive-failure hysteresis has latched and nose or wrist tracking has been missing for **750ms** (including a no-frame gap), the loss gate trips. With existing calibrated bounds and held evidence, the input freezes anchors instead of immediately pausing or demanding a new T-pose; the next good frame clears the freeze. Without that state, tracking pauses and requires fresh calibration.
- Malformed, duplicate-anchor, duplicate-frame, and timestamp-rollback input cannot mutate scoring truth; one failing subscriber cannot interrupt other subscribers or pose processing.

The source owns preview mirroring. Input applies exactly one public transform: camera `(x,y)` becomes athlete `(1-x,y)`. The calibrated grid is top-left row-major (`0..11`) with an 8x6 subgrid (`0..47`). Mapping never clamps; out-of-grid anchors preserve raw diagnostics and expose null scoring cells.

## Evidence contract

Only real measurements can calibrate, advance tracking safety, emit cell entries, satisfy checkpoint evidence, or accumulate the 100ms straight interval. Predictions remain separately tagged diagnostics. Optional left/right hip–knee–ankle triples are projected into unbounded calibrated athlete coordinates on *the current measured frame only*: an incomplete or low-confidence leg is omitted, and frozen frames cannot replay knee evidence. Separately, the internal top-level `latestKneeVisualPose` contains measured hip/knee geometry for visual placement with an optional measured ankle; it is cleared on unavailable/frozen frames and must never be used for scoring. The seven upper-body T-pose anchors and Flow evidence remain unchanged.

Measured evidence supports:

- bounded cell/subcell hysteresis and measured in-grid transitions;
- every valid measured wrist cell transition, with per-wrist rolling shoulder-relative motion over a bounded tunable window attaching exact eight-way direction only above the minimum-magnitude ambiguity gate;
- independent semantic and spatial straight continuity with 150ms gap reset;
- semantic hook/uppercut observations;
- same-sample ordinary guard observations for hands near face, including physically swapped wrists while preserving named wrist anchors for gameplay scoring;
- squat/weave baseline observations;
- overlapping positive observations;
- 150ms fresh checkpoint lookup and bounded transition/evidence history.

Gameplay consumes these public facts and owns authored timing, target matching, action consumption, misses, and score.

## Adjacent repositories

- `aerobeat-web-contracts` owns all shared coordinate, calibration, evidence, ruleset, and safety shapes/defaults.
- `aerobeat-web-cv` produces normalized measured pose frames.
- `aerobeat-web-video` owns browser media lifecycle and source-change identity.
- `aerobeat-web-gameplay` consumes immutable measured evidence and owns judgement.
- `aerobeat-web-ui` presents calibration/safety state without owning math.
- `aerobeat-web-assembly` creates one service per game and coordinates countdown/media lifecycle.

Runtime code imports only public `@aerobeat/web-contracts` exports. It must not import sibling internals or vendor-native shapes.

## Validation

```bash
npm run check
npm test
npm run test:browser
npm pack --dry-run
```

Validation covers predictive separation, T-pose gates/averaging/release/refire, aspect/padding, source/mirror identity, exact corners, no-clamp invalidity, hysteresis/cardinal nose entries, rolling eight-way wrist octants/cadence/smoothing/shoulder translation/ambiguity/resets, same-sample and overlapping Boxing evidence, measured straight continuity, freshness, sustained/no-frame tracking loss, reset/recalibration, immutable subscriptions, teardown, package contents, and Chromium import/calibration smoke. Service and Chromium regressions include stable 4 FPS calibration with interleaved idle ticks in both knee modes. Service checks also cover measurement-only averaging, immediate measured failures, the exact 750ms expiry boundary, prolonged silence, and source/manual resets.

Repo decisions live under `docs/decisions/`; public contributor documentation belongs in `aerobeat-web-docs` after acceptance.
