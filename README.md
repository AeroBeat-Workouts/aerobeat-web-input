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
- Seven upper-body anchors individually require confidence `>= 0.5`.
- Wrist/elbow vertical ratios are `<= 0.35`; elbow angles are `>= 130deg`.
- Qualified hold and cooldown are both 4000ms; all qualified hold samples are averaged.
- Pose release is required before refire.
- Source/media identity, mirror, or source-aspect changes invalidate scoring.
- Old bounds remain only as dim display geometry during loss/recalibration and are atomically replaced.
- Sustained loss for 500ms pauses, clears evidence, freezes countdown participation, and requires fresh calibration.

The source owns preview mirroring. Input applies exactly one public transform: camera `(x,y)` becomes athlete `(1-x,y)`. The calibrated grid is top-left row-major (`0..11`) with an 8x6 subgrid (`0..47`). Mapping never clamps; out-of-grid anchors preserve raw diagnostics and expose null scoring cells.

## Evidence contract

Only real measurements can calibrate, advance tracking safety, emit cell entries, satisfy checkpoint evidence, or accumulate the 100ms straight interval. Predictions remain separately tagged diagnostics.

Measured evidence supports:

- bounded cell/subcell hysteresis and four-cardinal in-grid transitions;
- independent semantic and spatial straight continuity with 150ms gap reset;
- semantic hook/uppercut observations;
- same-sample standard/crossed guards;
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

Validation covers predictive separation, T-pose gates/averaging/release/refire, aspect/padding, source/mirror identity, exact corners, no-clamp invalidity, hysteresis/cardinal entries, same-sample and overlapping Boxing evidence, measured straight continuity, freshness, sustained/no-frame tracking loss, reset/recalibration, immutable subscriptions, teardown, package contents, and Chromium import/calibration smoke.

Repo decisions live under `docs/decisions/`; public contributor documentation belongs in `aerobeat-web-docs` after acceptance.
