# Chestny ZNAK Marking-Code Orders — Design Spec (phase 1)

**Date:** 2026-09-18

**Status:** Implemented — both part A (cloud, API, admin) and part B (Windows signer
agent), in the same branch. Nothing has met a real СУЗ, and part B has never executed
anywhere. See «Implementation status» below for what was built differently from this
spec.

**Scope:** Ordering marking codes (КМ) from Chestny ZNAK's order-management station
(СУЗ, OMS API 3.0) from the admin cabinet, keeping the emitted codes as a per-tenant
pool, and issuing them either as a file (TXT/CSV) or as a browser print page for a label
printer. Utilisation reports («отчёт о нанесении»), introduction into circulation
(«ввод в оборот») and printing on the Station are explicitly later phases.

## Implementation status (2026-09-19)

Both parts are implemented in this branch.

Part A — the `chz-km-orders` API module, the pg-boss runner, the encrypted code pool and
the admin «Заказы кодов» surfaces — is implemented per
`docs/superpowers/plans/2026-09-19-chz-km-orders-cloud.md`. Part B — the Windows signer
side (`oms_auth`, `sign_detached`, the detached flag in both signing backends) — is
implemented per `docs/superpowers/plans/2026-09-19-chz-km-orders-signer.md`.

Implemented is not verified, and the two halves are unverified to different degrees:

- **No part of this has met a real СУЗ.** The first contact is the sandbox run in
  [`docs/runbooks/signer-agent-manual-e2e.md`](../../runbooks/signer-agent-manual-e2e.md),
  section «СУЗ: token and detached signature (sandbox)», and the open questions at the
  end of this spec stay open until it happens.
- **Part B's Windows code has never run at all.** `signer_capi.rs` and
  `signer_cades.rs` are `#[cfg(windows)]`, this branch was written on macOS where that
  arm is not compiled, and no job executes them — the Windows CI job compiles both and
  runs `cargo test`, but no test calls `CryptSignMessage` or `SignCades`. That sandbox
  run is their first execution, ever.

### Deviations from this spec

1. **No `km.gtin` / `km.serial` label fields.** The stock «Этикетка КМ» prints the serial
   through the existing `km.code` field with `textFormat: "km_without_crypto"` and the
   GTIN through `product.gtin`. New KM sub-fields would touch the label model, the
   ZPL/TSPL emitters and the Station, which this phase does not.
2. **No per-purpose default template tables.** The print dialog lets the admin pick any
   enabled `product_km` template eligible for the product's category, with the stock one
   preselected. Organisation- and category-level defaults for this purpose are a
   follow-up.
3. **Migration index 0166, not 0165 (resolved).** The plan claimed `0165_chz_km_orders`;
   `0165_pallet_membership_removal_quarantine` reached `main` first, so this branch took
   the next free index and the migration ships as `0166_chz_km_orders` — SQL file,
   snapshot and journal `idx`/`tag` together (commit `c4ed8b7d6`).

### Decided during implementation, not visible from this spec

- **Reconciliation runs at the start of every fetch pass**, not only before the final block as
  «Runner state machine» and the error table below say. The spec's trigger is computed from our
  own `fetchedCount`, and that counter is exactly what goes stale when a block is lost between
  СУЗ's response and our commit — so the check only fired once the buffer had already been
  drained and the block was no longer recoverable. Every pass now reconciles once before drawing
  anything (one `GET` over an empty list on a fresh order); the before-final-block reconcile
  stays but is skipped when the counter has not moved since the last one.
- **Four error codes this spec does not name:** `CHZ_CODES_INCOMPLETE` (СУЗ commits nothing on a
  block the runner still needs, so the pass stops instead of spinning until the deadline turns it
  into a misleading timeout), `CHZ_CODES_OVERDELIVERED` (СУЗ hands back more codes than the order
  asked for, which the counts CHECK would otherwise turn into a raw constraint violation
  mid-transaction), `CHZ_ORDER_SUBMIT_UNRECORDED` (the `submitted` write lost its fence, so the
  СУЗ order id exists but our acceptance was never persisted — the order ends here rather than
  letting a later pass sign and submit a second, separately billed one) and
  `CHZ_KM_ISSUE_INCONSISTENT` (the issue bookkeeping and the code rows disagree, on the write path
  and on the read path). The authoritative list is `CHZ_KM_ORDER_SAFE_ERROR_CODES` in
  `apps/api/src/modules/chz-km-orders/chz-km-order-runner.service.ts`, eleven codes at the time of
  writing, plus `CHZ_KM_ISSUE_INCONSISTENT` from the issue path in the same module's `dto.ts`.
