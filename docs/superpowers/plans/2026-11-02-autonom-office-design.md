# Autonom Office design implementation plan

> Execute task by task using superpowers:executing-plans. Design v0.3 is approved. Implementation is complete; the user authorized commit, push and a PR on 2026-11-02. Merge and deployment remain separate.

**Goal:** Apply the approved Office shift and scanner designs while retaining existing host, scanner, permission and print contracts.

**Architecture:** Extend shared UI components and Kit 2026 tokens. Keep domain facts in the existing Office queries and preserve old totals-dialog presentation. Add a dashboard presentation to the shift summary and an office presentation to the existing scanner setup/self-test.

**Tech stack:** React, TypeScript, CSS, Vitest, Chromium.

**Spec:** Approved design in `/Users/thevladbog/PRSOME/q/docs/design-briefs/2026-11-01-autonom-office-shift-design.md` and `markiro-design-system-reviewed-2026-11-02.fig` (v0.3).

## Constraints and review focus

- Reuse @markiro/ui tokens; office controls 44 px, compact row actions 36 px. No CDN, new dependencies or alternate token system.
- Alert icon centers on the complete title/body block. Close controls use a red 24 px vector in a 44 px target.
- Keep all nine shift tabs and conditional visibility, permissions, lazy reads, masking, civil dates, print forms, editing and conflict/late-data notices.
- A null or zero plan has no percentage; over-plan output is retained in the visible value. Empty production cannot receive a successful packaging check.
- Validation shifts have no packaging check. Missing or empty participants cannot imply all parts closed. Left participants are not closed.
- Device shares require reconciled non-zero totals. Keep device names, unknown/revoked fallbacks and role restrictions.
- The office scanner presentation must not alter floor touch sizes, scan ownership, GS comparison, saving, dirty-state logic, printing or download actions.

## Tasks

- [x] Shared UI: use vector status/close icons, center alerts, add header actions to SidePanel, add Kit-only pressed/optical rules and tokens. Verify focused ui tests and browser geometry.
- [x] Shift summary: add a dashboard metrics presentation with completion checks and device rows; retain original totals dialog, put parameters in a native disclosure, align header actions. Test valid/no-plan, empty/partial/validation and legacy-participant cases first.
- [x] Tables and filters: shared grids for scan filters, date/action pairs and table cells; keep all filters, paging and masked codes. Horizontal compact pallet actions and readable SSCC links. Run existing scan, card, review and print tests.
- [x] Scanner: explicit office presentation on WorkstationSetup/ScannerSelfTest, one header, two columns, aligned COM controls and compact test/result; preserve advanced controls in a disclosure. Test office/floor separation and existing scanner ownership/self-test suites.
- [x] Verification: scoped and package tests, ui + standalone lint/typecheck/build; consuming surface checks for shared changes; browser screenshots light/dark at 1280×800 and 1280×720 plus narrower layout. Update evidence, run diff/format checks and AST graph update where present. Report hardware/Windows and any unavailable checks separately.
