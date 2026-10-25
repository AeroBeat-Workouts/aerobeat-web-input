# Conditional Boxing knee-visibility calibration gate

**Parent approved scope:** `../aerobeat-web-assembly/.plans/2026-10-25-boxing-heights-fixed-colliders-knee-calibration.md`. Derrick authorized implementation on 2026-10-25, but requires a screenshot and separate explicit approval **before implementing the production checklist UI**. This input owner implements only measured calibration eligibility and its minimal live read-only checklist status; the assembly owns ruleset selection and the later approved UI. Existing default: Knee strikes enabled at 0% still requires knee visibility in Boxing. Flow/knee-disabled Boxing remain unchanged. No public route or release change.

**Next acceptance check:** `node scripts/validate-body-grid-service.js` with a new test: calibrated T-pose succeeds with all seven upper-body landmarks but no knees when requirement off, fails with missing/low-confidence either knee when on, resets an ongoing 2000ms hold on a single missing-knee frame, then succeeds with both knees at >=0.5 during the same full T-pose. Check a mid-hold toggle restarts the hold and no-frame/predicted snapshots never report knee visibility as current. Existing scoring still requires measured hip+knee+ankle and is unaffected.

**Tasks:**
- [x] Add session-scoped boolean setter for knee visibility requirement, independent of knee chance; reset an in-progress hold when changed or when a knee-required frame is missing; do not change tracking-loss/recovery anchors.
- [x] Reuse the measured landmark map and calibration defaults for two knees; publish compact immutable current-frame visibility and T-pose geometry bits for future checklist without raw poses or false latched success.
- [x] Focused gate and flicker regressions; full input `npm test` passed before an added no-frame regression, then the focused validator passed again. Update input README after implementation.
- [ ] Commit and push input owner; assembly pins owner revision and wires setup/ruleset before genuine Play. `bd` ledger for the assembly is read-only due CLI v53/DB v66, so record progress here and in Git.

**Non-goals:** Production UI before screenshot approval, changing Flow evidence, knee scoring triples, 150ms scoring freshness, camera CV, source-change invalidation, or public 0.0.145.
