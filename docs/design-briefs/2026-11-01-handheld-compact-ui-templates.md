# Handheld compact screens and printer templates

## Intent

Fit routine operations on an industrial Android handheld without compressing the badge block or hiding the last menu action. Keep the existing offline authentication, scanner inputs and host/cloud capabilities. Use the existing Markiro colours, bundled IBM Plex fonts and native Compose controls.

## Screens

- Sign-in shows badge instructions, a personnel-number field, numeric keys and name search. Roster refresh remains available in the header; roster counts and fetch timestamps are absent before authentication. Readiness and errors remain explicit. Removing the count does not change the existing name-search policy.
- The hub uses compact operation rows with Settings in the header. Tapping the operator opens the profile. The active shift retains product/line/mode context, counters, freshness and shared-shift warnings. Printer attention and unresolved queues remain actionable.
- Settings separates equipment, sound/vibration, display/language and device details. Update/install and offline-grant controls retain their existing mode restrictions. Device diagnostics use stacked labels and values.
- Short screens and enlarged text can scroll; touch targets remain at least 48 dp. Russian and English ship together, in dark and light themes.

## Printer template selection

Open a connected printer, choose Box or Pallet, select a cached template, review its size and preview, then explicitly assign it. Assignment also sets that printer for the selected print purpose. The source/default option keeps the shift or catalogue layout. Duplicate Data Matrix jobs retain their original format and bytes.

The host catalogue is populated by the existing reference feed, including purpose, enabled/deleted state and product-group restrictions. Cloud alternatives are cached from entered shift bundles and remain product-bound. Cloud mode explains this source instead of offering an operator-roster refresh as a template refresh. No new server endpoint or protocol is introduced.

Preview uses the supported Kotlin label model and example values. Barcode placeholders are identified as placeholders. Preview values never enter a production job. Saving rejects a missing printer, a wrong purpose, an unsupported layout or a changed template revision.

## Queue and upgrade invariants

Box and pallet closure atomically freeze the layout JSON and assigned printer. Later template choices, catalogue updates and purpose reassignment cannot change an already prepared job. Explicit printer replacement preserves a valid frozen layout. Unknown sends keep the existing manual-resolution rules.

A definite pre-render template refusal can be retried after configuration is corrected. Only a prior failed template-invalid/incompatible job can re-resolve an unusable snapshot; a valid layout or unknown send cannot enter that recovery path. A legacy job missing its source may acquire that original source later, never a later local override.

Room migration 22→23 adds the catalogue, per-printer choices and job snapshots. It freezes legacy closed-job source layouts and fills missing destinations without replacing existing printer snapshots or changing unknown/deferred states. Host reference data is replayed from revision zero to obtain the expanded local catalogue. Dataset replacement clears template business data while retaining hardware profiles and purpose assignments.

## Validation boundary

Compose tests cover compact screens, navigation, preview/confirmation and recovery actions. Room/printing tests cover migration, scope rejection, catalogue changes, closure snapshots, destination retention and explicit recovery. Native Compose renders cover dark/light themes and 320/360 dp widths. Automated checks do not establish physical Honeywell/scanner/printer acceptance or a released APK.