- **The print page rasterises every label through one reusable canvas** into PNG blobs
  shown as `<img>`. One canvas per label at the page's print DPI would ask the browser
  for roughly six gigabytes for the 5 000-label batch the dialog allows in a single
  press, and a browser past its canvas budget returns blank pixels rather than an error.
- **«Печать ещё раз» cannot reproduce the original run's template.** An issue row carries
  no template id, so the print page re-derives one by the same eligibility rule. That
  matches the original only when the tenant has a single eligible marking-code template.
  Persisting the template on the issue is the real fix and needs a schema change.
- **The integration settings form refuses to clear `omsId`/`omsConnection`** instead of
  posting a patch that would do nothing: the server merges a settings patch
  (`settings || patch`) and has no representation for unsetting a key, so a cleared field
  would silently repopulate. A real unset needs a server-side representation.

## Background

Today Markiro only **scans** codes that are already applied: the server keeps
`code_hash`, never the raw code, and the Station prints duplicates from a scanned code.
Nothing in the product orders codes; the partner-registry questionnaire says so in as
many words, and no СУЗ acceptance test was ever requested.

The customer's current loop: order codes in the ЧЗ cabinet or elsewhere, print them on a
label printer attached to an office computer, and report application and introduction
through an external system (СБИС) that talks to ЧЗ by API from exported files. This spec
moves the first two steps into Markiro and leaves СБИС in charge of the reports, so the
customer's compliance path does not change on day one.

What already exists and is reused:

- the signer agent (`apps/signer`, `apps/api/src/modules/signer-agents`) with the
  `true_api_auth` task, the attached CAdES challenge flow and encrypted token storage
  (`chz_api_tokens`, `ChzCryptoService`);
- the `chestny_znak` integration channel with `environment` and `mchdInn` settings;
- `chz_product_groups` with the СУЗ alias per group (`beer`, `nabeer`, …);
- the dispenser-export runner (`apps/api/src/modules/chz-exports`) as the pattern for a
  durable pg-boss state machine with an injected `fetch`;
- label templates with a `km.code` DataMatrix element, the domain SVG renderer and
  `rasterizeGs1DataMatrix`, the editor, template scope and category defaults.

### СУЗ facts that shape the design (OMS API 3.0, `~/Downloads/API_СУЗ_3.0.pdf`)

- Hosts: production `https://suzgrid.crpt.ru`, sandbox `https://suz.sandbox.crptech.ru`.
  All methods live under `/api/v3/`.
- Authentication: a `clientToken` valid for 10 hours, obtained through True API
  `POST /auth/simpleSignIn/{omsConnection}` with the same signed challenge as today.
  The response is `{"token": "<uuid>"}`. One token per installation; requesting a new
  one invalidates the previous one, so Markiro needs its **own** СУЗ installation
  (`omsConnection`), which the tenant registers in the СУЗ cabinet. Registration by API
  needs a partner `registrationKey` that Markiro does not have yet.
- Every `POST` carries `X-Signature`: a **detached** CMS (GOST) signature over the exact
  request body bytes, base64. An attached signature is rejected with HTTP 413.
- Flow: `POST /order?omsId` → `{omsId, orderId, expectedCompleteTimestamp}`;
  `GET /order/status?omsId&orderId&gtin` → buffer info (`bufferStatus` PENDING / ACTIVE /
  EXHAUSTED / REJECTED / CLOSED, `availableCodes`, `leftInBuffer`, `totalPassed`,
  `expiredDate` in Unix ms, `rejectionReason`); `GET /codes?omsId&orderId&gtin&quantity`
  (quantity ≤ 150 000) → `{codes: string[], blockId}`. Codes contain the GS separator as
  the JSON escape `\u001d`; parse as JSON, never as text.
- The sub-order closes automatically when the last code is taken. Blocks can be
  re-fetched (`GET /order/codes/blocks`, `GET /order/codes/retry`) **only while the
  sub-order is open**. An order with codes left in the buffer is closed by СУЗ after
  48 hours and the unused codes are annulled.
