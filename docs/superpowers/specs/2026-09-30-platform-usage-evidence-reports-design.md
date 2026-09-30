# Platform usage and evidence reports — Design Spec

**Date:** 2026-09-30
**Status:** Design approved by owner on 2026-09-30; implementation plan not yet written.
**Extends:** [`2026-09-10-platform-report-exports.md`](2026-09-10-platform-report-exports.md) (the five operational templates), operations guide [`docs/operations/platform-report-exports.md`](../../operations/platform-report-exports.md).
**Related:** [`2026-08-21-analytics-and-impact-evidence-foundation-design.md`](2026-08-21-analytics-and-impact-evidence-foundation-design.md) (§15 P1 event ledger and immutable snapshots stay out of scope here), `tools/evidence-package/` (init, seal, verify).

## 1. Purpose

The five existing SaaS-admin templates describe production events for operators. The owner also needs platform-usage analytics that can serve as supporting material for a possible EB-2 NIW filing and for customer presentations: how much the platform is used, what it prevents, and whether the business is commercially real.

This spec adds three report types to the existing reports page and pipeline. They are exported from the database like the current templates and share their queue, private storage, audit, history and download flow. Numbers must be reproducible from named parameters, a snapshot time and a versioned definition set.

What counts as evidence, and how it is argued, is a legal question for the owner's counsel. This spec covers only that the exported figures are precisely defined, reproducible and honest about their limits.

## 2. Scope

Three new `reportType` values: `usage`, `quality`, `commercial`.

- Row grain for all three is one tenant and one local calendar day in the selected IANA timezone. Days are added up to weeks or months outside the system; every numeric column is additive.
- A row is emitted only for a tenant-day that has at least one recorded fact in that report's sources. A missing row means no recorded fact, not a measured zero. Inside an emitted row, a metric with no events is `0` because its source is complete for that fact family; each metric definition states any completeness caveat.
- Explicit tenant selection (1–10), inclusive local dates, maximum 366 days, `periodBasis=events` only. These are the current contract limits and do not change. The bounded size is at most 10 × 366 rows per report.
- All optional filters (`lineId`, `productId`, `gtin14`, `operatorId`, `status`, `outcome`) are rejected for the new types, following the existing rule of rejecting irrelevant filters rather than ignoring them.

### 2.1 `usage`: scale and growth

| Column                                                  | Definition                                                                                                                           | Clock basis                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `tenant_name`, `day`                       | identity and local day; `tenant_name` is current organization name                                                                   | n/a                                                                                                              |
| `shifts_active`                                         | distinct shifts that have an accepted scan or a closed box on the day                                                                | derived from `accepted_units` and `boxes_closed` facts                                                           |
| `active_lines`                                          | distinct non-null `line_id` of those shifts                                                                                          | derived                                                                                                          |
| `active_devices`                                        | distinct non-null `terminal_id` on accepted scans and closed boxes that day (text, may hold legacy non-UUID values; counted as text) | device-reported id                                                                                               |
| `active_operators`                                      | distinct non-null `operator_id` on those facts; a count only, never a person row                                                     | device-reported id                                                                                               |
| `accepted_units`                                        | `scan_events` with `verdict='ok'` at `scanned_at`                                                                                    | device time; `scan_events` has no server receipt time                                                            |
| `boxes_closed`                                          | boxes with `closure_received_at` on the day                                                                                          | server time                                                                                                      |
| `sscc_boxes`                                            | of those, boxes with non-null `sscc`                                                                                                 | server time                                                                                                      |
| `print_confirmed_boxes`                                 | boxes with `print_verified_at` on the day                                                                                            | device time: the station's clock carried in the closure record                                                   |
| `production_pallets_closed`, `warehouse_pallets_closed` | pallets by `kind` with `closure_received_at` on the day                                                                              | server time                                                                                                      |
| `pickup_orders_buy`, `pickup_orders_writeoff`           | `pickup_orders` by `reason`, `status <> 'cancelled'`, at `created_at`                                                                | device time when within the accepted skew of the server, otherwise server time (existing `resolveScanTime` rule) |
| `pickup_orders_kiosk`, `pickup_orders_handheld`         | the same orders by `source_kind`                                                                                                     | same                                                                                                             |
| `pickup_items_buy`, `pickup_items_writeoff`             | `sum(item_count)` of the same orders; `pickup_order_items` is never joined                                                           | same                                                                                                             |
| `inventories_completed`                                 | inventories with `completed_at` on the day                                                                                           | server time                                                                                                      |
| `gtins_added`                                           | `products.created_at` on the day; products deleted while unreferenced are absent                                                     | server time                                                                                                      |

