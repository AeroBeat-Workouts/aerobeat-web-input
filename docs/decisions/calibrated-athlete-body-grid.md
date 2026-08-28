# Calibrated Athlete Body Grid

## Accepted boundary

`AeroBodyGridService` is created once per connected `aero-game`; it is not a process singleton. It consumes public measured pose frames/routing samples and owns session-only T-pose calibration, calibrated athlete-space mapping, measured transition/evidence history, and tracking-loss safety. Camera acquisition, CV inference, gameplay judgement, countdown time, rendering, and assembly policy remain outside this repository.

## Coordinate and geometry formulas

Upstream owns preview mirroring. Input never mirrors from the `mirrored` flag; that flag is only part of the calibration-invalidating source identity. Public conversion is exactly:

```text
gameplayCamera = (cameraX, 1 - cameraY)
athlete = (1 - gameplayCameraX, 1 - gameplayCameraY)
        = (1 - cameraX, cameraY)
```

T-pose samples are averaged across the complete qualified four-second hold. Base grid width is averaged horizontal wrist span. For source pixel aspect `sourceWidth / sourceHeight`, normalized grid height is:

```text
height = width * sourceAspect * (3 / 4)
```

This makes the 4x3 cells square in source pixels. The grid is centered on averaged wrist midpoint X and shoulder-center Y. Optional edge padding is expressed as fractions of base width/height. Anchors normalize against these bounds without clamping; coordinates outside `[0,1)` retain raw diagnostics and have null scoring cells.

The public 4x3 and 8x6 contracts use athlete-space top-left row-major IDs. A small normalized hysteresis margin suppresses boundary jitter. Only measured in-grid-to-in-grid changes emit dominant-axis `up/right/down/left` entries; outside-to-grid movement emits no synthetic evidence.

## Calibration and safety

Production gates come from `@aerobeat/web-contracts`: seven anchors individually at confidence 0.5, wrist/elbow shoulder-relative vertical ratio at most 0.35, both elbow angles at least 130 degrees, 4000ms hold, 4000ms cooldown, release before refire, and 500ms sustained tracking loss. There is no bootstrap or persistence. Source ID, media source-change ID, mirror flag, or source aspect change invalidates scoring and retains old geometry only as a dim reference until atomic replacement.

Every tracking pause clears measured anchors, scoring evidence/history, freezes countdown participation, and requires a fresh calibration. A gap of 500ms between measured samples is treated as no-frame loss even when the host did not call the explicit clock-advance hook. Timestamp rollback, duplicate source frames, duplicate required landmark names, non-finite coordinates, and out-of-range confidence cannot rewrite measured truth. Predicted samples are counted only in separate diagnostics. They never advance calibration, tracking visibility, cell history, straight continuity, or gameplay evidence.

## Boxing evidence

The service emits positive measured observations; unrequested observations do not suppress one another. Semantic straight pose and spatial accepted-subcell continuity are tracked independently with a 100ms requirement and a 150ms maximum measurement gap. Hooks and uppercuts use measured elbow/forearm geometry. Standard/crossed guards require both wrists near the nose in the same sample. Squat and weave compare the measured nose with the calibration baseline. Gameplay remains responsible for authored windows, action consumption, binary judgement, and score.
