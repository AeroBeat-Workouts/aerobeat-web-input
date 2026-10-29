# Preserve calibration across ordinary inference gaps

Status: input implementation and source/browser validation complete; assembly integration/release remains pending (target 0.0.152).
Bead: aerobeat-web-assembly-dvay (claimed by parent as pico; input delegate did not change its actor or status). Owner: input source; assembly owns integration/release.
Next acceptance check: assembly repins the pushed input commit and exercises slow calibration through the actual signed UI/display loop.
Coordination/diagnosis: ../aerobeat-web-assembly/.plans/2026-10-29-calibration-checklist-flicker-investigation.md.

## Observed bug

Assembly calls advanceTime after 100 ms without a newly completed pose. Input unconditionally clears the last measured checklist and allRequiredAnchorsVisible, and clears knee-required hold state. Shipped 0.0.151 replay with nine stable confidence-0.99 landmarks at 4 FPS alternates nine Seen / zero Seen and cannot commit knee calibration. The same measurements without idle ticks commit at two seconds.

## Input diagnosis (2026-10-29)

- Exact observed failure: `node scripts/validate-body-grid-service.js` with the corrected idle expectation fails at the checklist assertion: `null !== 6000` after `advanceTime(6250)` following a measured frame at 6000.
- Expected behavior: retain that real checklist until its measurement is 750 ms old, or a new measured frame replaces it.
- Execution path: measured `processPoseSample` builds `calibrationChecklist` and calls `updateCalibration`; assembly's no-frame `advanceTime` then unconditionally clears checklist/visibility and, only for knee mode, empties `holdFrames` and `holdStartedAt`.
- Most likely root cause: treating an idle publication as a failed measurement, before testing measurement age. This directly explains the assertion and repeatedly restarting knee holds at 4 FPS.
- Alternative hypotheses: model confidence or missing knees could invalidate measured frames, but cannot explain clearing a passing checklist without any new frame. Tracking hysteresis is later in the path and does not cause this unconditional clearing.
- Previous fixes: none attempted in this lane; existing tests explicitly expected the broken idle reset and need correction.
- Unknowns: signed UI acceptance and physical phone cadence remain assembly/operator checks, not input-source acceptance.
- Minimal reproduction: passing knee T-pose at 0/250/500 ms, then idle at 625 ms; old code discards its hold. A continuous measured sequence without idle ticks avoids the knee reset.
- Proposed verification: 4 FPS measured frames with 100/200 ms idle ticks per interval, both knee modes; compare committed geometry to measured-only control, check original measuredAt, measured failures, exact confidence and timeout boundaries, long silence, and resets.
- Recommended fix: guard checklist/visibility/hold expiration by last measurement age at the existing 750 ms timeout, for both modes. Leave loss counting, frozen publication, visual clearing, and measured ingestion unchanged.

Debugging record: Problem: idle calibration flicker. Observed symptom: null checklist timestamp before timeout. Root cause: unconditional idle clearing. Evidence: failing assertion plus advanceTime source. Failed approaches: none. Corrective action: age-gated expiry. Verification test: normal service regressions and browser smoke. Related component: body-grid-service. Remaining uncertainty: installed signed UI and physical phone behavior.

## Approved change

Distinguish waiting for another result from a measured failure or genuinely expired measurement. Preserve last measured checklist/visibility and hold state across ordinary gaps shorter than the existing tracking-loss timeout (750 ms). Newly measured missing/low-confidence joints still update immediately and reset an invalid hold. Real prolonged silence expires the checklist and hold. Do not fabricate measurements or refresh measuredAt/source timestamps.

Keep loss hysteresis, actual 750 ms loss behavior, frozen-equipment publication, knee visual/scoring boundaries, source/reset handling, MediaPipe options, 0.5 confidence cutoff and all scoring unchanged. Do not stop assembly advanceTime or globally defer it; it also drives existing frozen gameplay publication. Clear expired holds for both upper-body-only and knee-required calibration where necessary so stale time cannot complete calibration.

## Acceptance and tasks

1. Inspect existing tests and implement the smallest source change at advanceTime.
2. Normal regression: stable 4 FPS measured T-pose with intervening idle ticks keeps last measured checklist and commits after the real measured two-second hold, with knees required and without knees. No new hold samples or measurement timestamp changes on idle ticks.
3. Actual measured missing/low-confidence joint clears it immediately; long silence at the existing timeout expires visibility and hold; source resets remain correct. Existing loss/frozen evidence regression must stay green.
4. Run input check/unit/browser suites as relevant. Document results and update README behavior; commit/push input source.
5. Assembly repins final clean source and exercises slow calibration through the actual signed UI/display loop, then publishes verified 0.0.152 with 0.0.151 rollback and updates release docs.

No new UI, generic smoothing, threshold change, provider/model upgrade, or custom-wall support in this slice. Physical phone performance/quality remains Derrick's check.

## Input results

Tasks 1–4 complete. Task 5 remains with the assembly parent; this plan stays active for that handoff rather than claiming release acceptance.

- Product change: only `advanceTime` changed. It now expires checklist/visibility and unfinished holds at measurement age >=750 ms, for either knee mode. Earlier idle ticks retain real measured facts. Measured ingestion, loss counters/hysteresis, frozen evidence, per-tick clearing of knee visual/nose diagnostics, source invalidation, confidence cutoff, and scoring are unchanged. Existing wall-clock hold-progress display semantics are unchanged; only measured frames add averaging samples or commit.
- Normal service regression: 4 FPS measured T-pose plus idle at +100/+200 ms per interval, knees on/off, commits on measured frame at 2000 ms. A varying measured-geometry control confirms idle ticks do not change averaged bounds or shoulder Y. Checklist including measuredAt stays identical during waits.
- Other focused regressions: absent joint, .499 confidence and empty measured frames fail immediately; .5 knees pass; 749 ms retains checklist and 750 ms clears it and hold before the loss latch; prolonged silence cannot calibrate; next frame restarts hold; source/manual reset and knee-mode toggle keep reset behavior.
- `node scripts/validate-body-grid-service.js`: passed after fix. Before fix, corrected expectation failed with `null !== 6000`, confirming the observed idle-checklist defect.
- `npm run check`: passed. These repository checks explicitly describe themselves as placeholder checks; no broader static-analysis claim is made.
- `npm test`: passed all four normal unit validators: predictive pose, calibrated body-grid service (including existing sustained-loss/frozen-evidence assertions), private measured-nose parallax, eight-way Flow direction.
- `npm run test:browser`: passed Chromium public-import/calibration smoke plus 4 FPS/interleaved-idle measured-only commits in both knee modes, with no captured console warning/error.
- `npm pack --dry-run`: passed; 7 intended package files. `git diff --check`: passed.
- README documents the idle freshness behavior and focused coverage. No new gate, dependency, UI, or runtime option was added.
- Limits: Chromium tests exercise the actual input module, not the signed assembled UI, device camera, MediaPipe, or phone performance. Those remain parent/operator checks. No fix-removal counterfactual was run; the initial pre-fix corrected-checklist assertion was the bounded reproduction.
- Cleanup: no children or persistent server streams started. Both managed validation jobs completed successfully and their outputs were collected. No other repo or Bead actor was modified.

Intentional handoff files: `src/body-grid-service.js`, `scripts/validate-body-grid-service.js`, `scripts/validate-body-grid-browser.js`, `README.md`, and this parent-created plan. Commit/push result is supplied in the input delegate's handoff.