`accepted_units` uses `scan_events`, not `code_registry`, because registry ownership is current-state and shrinks on release, clear and disassembly. This intentionally differs from the tenant dashboard's validation-unit count. The definition text must say so.

### 2.2 `quality`: prevented errors and offline behaviour

| Column                                                                             | Definition                                                                                                                                                                                                                             | Clock basis                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `tenant_id`, `tenant_name`, `day`                                                  | as above                                                                                                                                                                                                                               | n/a                                                                         |
| `accepted_scans`, `duplicate_scans`, `wrong_gtin_scans`, `invalid_scans`           | `scan_events` by `verdict`, so a rate has its denominator in the same row                                                                                                                                                              | device time                                                                 |
| `code_conflicts_detected`                                                          | `code_conflicts` at `detected_at`, for the losing shift's tenant                                                                                                                                                                       | server time                                                                 |
| `code_conflicts_reviewed`                                                          | `code_conflicts` at `reviewed_at`                                                                                                                                                                                                      | server time                                                                 |
| `box_disassemblies`                                                                | boxes with `disassembly_received_at` on the day                                                                                                                                                                                        | server time                                                                 |
| `pallet_disassemblies`                                                             | `pallet_exceptions` `kind='disassemble'` at `recorded_at`                                                                                                                                                                              | server time                                                                 |
| `box_closure_lag_clock_ahead`, `_lt_1h`, `_lt_24h`, `_lt_7d`, `_ge_7d`, `_unknown` | boxes with `closure_received_at` on the day, bucketed by `closure_received_at - closed_at`: negative, under 1 h, under 24 h, under 7 d, 7 d or more, and `closed_at` null. Bucket bounds are half-open: exactly 1 h falls in `_lt_24h` | server minus device                                                         |
| `sync_quarantined_records`                                                         | `station_sync_quarantine` at `quarantined_at`                                                                                                                                                                                          | server time                                                                 |
| `inventories_completed_with_snapshot`                                              | completed inventories with an active snapshot, at `completed_at`                                                                                                                                                                       | server time                                                                 |
| `inventory_expected_current`, `inventory_missing_expected_current`                 | sums of the existing projection's `current_expected` and `current_missing_expected` for those inventories                                                                                                                              | **current projection at generation time, not an event-time reconstruction** |

Lag is reported as bucket counts, not averages or percentiles, because counts stay additive across days, tenants and the `aggregate` privacy mode. `code_conflicts` and the existing shift report both count conflicts, once per losing shift; the new report counts them per detection day and does not claim to reconcile with the shift-scoped figure.

### 2.3 `commercial`: revenue and traction

All amounts are RUB, expressed as integer kopecks. RUB is enforced by check constraints on `invoices`, `billing_payments` and the legacy `payments` table.

| Column                                                                                                     | Definition                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `tenant_name`, `day`                                                                          | as above                                                                                                                                                                                                                                                                                                            |
| `invoices_issued`, `invoices_issued_net_minor`, `invoices_issued_vat_minor`, `invoices_issued_total_minor` | invoices with `issued_at` on the day (`subtotal`, `vat_total`, `total`); later cancellation does not remove them, `invoices_cancelled` below counts it separately                                                                                                                                                   |
| `invoices_cancelled`                                                                                       | invoices with `cancelled_at` on the day                                                                                                                                                                                                                                                                             |
| `invoices_paid`                                                                                            | invoices with `paid_at` on the day (set only when fully paid)                                                                                                                                                                                                                                                       |
| `payments_received`, `payments_received_minor`                                                             | the union of `billing_payments` (invoice payments) and legacy `payments` (offer payments) at `paid_at`. The flows are disjoint: an offer payment writes only `payments` and an invoice payment writes only `billing_payments`, so they are summed without deduplication. Partial payments are counted when received |
| `acts_issued`                                                                                              | `billing_acts` with `issued_at` on the day                                                                                                                                                                                                                                                                          |
| `paid_subscriptions_started`                                                                               | `tenant_subscriptions` with `source IN ('paid_offer_line','paid_invoice_line')`, at `starts_at`, falling back to `created_at` when `starts_at` is null                                                                                                                                                              |
| `agreements_signed`                                                                                        | `platform_agreements` with `signed_at` on the day and `tenant_id` in the selected tenants; agreements not linked to a tenant are not reported                                                                                                                                                                       |

