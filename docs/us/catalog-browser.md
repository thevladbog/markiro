# US catalog browser increment

Status: catalog implemented, locally verified and reviewed, 2026-09-05; product-profile UI added 2026-09-06 (verification below). Uncommitted; development-only; release locked.

## Available behavior

Products joins Parties and Locations in the existing isolated reference-data workspace. It uses shared Markiro UI components and tokens, English and U.S. Spanish, and the current light/dark themes. No RU application router, catalog screen, client, translations or regulatory controls are imported.

The list supports bounded name/GTIN search, active/archived/all filters and 50-row pagination. Opening a card loads its current server record. Loading, failed, refreshing and empty states are explicit; delayed list/detail responses cannot replace a newer view or reopen a closed card.

Users with `traceability.master_data.write` can create products, edit their names and optional GTIN, and archive/restore the same product identity. Auditor/read-only users see saved details without mutation controls. The API independently enforces fresh membership and tenant scope. A denied write refreshes presentation capabilities; session loss exits the workspace. No client-supplied tenant or profile is accepted.

Blank GTIN becomes null; supplied GTIN uses the existing GS1 validator. Edits send only changed fields. A canonically unchanged edit sends no request. Archive/restore sends only the status field and requires confirmation. Active-GTIN collisions and locked operational identifiers have separate translated explanations. Other server details are not displayed or retained.

Unsaved edits survive locale changes and failed saves. Closing a dirty form requires confirmation. Inputs, navigation and repeat mutations are blocked while a mutation and its subsequent list refresh settle. Validation summaries receive keyboard focus; the shared modal drawer retains keyboard focus and has a visible close action. There is no autosave, offline outbox, browser persistence of product drafts or automatic mutation retry. Connection-loss copy instructs users to check the saved record before retrying.

After successful creation, editing or status change, keyboard focus moves to the stable catalog heading once mutation ownership settles, including when the affected row disappears from the current filter. A transient permission-refresh failure after a denied write preserves the mounted draft and disables further writes. Permission retry is available inside the form and returns focus inside it; a recovered capability does not repeat the write automatically. Explicit read revocation or session loss removes protected content instead of preserving a usable workspace.

The catalog proxy permits the exact `/api/us/traceability/catalog/products` collection and UUID item paths, rewritten to the isolated US API. The subsequent profile increment adds the single UUID path described below. Nested profile/export paths, malformed IDs, unrelated business routes and RU routes remain closed. Readiness remains 503. Lots and their event/export consumers are unfinished; this catalog makes no package-readiness claim.

## Product-profile increment — 2026-09-06

The product details card now opens a full-width profile within the same workspace, grouped into Product Description, Packaging and Coverage Review. It follows the approved Pencil grouping and shared Markiro tokens, without importing the RU router or adding unavailable history/lot tabs. English and U.S. Spanish, light/dark themes, desktop/tablet and narrow layouts use the same form. The reviewer is an opaque historical user ID, not an invented display name; recorded time uses the organization's time zone.

GET/PUT use only `/api/us/traceability/products/:productId`; the proxy requires an exact UUID item path without query parameters. Collection, deletion and nested routes are not opened. Strict response validation checks product identity; strict PUT sends only editable fields plus the loaded revision. Blank optional values become null, and packaging amounts remain exact decimal strings. Reads never create a profile. The generic profile shows the fixed applicability-not-assessed statement instead of classification controls. Processor coverage is a manual review, never a compliance verdict or evidence that a request package is ready.

Description editors cannot change coverage; QA permission is also required for all five coverage fields. Review metadata always comes from the server. A conflicted draft remains visible and cannot be resubmitted until an explicit, confirmed reload; failed reloads preserve it. A denied save refreshes capabilities, temporary refresh failures retain the draft while disabling writes, and explicit read revocation removes protected content. After QA revocation, a confirmed action discards only coverage edits and keeps permitted description/packaging edits. It does not clear a version conflict or advance the revision.

Dirty navigation and page unload warn before losing changes. Pending saves prevent repeat submission and workspace navigation. Locale/theme changes preserve the draft and do not refetch the profile; the actual app callback identity regression is covered, not just isolated form translation. Validation/save outcomes and access recovery restore keyboard focus. There is no browser draft persistence, autosave, automatic retry, source-URL fetch, source verification, event capture or history rewrite.

The browser scenario uses synthetic source text and an example.com URL, not regulatory-source acceptance. It exercises real MFA, profile reads/writes, exact decimal persistence, server-stamped review, concurrent revision conflict, confirmed reload, exact audit actions, auditor access and EN/ES light/dark layouts at 1440, 1024 and 390 pixels. Unit/component tests separately exercise transient failures and permission changes. Follow the same fixture command below.

Final local verification: 1,121 admin tests across 99 files, 38 focused API/store/HTTP tests and 17 isolation contracts pass without skips. Admin typecheck/lint and US/RU builds pass; five existing RU lint warnings and build-size advisories remain. The real Chromium scenario passes after the draft/access corrections; screenshots were visually inspected. Scoped independent re-review has no remaining findings. Full API/primary-infrastructure and hosted checks were not rerun or claimed. See [implementation progress](implementation-plan.md#us-02-connected-product-profile-ui--2026-09-06).

## Verification

Focused client/component tests and real browser evidence are recorded in [implementation progress](implementation-plan.md#us-02-catalog-browser-increment--2026-09-05). The check-only workflow includes catalog client and UI tests. Chromium verification remains a separately invoked local check:

```sh
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev node --test tools/us-development/test/browser-flow.smoke.mjs
```

Follow [browser prerequisites](browser-entry.md#verification). The fixture starts local API/Vite listeners and creates/removes only its own random US database. It uses real MFA and real catalog HTTP writes; no business API responses are fabricated. Screenshot capture excludes authentication secrets. No base or primary database migration/provisioning is performed.

## Limits

Local Chromium checks are not hosted, hardware, native mobile or screen-reader acceptance. Spanish wording requires fluent review before operational use. The existing Pencil catalog/FTL compositions are design targets; this smaller connected catalog increment does not claim pixel-level canvas parity. No `.pen` changes, main-checkout edits, commit, push, merge, publication or deployment are included.
