# Handheld compact UI and printer templates

**Goal:** Implement the user-approved OpenPencil screens for sign-in, hub, settings and per-printer label templates.

**Architecture:** Retain native Kotlin/Compose and existing offline authentication. Keep the existing mode and recovery boundaries. Persist per-printer/purpose choices and freeze template JSON when a box or pallet closes; retries retain their layout even when settings or the catalogue change.

**Spec:** `docs/design-briefs/2026-11-01-handheld-compact-ui-templates.md`. The editable OpenPencil file and native render exports remain local design artifacts.

**Constraints:** RU + EN; bundled IBM Plex and Material icons; 48 dp minimum targets; existing Markiro tokens; no new runtime dependencies. Do not change duplicate Data Matrix bytes, domain/date calculations, host protocol, production or releases. Preserve unrelated files and keep generated APKs, build output and local design artifacts out of the source change.

## Review focus

- Short viewport and increased font size must scroll without shrinking or clipping controls.
- Host/cloud modes retain all available operations, recovery warnings and authorization restrictions.
- A changed template/printer assignment cannot alter pending or uncertain jobs.
- Template selection must reject wrong purposes, unsupported layouts and incompatible product scopes.
- Database upgrades and dataset resets must retain hardware settings and existing print evidence correctly.

### Task 1: Native screens

- [x] Update failing Compose tests: no roster count/time before login; full badge and keypad in 320×520 app area; compact host hub exposes all operations and settings without scrolling; settings opens separate device details.
- [x] Implement sign-in and adjustable keypad in `feature/signin/SignInScreen.kt` / `core/design/Components.kt`.
- [x] Implement compact rows and profile access in `feature/hub/HubScreen.kt`, retain counts and warnings in `ActiveShiftCard.kt`.
- [x] Split settings landing, signals, appearance and device details in `feature/settings/SettingsScreens.kt`; wire navigation.
- [x] Run focused Compose tests, including existing mode/recovery assertions.

### Task 2: Durable template selection

- [x] Add failing Room/printing tests for purpose/product compatibility, restart, closed jobs, changed choices and physical printer replacement.
- [x] Add catalogue/choice/snapshot storage and migration 22→23; classify new tables for dataset reset.
- [x] Populate catalogue from existing host change feed and cloud shift bundles; retain cached choices offline. Do not introduce new endpoints.
- [x] Freeze choice/fallback at closure; migrate legacy closed jobs to source-template snapshots. Rendering uses the frozen layout and existing fields; duplicate jobs remain untouched.
- [x] Implement printer profile, chooser, preview and explicit save using existing `LabelPreview`; integrate through the shared printer graph.
- [x] Run focused storage, migration, printer and closure tests.

### Task 3: Verification

- [x] Run `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug` with JDK 17 and local Android SDK.
- [x] Capture actual Compose renders for dark/light and 320/360 dp widths; inspect them.
- [x] Review complete diff, translations, compatibility, dataset reset and remaining limitations.
- [x] Run `git diff --check` and local `graphify update .`; report physical-device/printer checks separately.

## Implementation decisions

The catalogue uses data already received by the device; cloud alternatives become available as shift bundles are cached. Group-scoped templates remain bound to their product group, and bundle-only templates to their product when the group is unknown. Printer/layout snapshots are recorded in the closure transaction. Returning from the chooser uses a non-replayed save event.

## Verification ledger

- RED: original sign-in disclosed roster size and failed the 320×520 visible-controls assertion.
- RED: original hub overflowed on 320 dp; settings landing exposed device diagnostics directly.
- RED: print integration ignored a local layout and closure did not create a template snapshot.
- GREEN: 13 targeted template/migration/preview tests reached 11 passes before host-feed and diagnostic-width corrections; then the focused printing/closure/host/settings/render group passed.
- Review: independent fresh-context review found permanent pre-render refusal snapshots, missing destination retention at closure, host bundle aliases and a misleading cloud refresh. Added regressions, observed three failing scenarios, fixed all four; re-review found no additional important issue.
- Recovery ruling: a prior FAILED template-invalid/incompatible job may explicitly re-resolve an unusable pre-render snapshot. Valid layouts and unknown sends remain frozen; destination stays pinned unless explicitly replaced.
- Full suite first pass: 1,639 tests, six UI failures. Three asserted removed decorative/mode labels; retained the operational mode/line context and removed only the redundant English ACTIVE SHIFT assertion. Three update-control tests were updated to navigate to the new device-details page.
- Further validation: migration fixture now verifies both preserving an existing printer snapshot and backfilling a missing destination. Native dark/light 320/360 dp renders are generated under `apps/handheld/app/build/redesign-visuals`.
- Navigation ruling: use a non-replayed save event for returning from the chooser; a previous successful save must not close a later chooser visit.
- Final gate passed: 1,641 tests across 213 classes, zero failures/errors/skips; lintDebug passed (94 warnings, no errors); assembleDebug passed. git diff --check and targeted Markdown formatting passed. Native renders inspected; no physical-device or printer acceptance claimed.
- Graphify AST update completed: 76,971 nodes. Parser reported 58 partially extracted files and two Cargo.toml files without nodes; these are graph parser limits, separate from the successful Kotlin compilation.
- Missing-printer regression: compact menu retains a visible action for missing/attention printer purposes, with unsupported duplicate purpose omitted in host mode.