Commercial data is money data; the type is visible only to holders of the existing `reports.*` capabilities, which today means `platform_admin`.

## 3. Framework changes

No database migration, no new queue and no new capability are needed. The report type lives in the `platform_reports.parameters` jsonb, and `platform_admin` already holds `reports.read`, `reports.create`, `reports.download` and `reports.identified`.

1. `packages/platform-contracts/src/platform-reports.ts`: add the three values to `platformReportTypeSchema` and extend the type-conditional refinements so `periodBasis=production_date` and every optional filter are rejected for them. Changes are additive because stored `parameters` are re-parsed on list, download and run.
2. `apps/api/src/platform-reports/`: three source files (`usage-report-source.ts`, `quality-report-source.ts`, `commercial-report-source.ts`) exporting a `*_COLUMNS` list and a `load*Rows(tx, input)` function on `reportRows`, `tenantScope` and `inWindow`; dispatch in `report-source.service.ts`; definition text in `report-definitions.ts`. Sources aggregate in SQL to tenant × local day and never emit per-unit rows.
3. `quality-report-source.ts` reads the existing inventory projection through `loadInventoryRows` (unchanged) and joins it in code to a small completion query on `inventories.completed_at`. `inventory-report-source.ts` and the `inventories` artifact do not change.
4. `report-definitions.ts` `applyReportPrivacy` (§4).
5. `report-renderer.ts`: metadata additions and tenant-id stripping (§4, §5). `report-source.service.ts`: dispatch and per-type definitions, so the three new artifacts carry only their own definitions and the five existing artifacts keep their current definitions content.
6. `apps/saas-admin/src/pages/reports/ReportsPage.tsx` and `i18n/{ru,en}.json`: add the types to the selector, hide all source filters and the period-basis control for them, add help text and privacy descriptions, keep the current default of pseudonymous.
7. Docs: update `docs/operations/platform-report-exports.md` with the three types, the tenant-label behaviour and the correct artifact file names.

Everything downstream of the source loader (creation, audit, lease, storage, expiry, download) is unchanged.

## 4. Privacy

The new reports contain no person rows. Their `active_operators` column is a distinct count.

- `identified`: `tenant_id` and `tenant_name` as stored. This mode continues to require `reports.identified`.
- `pseudonymous`: `tenant_id` and `tenant_name` are replaced with the same export-local label `tenant-01`, `tenant-02`, … assigned in ascending tenant-id order, mirroring how operators are labelled.
- `aggregate`: both tenant columns are removed and rows collapse per day by summing. This is exact because every numeric column is additive, and distinct counts are additive across tenants because line, device and operator identifiers are tenant-scoped.

Outside `identified`, `metadata.json` parameters omit `tenantIds` and record `tenantCount`, and the definitions carry the anonymization warning. `applyReportPrivacy` today knows only the operator fields, so the tenant columns must be added for these three types explicitly, and a test must fail if a tenant name appears in the bytes of a pseudonymous or aggregate artifact. As with the existing reports, pseudonymous and aggregate output is not legal anonymization: a tenant with a distinctive volume or a small tenant count can still be inferred. This warning must appear in the UI and in `metadata.json`.

Customer names are not published unless the customer has consented; this is an operational rule for the owner and is not enforced by the export. Badge, PIN, raw scan code, authentication material and integration credentials remain excluded in every mode.

