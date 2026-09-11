# Catalog category readiness — first delivery

Date: 2026-09-11. Scope: the catalog foundation for juices (CHZ group 23), edible vegetable oils (33), and cosmetics (35). Worktree branch: `codex/catalog-category-readiness`, based on `3656c135a`. This report records local implementation and verification; the user subsequently authorized commit, push and PR publication.

## Delivered behavior

- National Catalog numeric attributes retain the exact supported source unit through preview, apply, reviewed baseline and subsequent observations. Both current `valueType` and legacy `unit` snapshot representations remain readable. Absent, unsupported and whitespace-altered units are rejected instead of inferred or silently converted. Historical accepted snapshots are not rewritten.
- The tenant-scoped regulatory profile response includes the definition of its pinned category schema, or null when unbound. OpenAPI documents the full definition.
- The product editor displays independent production, code-ordering, circulation and EGAIS readiness, category/classification/source, schema-defined attributes and an explicit category transition preview. It supports all seven existing value kinds, units, presets, repeated values and conditional fields. Only changed visible attributes are submitted with the accepted revision; hidden stored values remain intact.
- Category transitions select values to transfer and retain incompatible/unselected values in history. A category whose group mapping is ambiguous requires explicit acknowledgement. The current National Catalog import/link routes are reused.
- Creation stays a base form and opens the saved product for further editing. Read-only users can open product details through the list or direct route; create and all server writes retain their existing authorization boundaries.
- EGAIS controls apply only to group 15. Bound products use the existing collection endpoint; unbound applicable products retain the legacy input. Unrelated base saves omit hidden EGAIS fields.
- Independent saves preserve dirty input and captured revisions, block competing edits, and do not close the card after an attribute save. Background errors in regulatory, products or counterparties queries retain cached forms. Explicit conflict recovery fetches the latest server revision before discarding edits.

## Verification

All provider/category/SKU examples in the automated and browser tests are synthetic. Their labels and identifiers are not an approved regulatory matrix.

| Check                                  | Result                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Final focused admin catalog suites     | 4 files, 75 tests passed                                                                                                                                                                                                       |
| Actual app access routes               | 37 tests passed, including readonly details and denial without operations.read                                                                                                                                                 |
| Final full admin suite                 | 102 files, 1207 tests passed                                                                                                                                                                                                   |
| Final API affected and recovery suites | 6 files, 135 tests passed against an isolated migrated local Postgres database                                                                                                                                                 |
| API focused pure suites                | 5 files, 77 tests passed; independent exact-unit review reran 10 tests successfully                                                                                                                                            |
| Full API run                           | 317 files: 308 passed, 2 failed, 7 skipped; 3503 passed, 4 failed, 51 skipped. All four failures were subsequently resolved and passed in the final 135-test run, as detailed below                                            |
| Chromium                               | 7 scenarios passed: groups 23/33/35 at 1366px light and 390px dark; English readonly through actual app routes. Keyboard focus, units, dirty-close confirmation, save result, no nested forms, and horizontal overflow checked |
| Static/build checks                    | API and admin typecheck/lint/build passed. Admin retains five existing hook-dependency warnings outside catalog; Vite retains the existing large-chunk warning                                                                 |
| Browser TypeScript / CI policy         | Typecheck passed; CI policy 40 tests passed. Category browser suite added to the existing production_bundle job with failure artifact retention                                                                                |
| Formatting / whitespace                | Repository format check and git diff --check passed                                                                                                                                                                            |

The full API run began before the last review fix. Its two whitespace-unit tests observed the earlier transformation; the final source rejects these exact raw strings before Zod parsing. The two unrelated Signer refresh tests returned 503 because the scratch environment lacked `CHZ_TOKEN_ENCRYPTION_KEY`; a disposable generated key was added only to the private local test environment, and the complete Signer test file then passed. No production key or credentials were used. The complete 317-file API run was not repeated after these targeted checks.

The first full admin run also overlapped final review work and exposed four failures: three draft-preservation cases and an obsolete write-only route expectation. They were fixed and passed in the focused suites; the final full run passed all 1207 tests.

Independent backend and frontend reviewers checked the final fixes. Initial findings covered raw-unit trimming, cached-data unmounts, actual reload after 409, readonly route reachability, enum fields without presets, and classification preservation on a failed reload. No unresolved actionable findings remain.

## Browser evidence

Run `corepack pnpm --dir tools/production-browser --ignore-workspace test:catalog-regulatory` after installing that directory's frozen dependencies. Fixtures use the actual cabinet route tree and intercept only local `/api/` requests. Screenshots are written under ignored `tools/production-browser/test-results/catalog-regulatory/`; they must not be mistaken for production evidence. The visual check inspected both themes, mobile controls and the English readonly card.

## Remaining category acceptance

1. Obtain representative authorized GTINs and the current official category/TN VED/OKPD2 selectors for each intended assortment, including cosmetics subcategories.
2. Load and centrally review the real National Catalog schemas and mappings; verify units, required layers, conditions and source identifiers against those cards. No fabricated schema has been activated by this change.
3. Exercise the existing import/link flow against the authorized tenant and verify previews, accepted attributes, readiness and conflicts with real provider responses.
4. Separately verify operational documents, category-specific label content and physical printer/scanner behavior where the actual assortment requires them. This delivery does not extend the label template field set or prove real code ordering/circulation.

No production deployment, provider enablement, live National Catalog acceptance or printer/Windows/Station hardware check was performed.