- Limits: ≤ 10 GTIN per order, ≤ 150 000 codes per GTIN, ≤ 100 active and ≤ 100 queued
  orders per participant, 100 requests/s per IP+omsId.
- Beer group (`beer`): `templateId` 18, `cisType` `UNIT`, `serialNumberType` `OPERATOR`,
  `releaseMethodType` `PRODUCTION`, `paymentType` defaults to 2 (pay on application).
  With pay-on-application, unused codes are annulled 60 calendar days after emission;
  `expiredDate` in the buffer status is that moment.
- Keg volume (AI 335x) is **not** part of the printed code; it is appended only in the
  utilisation report, which stays with СБИС in this phase.

## Outcome

An admin opens **«Коды маркировки»**, presses «Заказать», picks a product with a GTIN and
a quantity, and Markiro places the order in СУЗ, waits for the buffer, fetches every code
and stores it encrypted. From the order card the admin issues codes in batches: download
a TXT/CSV with full codes (crypto tail included) for СБИС or a typography, or open a print
page that lays one label per page in the label template's size and hands off to the
browser's print dialog and the label printer. Each issue is recorded with who, when and
which range, and issued codes never come back into the pool, so a later Station phase
cannot print a code the office already used.

## Decisions

1. **One order = one GTIN.** Maps 1:1 onto a СУЗ buffer, keeps the state machine and the
   card simple; multi-GTIN orders are a later extension of the same tables (a second
   product row), not a redesign.
2. **Fetch every code as soon as the buffer is active.** The pool then lives in Markiro,
   the buffer closes itself, the 48-hour rule never triggers, and the admin sees a
   complete order or a failed one, never a half-fetched one.
3. **Raw codes are stored, encrypted.** This is a deliberate exception to the
   "hash only" rule for scanned codes: an emitted code is the tenant's paid-for asset and
   must be printable later. Encryption reuses `ChzCryptoService` (AES-256-GCM, key from
   `CHZ_TOKEN_ENCRYPTION_KEY`) with AAD `tenantId/orderId/seq`, so a ciphertext cannot be
   moved to another row or tenant. The hash column uses the same canonical hash as
   `codes.code_hash`, so future joins with scans need no re-hashing.
4. **A new label purpose `product_km`** instead of reusing `product_duplicate`. Duplicate
   templates carry their own fields and meaning; the KM label is what the Station will
   print in phase 2 and must not depend on duplicate-policy validation.
5. **Issues are contiguous and by count.** The next batch always starts at the lowest
   unissued sequence number; the admin asks for N codes and the card shows the resulting
   range. Re-downloading or re-printing an existing issue is allowed and audited;
   returning an issue to the pool is not.
6. **Reports stay in СБИС.** The order export is the file for hand-applied codes;
   Station-scanned codes reach СБИС through the existing shift exports. No utilisation
   report, no introduction document, no keg volume in this phase.
7. **Detached signing is a signer-agent task, serialized per tenant.** The existing
   partial unique index (one open task per tenant and type) is kept; the runner waits for
   the slot instead of queueing multiple signatures. Order creation therefore takes
   seconds to about a minute (agent long-poll), which is acceptable for an office action.

## Components

### Tenant settings (`chestny_znak` channel)

`chzSignerSettingsSchema` gains:

- `omsId` — UUID from the СУЗ cabinet settings;
- `omsConnection` — UUID of the installation registered for Markiro;
- `omsContactPerson` — optional, 1–128 characters, copied into the order attributes.

`omsId` and `omsConnection` are either both present or both absent (schema refinement).
The base URL follows `environment` (production / sandbox) through a new
`CHZ_OMS_BASE_URLS` constant next to `CHZ_TRUE_API_BASE_URLS`. The admin channel page
shows the three fields under the existing signer panel with a hint that the installation
is registered in the СУЗ cabinet.

### Signer agent: two new task types

`CHZ_SIGNER_TASK_TYPES` becomes `["true_api_auth", "oms_auth", "sign_detached"]` in
`@markiro/db`, the platform contract and `signer-core`.

- **`oms_auth`** — payload `{ trueApiBaseUrl, omsConnection, inn? }`. The
  agent runs the existing `auth/key` → attached sign → `POST /auth/simpleSignIn/{omsConnection}`
  flow and returns `{ token }`. The cloud stores it in a new `chz_oms_tokens` table with
  the same three-column encryption as `chz_api_tokens`; `expiresAt` = obtainedAt + 10 h
  because the response carries no expiry. The scheduler creates `oms_auth` tasks only
  for tenants whose settings carry `omsConnection`, with the same lead time as True API
  (`CHZ_TOKEN_REFRESH_LEAD_MS`), and reports the token status next to the True API one
  in the signer panel.
