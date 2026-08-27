# aerobeat-web-input

Normalized pose-data to AeroBeat gameplay-facing input events.

## Responsibility

This repo owns device-independent input routing, fake/replay pose input, body-grid interpretation, and conversion from normalized landmark/pose data into AeroBeat Boxing and Flow input events.

It does not own camera permissions, CV model selection, vendor adapters, UI components, gameplay scoring, renderer output, content conversion, or assembly wiring.

## Public API Surface

- `src/index.js` exports input source names, event routing constants, the input router, bounded two-measurement predictor, and held-out measured-trace oracle.
- `createPoseInputRouter()` preserves legacy `routePoseFrame()` event objects exactly. Its enriched `routePoseSample()` path emits straight pulses once per measurement lineage and state/cell intents only on semantic transition. `routePoseSampleBatch()` routes both modes while counting one source sample once.
- `createPosePredictor()` requires two fresh complete, visible measurements after every reset, advances a route generation on reset, accepts only `0 < horizon <= 125ms`, clamps coordinates/displacement, decays confidence, and resets/suppresses on source, time, visibility, staleness, or direction discontinuities.
- `evaluateHeldOutPoseTrace()` down-samples a full measured trace and compares the actual stateful treatment with a matching stateful reference, reporting bounded landmark, grid-cell, event-agreement, timing, and erroneous-repeat metrics. These are scoring-readiness proxies only: this workspace has no gameplay scorer.
- Live, video, and replay feeds drive the same router boundary.

## Adjacent Repos

- `aerobeat-web-cv` produces normalized pose frames.
- `aerobeat-web-contracts` owns shared event names and pose/input shapes.
- `aerobeat-web-ui` owns visible debug, calibration, and proving-scene components.
- `aerobeat-web-gameplay` will consume routed input events.
- `aerobeat-web-assembly` wires concrete services together.

## Allowed Imports

Runtime code may import public exports from `@aerobeat/web-contracts`. Future testbed scenes may import public `aero-*` components from `@aerobeat/web-ui`. Do not import CV internals, vendor-native shapes, or sibling testbed files.

## Testbed Shape

Input testbed scenes must document live camera, video-feed, and replay-feed expectations and must use `aero-*` components for visible UI. Tests and scenes import this package through `.testbed/node_modules/@aerobeat/web-this-repo`, which is generated local state:

```bash
npm run testbed:link-self
```

Do not commit installed `node_modules` folders or generated testbed symlinks.

## Validation

Run before handoff:

```bash
npm run check
npm test
npm run test:browser
```

The current validators are placeholder-level checks for JSDoc/no-escape posture, public import boundaries, component-only scenes, and console-noise expectations.

## Documentation Handoff

Keep repo-local decisions in `docs/decisions/`. Public contributor docs belong in `aerobeat-web-docs` after the input boundary is accepted.
