# Device printer routing implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent platform tasks, with scoped review and final integration review.

**Goal:** Configure multiple local printers on Station and handheld, with one assignment per box, product duplicate and pallet purpose, durable destination retention, and usable small-screen settings/recovery.

**Architecture:** Local profiles and a three-purpose assignment map select output before rendering. Local job-attempt bindings retain destination snapshots independently of server event digests; explicit recovery can choose a compatible replacement. Existing durable print and credential barriers remain authoritative.

**Tech Stack:** React/TypeScript/shared UI, SQLite; Kotlin/Compose/Room; Vitest/Playwright/Gradle.

**Spec:** docs/superpowers/specs/2026-09-13-device-printer-routing-design.md

## Global constraints

- Offline configuration; no server printer registry. Preserve full codes, saved duplicate bytes, audit and unknown-send recovery.
- Legacy printer maps to all three purposes once. An explicit missing assignment never falls back to another printer.
- Station uses 64 px controls, 1024×768 and 1280×800; handheld uses 360×640; RU/EN and both themes. Header/footer actions stay visible while long lists scroll internally.
- Use existing transport adapters and label templates. No native-control replacement or new design tokens.
- Tests first; record actual red and green outputs. Shared dependencies rebuilt before consumer gates. Hardware and production deployment remain external acceptance.

## Task 1: Station routing model and durable output boundary (controller)

Files: `apps/station/src/lib/printer-routing.ts`, `hardware-config.ts`, `hardware.ts`, `print-destinations.ts`; focused tests; `packages/db/src/sqlite/{schema,migrations}.ts` and SQLite tests if a new table is needed.

Interface for Station consumers:

```ts
type PrintPurpose = "box" | "duplicate" | "pallet";
interface PrinterProfile {
  id: string;
  name: string;
  target: PrintTarget;
  language: PrinterLanguage;
  dpi: 203 | 300 | null;
}
interface PrinterRouting {
  printers: PrinterProfile[];
  assignments: Record<PrintPurpose, string | null>;
}
// HardwareConfig.printerRouting?: PrinterRouting is authoritative when present.
function configuredPrinterRouting(config: HardwareConfig): PrinterRouting;
function resolvePrinter(config: HardwareConfig, purpose: PrintPurpose): PrinterProfile | null;
function printerTargetKey(target: PrintTarget): string;
function serializePrinterOutput<T>(target: PrintTarget, send: () => Promise<T>): Promise<T>;
```

- [x] Write `printer-routing.test.ts` cases for three targets, one shared target, legacy all-purpose mapping, explicit null and invalid assignment (no legacy fallback), duplicate endpoint normalization and same-address serialization.
- [x] Run focused Vitest and confirm missing model fails. Implement the above pure model, strict persistence parsing and compatible one-time save. Keep legacy fields only as compatibility projection.
- [x] Add durable destination tests: first pin survives restart/profile change; different scopes/jobs cannot collide; malformed snapshot fails closed; explicit replacement creates/replaces only the requested unsent attempt. Bind before sending and keep original bytes.
- [x] Implement local destination boundary and forward schema migration if needed. Gate tests prove no automatic retry from unknown state.

## Task 2: Station settings and compact design (UI implementer)

Files: `pages/WorkstationSetup.tsx`, `ui/setup/PrinterSetupPanel.tsx`, new focused `PrinterRoutingPanel.tsx`, `station.css`, RU/EN i18n, gallery fixtures, setup tests and browser scenarios.

Consumes Task 1 interfaces exactly. The UI edits `HardwareConfig.printerRouting`; it does not own print-job persistence. Existing scanner and sound settings stay intact.

- [x] Write a setup test that adds three profiles, assigns each purpose, saves/reloads, and prints a test to the selected editor profile without changing assignments.
- [x] Verify red; implement list/assignments view with individual editor, names and test action. No more than one physical target profile. Reuse existing printer transport fields.
- [x] Add/remove/edit preserve other profiles and assignments. Explicit unassignment is saved. Invalid fields cannot overwrite a valid configuration.
- [x] Add gallery fixtures and browser measurements: long names, empty list, three and many printers, all assignments, editor and dropdown; 1024×768/1280×800, RU/EN/light/dark. Check footer visibility, 64 px targets and clipping, save screenshots.

## Task 3: Handheld routing, recovery and compact settings (Android implementer)

Files: `core/print/PrinterEntities.kt`, new `PrinterRouting.kt` and destination boundary, Room migrations/schema tests; `core/box/{BoxPrinter,PalletPrinter}.kt`, `core/duplicate/DuplicateJobs.kt`; printer/settings/hub screens and viewmodels, relevant strings/tests.

Local Kotlin `PrintPurpose` values match box/duplicate/pallet. Each purpose resolves independently from the existing printer registry; selected legacy row initializes all assignments once. Print destination snapshots are local and excluded from shared wire/digest fields.

- [x] Write role resolution and migration tests covering legacy selected, multiple stored profiles, explicit missing assignment and stable snapshots.
- [x] Observe red; implement local routing and forward Room migration without losing jobs/queues. Wire all print callers, duplicate readiness, reprints and recovery by purpose. Status/send serialization uses normalized physical endpoint.
- [x] Add tests for distinct box/pallet/duplicate endpoints and rendering DPI/language, snapshot retention across role change/restart, unknown send and explicit compatible replacement.
- [x] Replace global selection UX with profile list and clear purpose assignment; test print is profile-specific. Hub/settings summarize routing. Compact Compose screens handle long names, visible back/actions and errors, RU/EN/light/dark.
- [x] Run focused tests, testDebugUnitTest, lintDebug, assembleDebug; produce visual evidence where environment permits. Report vendor hardware unrun.

## Task 4: Station runtime integration and recovery (controller)

Files: `App.tsx`, `pages/{NewShift,WorkScreen,InventoryWorkScreen}.tsx`, `lib/use-product-label-work.ts`, product-labels printing/preparation, box/pallet/inventory print helpers and recovery UI/tests.

- [x] Write actual-call tests with three targets. NewShift duplicate prerequisites must use duplicate assignment, box/inventory use box, pallet uses pallet. Explicit missing pallet assignment may never print to box.
- [x] Wire routing through existing props while keeping legacy test inputs valid. Retain destinations at preparation/attempt boundary; serialise transport per endpoint. Show purpose and bound profile name in pending/recovery views.
- [x] Write tests for a destination reassignment during prepare/send, profile removal, resume of legacy jobs, explicit compatible replacement and immutable duplicate bytes. Implement recovery choice without bypassing print/credential leases.
- [x] Run Station package tests/typecheck/lint/build plus changed DB package gates. Review all printer callsites for accidental selected/default fallback.

## Task 5: Review and validation (controller + independent reviewer)

- [x] Review each platform against spec and every changed print entry point. Resolve findings and rerun affected tests.
- [x] Exercise actual Station browser flow, focus/dropdowns/error/recovery on small screen; view resulting screenshots. Android screenshots/emulator verification if available; distinguish from hardware.
- [x] Run final scoped package gates, formatting and diff checks. Update architecture/device instructions and accepted spec with implemented behavior.
- [x] Deliver concise result, screenshots, exact automated results and unrun hardware checks. Publish only within the requested commit/push/PR scope.

Implementation and independent reviews are complete. Final Station: 1586 tests; browser: 19 scenarios; Android: 806 tests plus 12 final visual tests. Hardware acceptance is not performed. See the accepted spec for validation scope and limits.