## 5. Evidence integrity

- `metadata.json` gains `definitionsVersion`, a string constant per report type that is bumped whenever any formula or clock basis changes, and `dataSha256`, the SHA-256 of the exact `data.csv` bytes. It already records the snapshot time, the parameters and the definitions.
- A later export with the same parameters can differ because devices sync late and names are current. The definitions state this, and comparison across exports uses `snapshotAt`.
- Artifacts keep the current seven-day retention. Downloaded files are to be placed into an evidence package with `tools/evidence-package` (seal, verify) for long-term retention; the report system does not become the archive.

## 6. Non-goals

- A nightly accumulator or metric ledger, as in the analytics spec §15 P1. Data that is not retained (the CommerceML item journal keeps 14 days, sessions 90 days; there is no device heartbeat history) is captured operationally by exporting the existing `commerceml` report monthly into an evidence package.
- Fleet snapshots, device registry, client-version adoption, mail delivery and job health.
- Customer-attested before/after baselines. These are documents in the evidence package, not database facts.
- Lead and demo-request reports. No lead table exists, and the demo-form payload is erased after 24 hours.
- Access for accountant or support roles, XLSX output, periods over 366 days and an all-tenants mode.

## 7. Implementation checks

These must be confirmed against a local database before the corresponding column ships. If a check fails, the stated action applies.

1. **Scan-event query cost.** `scan_events` is partitioned monthly with a `(shift_id, scanned_at)` index. Reach it through the tenant's shifts and the window, as the shift source does, and confirm with `EXPLAIN` on a local database that a 366-day, 10-tenant run stays inside the 60-second statement timeout. If it does not, narrow the shift preselection before considering an index.
2. **Cast rules.** Cast counts to `::int` and kopecks to `::float8` in SQL. `reportRows` rejects booleans, jsonb and arrays, returns bigint and numeric as strings, and the aggregate privacy mode sums only JavaScript numbers.
3. **Timezone.** Local day is `(ts AT TIME ZONE tz)::date`, matching `inWindow`. Check a DST-observing zone as well as Europe/Moscow.
4. **Grouping by a local-day expression.** The timezone is a bind parameter, so Postgres treats the same expression written in `SELECT` and in `GROUP BY` as two different expressions. Group by ordinal position or by an aliased CTE column, never by the repeated expression.

## 8. Testing and acceptance

Automated tests, written first and observed failing:

- Contract: the three types are accepted; each optional filter and `production_date` is rejected for them; existing types are unchanged; old stored parameters still parse.
- Source, with hand-calculated fixtures on a local database: tenant contamination (a second tenant's rows never appear), a box closed on the device on day 1 and received on day 2 counts on day 2, local-day boundaries at 23:59 and 00:00 in Europe/Moscow and in America/New_York across a DST change, scans, boxes, pallets and pickup orders together in one row without multiplication, lag bucket edges (negative, exactly 1 h, 24 h, 7 d, null `closed_at`), cancelled pickup orders excluded, partial payment counted on receipt and the invoice counted paid only when fully paid, the legacy and current payment union, a null `starts_at` fallback, and an inventory completed without an active snapshot.
- Privacy: no tenant name or tenant id in the bytes of pseudonymous or aggregate artifacts, including `metadata.json` parameters; labels are stable and ordered; aggregate output equals the manual sum over tenants.
- Renderer: `metadata.json` contains `definitionsVersion` and a `dataSha256` that matches `data.csv`; CSV formula protection still applies to all new text columns.
- UI: the new types appear, source filters and the period basis are hidden for them, the pseudonymous default and the warning are present, and a generated report can be downloaded.
- Existing platform-report lifecycle, module and OpenAPI tests pass unchanged.

Reported separately, not claimed by automated tests: a browser walkthrough of the reports page, a run against a realistic multi-tenant dataset, and confirmation of every §7 item.

The gates are the ones the affected packages already use: contracts, API and saas-admin tests, typecheck, lint and build, plus `pnpm --dir tools/production-browser --ignore-workspace test:reports` for the reports browser regression. Use the local test database, not production.