- **`sign_detached`** — payload `{ purpose: "oms_order", orderId, dataBase64 }`, result
  `{ signatureBase64, certThumbprint }`. The agent signs exactly the decoded bytes with a
  detached CAdES-BES signature: `CryptSignMessage` with `fDetachedSignature = TRUE` in the
  CryptoAPI backend, `CADESCOM_CADES_BES` with detached mode in the CAdESCOM backend.
  Both backends stay behind the existing signer trait. Host Cargo tests reach only as far
  as the trait: a recording fake proves `sign_detached` and `sign_attached` are distinct
  paths (`signer.rs`), and the dispatcher test proves the bytes signed are exactly the
  decoded `dataBase64` (`runtime.rs`). The Win32 flag itself — `fDetachedSignature`,
  `bDetached` — is inside `#[cfg(windows)]` code no test here executes, and is verifiable
  only on Windows, by the sandbox run in the runbook. A Windows signer release is
  required before production use; the release path exists (`signer-stable-release.yml`).

Task payload and result live in `chz_signer_tasks.payload` / `result_summary` (jsonb).
Order bodies are under 1 KB; the signature is a few KB. Neither is secret; the journal
redaction stays limited to tokens.

### Cloud module `apps/api/src/modules/chz-km-orders/`

- `oms.client.ts` — fetch-injected client (pattern: `true-api.client.ts`): `ping`,
  `createOrder(body, signature)`, `getBufferStatus`, `getCodes`, `listBlocks`,
  `retryBlock`, `closeOrder`. Headers `clientToken`, `X-Signature`, `Accept`,
  `Content-Type`. Non-2xx → typed error with СУЗ `errorCode`/`fieldErrors` when present.
  The client sends the **stored body bytes** unchanged; it never re-serialises.
- `chz-oms-token.service.ts` — decrypt-on-demand access to the tenant's СУЗ token
  (pattern: `chz-token.service.ts`).
- `chz-km-orders.service.ts` — preflight, create, list, get, issue, retry.
- `chz-km-order-runner.service.ts` — the pg-boss state machine below.
- `chz-km-orders.controller.ts` — routes under `/chz-km-orders`.
- Domain additions in `@markiro/domain`: `CHZ_UNIT_TEMPLATE_ID_BY_GROUP` (group alias →
  `templateId` for `cisType: UNIT` from СУЗ table 270, listing only groups with exactly
  one UNIT template — a group with two, such as `otp` 14/15, is ambiguous and therefore
  absent). The map itself is defined in `packages/domain/src/chz/km-orders.ts` and is
  the single source of truth; the only entry this document needs to name is `beer` → 18,
  the group the runbook sends an operator down. Also the order body builder with a
  stable key order, and the TXT/CSV serialisers.

#### Preflight (synchronous, on `POST /chz-km-orders`)

Refused with a precise error code when: settings lack `omsId`/`omsConnection`; no active
signer agent; no СУЗ token yet (message tells the admin the agent is fetching one); the
product has no `gtin14`, is archived, or its product group has no UNIT template mapping;
quantity outside 1..150 000. Rate limits of СУЗ are not a concern at office volumes.

### Data model (Postgres, new migration)

`chz_km_order_state` enum: `created`, `signing`, `submitted`, `buffer_pending`,
`buffer_active`, `fetching`, `completed`, `rejected`, `failed`.

- **`chz_km_orders`** — `id`, `tenant_id`, `product_id` (composite tenant FK),
  `gtin14` char(14) snapshot, `product_group_alias`, `template_id`, `quantity`, `state`,
  `request_body` text (the exact bytes signed and sent; needed for retries and audit),
  `signer_task_id`, `oms_order_id`, `buffer_status`, `buffer_expires_at`,
  `available_codes`, `total_passed`, `fetched_count`, `issued_count`,
  `rejection_reason`, `error_code`, `error_message`, `attempts`, `deadline_at`,
  `created_by`, `created_at`, `updated_at`. CHECK constraints per state as in
  `chz_export_runs` (for example `completed` ⇒ `fetched_count = quantity`;
  `submitted`+ ⇒ `oms_order_id IS NOT NULL`). UNIQUE `(tenant_id, id)`.
