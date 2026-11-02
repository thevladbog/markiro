# Office design conformance

Use the approved October kit and the current `@markiro/ui` tokens. This continues
the shift/scanner implementation; it does not change the visual direction.

## Confirmed findings

- Information uses an uppercase, rectangular definition grid for program and
  license requisites. Backups and read-only SSCC/organization reuse that pattern.
  Use a reusable label/value row layout with hairline separators, normal-case
  labels, centered alignment and wrapping for paths and fingerprints.
- Information's outline has a large segmented background and 40px links. Bring
  it to the kit's flat navigation with 44px targets. Its native anchors bypass
  the memory router: the current item and keyboard focus do not update. A
  regression test reproduces this; use router links while keeping all sections
  mounted and preserving direct anchors.
- License host-ID copy and contact actions use compact 36px buttons outside a
  table. Use the normal 44px Office size. Keep compact table actions.
- The compact license upload target measures 38.89px. Set its minimum to the
  Office control token (44px) in the opt-in kit scope.
- License features have uneven spacing and an arbitrary 480px width. Align
  name/status rows and let the list use the available space responsively.

## Work

1. Extend the existing browser-only harness with protocol fixtures for healthy
   remaining pages and About shell information. No real service or hardware.
2. Add the optional rows layout to DefinitionGrid, leaving its default and the
   approved shift layouts intact. Apply it to Information, backups, SSCC and
   read-only organization requisites. Fix the outline, actions and feature rows.
3. Verify affected About/license/update/backup/SSCC/organization tests, then UI
   and standalone package gates. Inspect actual browser renders in both themes,
   including the lower Information sections, narrow layout and other menu pages.
   Save screenshots and measured results as new evidence, separate from the
   earlier implementation snapshot.

## Boundaries

Preserve license calculations, permissions, update verification, manual offline
package import, administrator installation confirmation, backup operations and
support-report privacy. Small checkbox glyphs with full label targets and compact
actions inside tables are intentional. Missing Tauri/service responses in the
browser harness are not production defects. Preserve the six local review fixes.
Do not publish this follow-up without a new push request.
