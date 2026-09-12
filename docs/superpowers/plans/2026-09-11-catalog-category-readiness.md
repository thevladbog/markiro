# Catalog category readiness: first delivery

User authorization: 2026-09-11, following the readiness audit for juices (23), edible vegetable oils (33), and cosmetics (35): "Давай начнем".

Publication authorization: after reviewing the completed local delivery, the user requested "пуш и пр". Commit, push and PR publication are now authorized; deployment remains separate. The task instructions below record the original implementation scope.

This delivery implements the already approved category-card design in `../specs/2026-08-31-category-product-attributes-national-catalog-design.md`, adapted to the current completed National Catalog import/link workflow. It does not replace that workflow or invent regulatory attribute identifiers. Category schemas remain centrally reviewed; production enablement and live assortment acceptance are separate from this local implementation.

## Task 1: Backend support

- Reproduce and fix lost units on National Catalog attribute import. Trace the provider's `attr_value_type` through client, normalized snapshots, preview, apply, and observation/baseline comparisons. Preserve exact supported source units; never infer an absent unit from a name or canonical-unit ordering, convert values, or reinterpret historical accepted snapshots. Maintain legacy snapshot readers.
- Add an additive `definition: CategorySchemaDefinition | null` field to `GET /products/:id/regulatory-profile`, using the product's pinned schema. Return null for an unbound product. Never expose an arbitrary other product's data. Keep existing tenant/capability/subscription guards and update OpenAPI.
- Write focused failing tests before code. Cover actual importing unit-bearing values and absent/unknown units, plus profile schema metadata and tenant denial. Run focused tests and API static checks. Do not change DB schema, outbound provider methods, secrets, or activation flags.
- During implementation, keep changes local and write a task report with exact changed paths, RED/GREEN results and limitations. Publication follows the subsequent user authorization recorded above; deployment is outside this task.

## Task 2: Product card

- Implement focused components and typed API hooks under `apps/admin/src/pages/catalog/regulatory/`; follow existing UI tokens, controls, access checks and RU/EN localization.
- Edit mode shows separate production/code-ordering/circulation/EGAIS readiness with meaningful reasons; profile/category source and classified codes; schema-driven attributes; and explicit category binding/change preview and confirmation. Missing schemas remain a clear recoverable state, not a success state.
- Support all existing domain value kinds, constrained presets, units, repeatable values and conditional visibility. Submit only intentionally changed visible fields with the accepted `baseRevision`; hidden stored values are preserved. Refresh all affected queries after successful writes. Do not reset dirty values or rebase them onto a new revision during background refresh.
- Read-only users see data without mutation controls. Create remains a compact base form without regulatory reads; after creation provide an edit path. Reuse current National Catalog linking/import routes.
- EGAIS is relevant only to applicable groups. Preserve existing legacy EGAIS editing when no regulatory binding exists; use the existing collection endpoint for bound products. Do not clear accepted EGAIS on unrelated base-form saves.
- Protect dirty work on close/navigation and between subform saves. Avoid nested HTML forms; avoid closing the product panel on a regulatory save.
- Tests first: real rendered UI with HTTP-boundary fixtures for groups 23, 33 and 35 (synthetic examples, not attested official schemas), conditional values, units, readonly, explicit preview/apply, stale-revision recovery, and base-form compatibility.

## Task 3: Verification and evidence

- Run complete admin tests/typecheck/lint/build; focused API integration tests and API package gates, reporting infrastructure skips separately. Use an isolated local test DB if available; do not mutate shared production or another task's test data.
- Browser review with controlled fixtures: small/desktop viewport, light/dark, Russian/English, focus and form saving. Save reviewable screenshots and distinguish fixture proof from live provider/hardware acceptance.
- Perform independent code review, address correctness findings, run scoped formatting and `git diff --check`, document final behavior and remaining live SKU/schema acceptance.
- Present the completed local work for user review before publication; retain the isolated worktree for PR follow-up.

## Plan reconciliation

| Parts                               | Shared interface or conflict                                  | Resolution                                                                   |
| ----------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Backend / card                      | Existing profile omits schema definitions                     | Add pinned `definition`; UI treats absent field on older APIs as unavailable |
| Backend / import                    | Preview, apply and baseline must interpret units consistently | Trace all consumers and retain historical snapshots                          |
| Old admin plan / current import     | Old plan proposes a second import dialog                      | Reuse existing catalog import and CHZ link routes                            |
| Card / existing base editor         | Nested forms and independent saves could lose dirty work      | Separate forms, combine dirty state, preserve revisions                      |
| Old EGAIS removal / legacy products | Collection writes require a bound profile                     | Retain applicable legacy input until binding exists                          |
| Schema research / tests             | Real tenant SKU evidence is unavailable                       | Clearly label synthetic fixtures; never activate fabricated schemas          |
| Old plan / authorization            | Old plan includes per-task commits                            | Publish the reviewed delivery only after explicit user authorization         |