- **`chz_km_codes`** — PK `(tenant_id, order_id, seq)`; `encrypted_code`, `code_nonce`,
  `code_tag` bytea; `code_hash` char(64); `block_id` uuid; `status` (`available` |
  `issued`); `issue_id`; composite FK to the order; UNIQUE `(tenant_id, code_hash)`;
  index `(tenant_id, order_id, status, seq)`.
- **`chz_km_issues`** — `id`, `tenant_id`, `order_id`, `kind` (`export` | `print`),
  `format` (`txt` | `csv` | null), `from_seq`, `to_seq`, `count`, `created_by`,
  `created_at`; composite FK to the order.
- **`chz_oms_tokens`** — same columns as `chz_api_tokens` plus `source_oms_connection`.

Schema tests, migration tests and the runtime-migration list are updated together with
the DDL. `chz_km_codes` is not partitioned: office volumes are tens of thousands of rows
per order, not the scan stream.

### Runner state machine (pg-boss queue `run-chz-km-order`)

Dedup and durability copy `chz-export-runner.service.ts`: `singletonKey` per order,
`stately` queue policy asserted at boot, durable claim, `MAX_PASSES` in the job payload
because `startAfter` creates a new job, and a `deadline_at` (48 h from creation) checked
**before** any token check so a tenant without a token cannot hold an immortal chain.

1. `created → signing`: build the order body (`productGroup`, `products[{gtin, quantity,
serialNumberType: OPERATOR, templateId, cisType: UNIT}]`, `attributes{releaseMethodType:
PRODUCTION, contactPerson?, productionOrderId: <our order id>}`), persist
   `request_body`, insert a `sign_detached` task. If the tenant's slot is busy (unique
   index), re-schedule in 30 s.
2. `signing → submitted`: when the task is `completed`, `POST /order` with the stored body
   and `X-Signature`; persist `oms_order_id`. A СУЗ validation error (4xx with a body)
   → `failed` with the message; a task `failed`/`expired` → back to `created`,
   `attempts + 1`, at most 5.
3. `submitted → buffer_pending | buffer_active | rejected`: poll `GET /order/status`
   every 30 s, growing to 5 min after ten passes. `REJECTED` → `rejected` with
   `rejectionReason` verbatim (it carries the ЧЗ validation text, for example an
   unknown GTIN).
4. `buffer_active → fetching → completed`: `GET /codes` in blocks of 10 000 (last block
   sized to the remainder). Each block is written in one transaction: the code rows,
   `block_id`, `fetched_count`. **Before requesting the last block**, reconcile
   `fetched_count` against `totalPassed` from the buffer status; if СУЗ handed out a block
   that never reached the database (crash between response and commit), list blocks and
   re-fetch the missing `block_id`s while the sub-order is still open. Only then take the
   final block. When `fetched_count = quantity` → `completed`, integration event with
   counts.
5. Any transport/5xx error → keep the state, `attempts + 1`, back off; token missing or
   expired → wait for the scheduler (re-schedule in 5 min) within the deadline.

Manual `POST /chz-km-orders/:id/retry` is allowed from `failed` (re-enters `created`) and
never from `rejected` (the admin fixes the product and orders again).

### Issuing codes

`POST /chz-km-orders/:id/issues` with `{ kind: "export" | "print", format?: "txt" | "csv",
count }` on a `completed` order: in one transaction take the lowest `count` available
codes ordered by `seq`, mark them `issued` with the new `issue_id`, bump
`issued_count`, write the issue row and an audit event (`chz_km_order.issue`: actor,
tenant, order, kind, range, count). Refused when `count` exceeds the available number.

