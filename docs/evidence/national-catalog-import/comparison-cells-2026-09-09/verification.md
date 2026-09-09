# Two-column comparison follow-up

Date: 2026-09-09. Base: `9da4f95a06aa38892af4e00ae04831f0105d382e`.
This is the user's approved, bounded comparison UI follow-up. Changes are local
and uncommitted; the preceding delivery and its historical evidence remain intact.

## Delivered behavior

Each parameter has two adjacent selectable cells: the current Markiro value on
the left and the proposed value on the right. Clicking the cell or its value
selects one side; the selected cell has a frame and checkmark. Native radio
grouping supports keyboard arrows and visible focus. Existing products keep
current values by default. Dependency clearing, required-name acceptance,
read-only behavior, manual-source captions and old-wire compatibility remain
in use. Only **Apply selected / Применить выбранное** submits the choices.

Photo selection uses the same current/candidate arrangement. View and retry
remain separate actions, and keeping a photo after viewing a candidate preserves
the existing reviewed-candidate evidence. Current thumbnails come from the
existing catalog product context; when a product is absent from that context,
the keep choice remains available without an invented thumbnail or new fetch.

Areas changed: admin import review/panel, catalog CSS and RU/EN copy; shared
`RadioCard` and its styles/export; focused admin/UI tests and browser selectors
plus two new browser cases. No API, domain, contract, database or Station source
changes are part of this follow-up.

## Verification

Commands used the worktree's local Node 24 / pnpm 11.22 runner. All referenced
logs are retained under
`.superpowers/sdd/2026-09-08-national-catalog-product-import/` with prefix
`comparison-cells-`.

| Gate                                | Actual result                                 | Log suffix                                                                              |
| ----------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Focused import/comparison/state     | 83/83 passed                                  | `focused-3.log`                                                                         |
| Shared RadioCard                    | 2/2 passed                                    | `ui-green.log`                                                                          |
| Full admin                          | 96 files, 1128/1128 passed; 175.86s           | `admin-full.log`                                                                        |
| Full UI                             | 11 files, 173/173 passed; 3.15s               | `ui-full.log`                                                                           |
| Admin and UI typecheck, lint, build | All passed                                    | `types-3.log`, `lint-2.log`, `build.log`, `ui-types.log`, `ui-lint.log`, `ui-build.log` |
| Browser workspace typecheck         | Passed                                        | `browser-types.log`                                                                     |
| Full browser suite                  | 23/23 passed; 58.4s; screenshot updates unset | `browser-full.log`                                                                      |
| Final screenshot capture            | 2/2 passed; 3.8s                              | `browser-capture-final.log`                                                             |
| All 15 source/test files, Prettier  | Passed                                        | `format-source.log`                                                                     |

Admin lint retains five existing hook warnings in unchanged boxes/conflicts
pages, with zero errors. The admin build retains its bundle-size warning.
Vitest reports jsdom canvas/navigation limitations; the complete admin suite
still passes. Browser checks exercise actual Chromium through controlled local
fixtures, independently of jsdom.

New comparison tests first failed on missing field groups/radios. A separate
accessibility assertion caught missing value text in the radio description and
passed after correction. Existing stale-preview tests now await the actual new
Apply control before interacting; their request and outcome assertions remain.
The initial admin lint rejection of native inputs was resolved by implementing
the reusable native control in the existing UI package, without disabling the
rule. Earlier failed logs remain available.

The [independent scoped review](review.md) approved the 15-file source/test
delta with no actionable findings. [Source hashes](source-freeze.json) identify
the reviewed code, separately from earlier historical manifests.

After that review, the controller completed the remaining delivery gates:
root `pnpm format:check` passed (`format-root.log`), `git diff --check` passed,
and all 15 reviewed source/test hashes still matched. No runtime changes were
made after the successful package/browser checks; final additions are this
verification record and its evidence links.

## Browser and visual evidence

The new cases verify value-text clicks, ArrowRight/ArrowLeft focus and selection,
category prerequisites, both images loading, no writes before Apply, and the
exact final accepted-field and photo payload. At widths 390 and 1280, all field
pairs have aligned top edges/equal widths and fit without dialog horizontal
overflow. These interactions and geometry checks run at a 1000px viewport
height. The full suite also covers RU/EN and both themes at 390, 768, 1280 and
1600px.

The parent and reviewer visually inspected both final captures. Capture-only
viewport heights are expanded to show the comparison and final action together:

- [Desktop, RU/light, 1280 × 1280](comparison-1280-ru-light.png).
- [Mobile, RU/dark, 390 × 1560](comparison-390-ru-dark.png).

These are local fixture screenshots, not live provider/customer data or a
production deployment. [Artifact metadata](screenshots.json) records dimensions
and SHA-256 hashes. Previous screenshot sets were not regenerated.

## Limits

Backend/Station suites were not rerun for this frontend-only change. Their
previous source-unchanged integration concerns remain documented in
[the earlier delivery report](../delivery-verification.md); this follow-up
does not resolve or reclassify those results. Live National Catalog/provider
photos, production, object storage, Windows and factory hardware acceptance
were not performed. Import flags remain disabled. No commit, push, PR,
deployment, cleanup or enablement was performed for this follow-up.