- `GET /chz-km-orders/:id/issues/:issueId/file` — the export file. TXT: one full code per
  line, GS as the raw 0x1D byte (as in ЧЗ's own files), UTF-8 without BOM, LF. CSV: one
  column `code`, values quoted, same line ending. File name
  `km-<gtin14>-<from>-<to>.<ext>`.
- `GET /chz-km-orders/:id/issues/:issueId/codes` — JSON `{ codes: [{seq, code}] }` for
  the print page (browser session only, same authorization as the file).

Codes are decrypted only inside these two handlers; list and card endpoints return
counts and ranges, never codes. Responses carry `Cache-Control: no-store`.

### Admin UI

Mockups (pen.dev, 2026-09-18/19, owner-reviewed): «01 Заказы кодов — список»,
«02 Заказ кодов — карточка», «03 Диалоги», «04 Страница печати», «07 Боковое меню».

- **Sidebar regrouping ships with this phase** (mockup variant B). `NAV_ITEMS` keeps
  every route and only changes order and section keys: «Производство» = Обзор, Смены,
  Линии, Конфликты; new section **«Маркировка»** = Заказы кодов, Поиск кодов,
  Инвентаризации, Выбытие, Дезагрегация; «Справочники» = Каталог, Этикетки,
  Контрагенты, Операторы и сотрудники; «Оборудование и обмен» and «Организация»
  unchanged. The pickup badge moves with its item. The mobile navigation groups follow
  automatically because they are derived from the same list.
- Navigation entry **«Заказы кодов»** in «Маркировка» (route `/km-orders`), visible with
  the same access as the integration pages. List: product, GTIN, quantity, state (translated,
  with the ЧЗ reason on hover for `rejected`), received, issued, available, code expiry
  date (`buffer_expires_at`), created by/at. Empty state explains the СУЗ settings
  prerequisites with a link to the channel page.
- «Заказать» dialog: product picker limited to products with a GTIN, not archived, and
  with a supported product group; quantity; contact person prefilled from settings.
  Preflight errors render as field or banner errors, in the app's i18n.
- Order card: state timeline, counters, issue history with «Скачать ещё раз» / «Печать ещё
  раз», and two actions on a completed order: **«Выгрузить»** (count + format) and
  **«Печать»** (count). Both create the issue first, then either download the file or
  open the print page in a new tab.
- All text goes through the existing i18n files (ru/en).

### Print page

Route `/km-orders/:id/issues/:issueId/print`, rendered by the admin app without the
shell. It loads the issue's codes, resolves the product's `product_km` template
(product default → category default → organisation default → stock), renders every label
with the domain SVG renderer (the same model the editor preview and the Station use) and
emits one label per page: `@page { size: <w>mm <h>mm; margin: 0 }`, each label in a
`break-after: page` block sized exactly to the template. After the last label renders it
calls `window.print()`; the browser's dialog then targets the label printer attached to
the computer. The page shows the range and count above the labels only on screen
(`@media print` hides it) so nothing but labels reaches the printer.

Fields available to the template: every product field the duplicate template already
offers, plus `km.code`. (This spec originally proposed two further text fields,
`km.gtin` and `km.serial`; they were not built — see Deviation 1.) Date fields resolve
to empty strings on this page (there is no shift), and the stock template does not use
them.

### Label template purpose `product_km`

- `LabelTemplatePurpose` gains `"product_km"`; DTO enums, the DB CHECK constraint
  (migration), the editor purpose picker, scope and default resolution follow the
  existing `product_duplicate` code paths.
- Validation: a `product_km` template must contain exactly one `datamatrix` element bound
  to `km.code` (reuse the duplicate check, not the duplicate policy).
- A stock default template ships with the seed: DataMatrix, product name, GTIN and serial
  as text, sized for a common 58 × 40 mm label.
- The Station bundle does not receive `product_km` templates in this phase; the bundle
  schema is untouched.

## Security and audit

- Codes and tokens are encrypted at rest; raw codes never appear in logs, the
  integration journal, pg-boss payloads or error messages (errors carry `seq` ranges and
  block ids only).
- Every route is tenant-scoped and tested for cross-tenant denial, including the file
  and codes endpoints by issue id.
- Audit rows for order creation, retry and each issue carry exact actor, tenant, action,
  target and metadata (kind, format, range, count).
- `request_body` and the signature are kept for the life of the order as evidence of
  what was signed.

## Error handling summary

| Situation                                 | Behaviour                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| No СУЗ settings / agent / token           | Preflight refuses with a specific code; the UI links to the channel page      |
| Signing slot busy                         | Runner waits 30 s and retries; state stays `created`                          |
| Signer task failed or expired             | Back to `created`, up to 5 attempts, then `failed` with the task error        |
| СУЗ rejects the request (4xx)             | `failed` with the СУЗ message; retry allowed after fixing settings            |
| СУЗ rejects the order (buffer `REJECTED`) | `rejected` with `rejectionReason`; no retry, order again                      |
| Transport error / 5xx                     | Same state, backoff, attempts counted, deadline enforced                      |
| Block lost between response and commit    | Reconciliation before the last block re-fetches it by `block_id`              |
| Deadline (48 h) passed                    | `failed` with `deadline`; unfetched codes are annulled by СУЗ at its own pace |

## Testing

- **Domain:** body builder byte-stability (same input → identical bytes), template-id
  mapping, TXT/CSV serialisers with GS bytes, `product_km` validation.
- **DB:** schema tests, migration and runtime-migration tests for the enum, three tables
  and the CHECK constraints.
- **API:** OMS client with injected `fetch` (headers, error mapping, JSON `\u001d`
  handling); runner state transitions including slot-busy, task failure, rejection,
  reconciliation and deadline; encryption round trip with AAD binding (a row moved to
  another order fails to decrypt); issue transaction (no double issue under concurrent
  requests); controller access with cross-tenant denial; audit assertions on exact
  fields; scheduler creating `oms_auth` only for configured tenants.
- **Signer:** platform-contract fixtures for both task types; `signer-core` host tests
  with the fake backend asserting that the trait's detached and attached paths are
  distinct and that the bytes signed are exactly the decoded payload. The Win32 detached
  flag is not reachable from a host test.
- **Admin:** component tests for the list, dialog preflight errors, card actions and the
  print page's page count and `@page` size; API-client tests.
- **Manual:** sandbox run through the signer e2e runbook (extended): register a sandbox
  installation with the public sandbox registration key, obtain a СУЗ token, place a
  2-code beer order, fetch, export, print. Records the real response shapes for
  `simpleSignIn/{omsConnection}`, `order`, `order/status`, `codes`, and whether the
  sandbox validates the GTIN against the catalogue. Windows signing of the detached
  task is verified only by this run, never by host Cargo tests.

## Out of scope (later phases)

- Utilisation report through `POST /utilisation` (with keg volume AI 335x), receipts,
  and introduction into circulation through True API `lk/documents/create`.
- Printing from a device-local reserve on the Station and the handheld, with the
  "applied = printed and scanned" rule. Owner requirement recorded on 2026-09-18 for
  that phase: the operator sets a **pool size** (for example 30) and a **threshold**
  (for example 25 scanned out of the current pool); when the threshold is reached the
  station prints the next pool automatically on a dedicated code printer (a second
  printer with a different label width), and a manual «Напечатать N» button always
  remains. The reserve is replenished from the cloud while online and must last
  several pools offline. Mockups for that phase exist (pen.dev, to be saved under
  `docs/design-briefs/`): the work-screen KM strip at 1600×1000, 1280×720 and the
  narrowest supported 1024×768 with a pallet in the shift (targets ≥ 64 px per the
  station acceptance matrix), the full-screen «Настройка автопечати» dialog, the
  handheld work screen at 360×800 and its settings card, and a status pill
  «КМ 22/30 · авто» in the top bar for small heights.
- **Shift setup on one screen (station).** The owner wants the current multi-step
  «Новая смена» flow (GTIN → product → mode → pallets → box template → pallet
  template → production date → duplicate print with verification → reprocessing)
  rebuilt in the style of the auto-print dialog: one screen of setting rows with big
  controls and a «Что запустится» summary, required fields highlighted on start.
  Mockup «08 Станция 1280×720 — настройка смены одним экраном». Separate task, not
  part of the code-order phases, but the KM auto-print row must slot into it.
- Multi-GTIN orders, `SELF_MADE` serial numbers, `paymentType = 1`, `REAPPLY`.
- Registering the СУЗ installation by API once Markiro holds a partner
  `registrationKey`.
- Retention and archival of `chz_km_codes` beyond the tenant's general policy.

## Open questions for the sandbox run

1. Exact response body of `POST /auth/simpleSignIn/{omsConnection}` (documented as
   `{"token"}`; confirm no expiry field).
2. Whether the sandbox beer GTIN must exist in the National Catalogue for the order to
   pass validation, and the shape of the `REJECTED` reason text.
3. Whether `GET /codes` honours a 10 000 block size or returns fewer codes per call.
4. Whether the СУЗ cabinet lets a participant register an installation for a solution
   that is not in the partner registry (the production path until Markiro is listed).
