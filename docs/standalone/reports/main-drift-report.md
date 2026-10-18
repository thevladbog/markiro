# main drift → apps/standalone parity digest (2026-10-11)

Read-only analysis. Nothing was fetched, downloaded, built or run; every test
outcome below is a prediction from reading the merged tree, not a run.

## 0. Baseline: what changed while this report was being written

- `origin/main` = `e5ca750fd` (#704). The fork's merge-base with
  `claude/integration` was `f9748bac1`, with 55 commits on main after it.
- **While the analysis ran, `claude/integration` moved to `9ac6f7495`
  "Merge origin/main into claude/integration" (15:31 +03).** The merge-base is
  now `e5ca750fd`, so main's code is already in the integration tree. The merge
  resolved two conflicts (`apps/api/src/modules/shifts/shifts.controller.ts`,
  `packages/domain/src/index.ts`) but changed **nothing under `apps/standalone/`
  or `packages/domain/test/fixtures/shift-export-parity/`**
  (`git diff --stat b02dac3f2 9ac6f7495 -- apps/standalone ...` shows only
  `.github/workflows`). So every follow-up listed in §2 and §5 is still open, and
  the merged tree probably has red standalone suites now (see §5, M1–M3).
- The standalone code was read from `/private/tmp/claude/wt/integ` (worktree of
  `claude/integration`, clean at `9ac6f7495`). The `ecstatic-swirles` worktree
  (branch `claude/autonomous-desktop-station-9e6f13`, HEAD `abf5d1954`) only
  holds docs. It does not contain the standalone sources at their current state.

## 1. Commits since the merge-base, grouped by theme

The commits below touch apps/station, packages/{domain,platform-contracts,db,ui},
tools/station-release or apps/api. "Meaning" comes from the diffs, commit bodies
and the specs or acceptance docs the commits added.

### A. ЧЗ shift exports

| Commit      | PR   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9a0f5a36f` | #681 | New format `shift_txt_boxes_reversed` v1 ("[TXT][С коробами][Обратная] Отчет смены"). It is the same boxes source as `shift_txt_boxes` v2, but each block is the box's codes, then its 20-digit `00`-prefixed SSCC, then a blank line. It is not pallet-gated and is inserted in `SHIFT_EXPORT_FORMATS` right after `shift_txt_boxes`. The raw 18-digit SSCC is now decided by membership in the legacy v1 list, not by `version >= 2`. Existing formats are byte-identical. The API DTO and OpenAPI accept the new id. |

### B. TSPL SSCC encoding / legacy `!1` labels

| Commit      | PR   | Meaning                                                                                                                                                                                                                                                                                                                  |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `42d83f736` | #692 | `generateTspl`: a Code128 element bound to `sscc` now emits `BARCODE …,"EAN128",…,"00<sscc>"`. Before, it emitted `"128"` with `"!100<sscc>"`, and the `!1` was printed literally into the bars, so the scanned SSCC was corrupt. ZPL is unchanged. Acceptance: `docs/acceptance/tspl-sscc.md` (physical check not run). |
| `30188717f` | #700 | `parseScannedSscc(raw, { allowLegacyBangOnePrefix })` is a new opt-in that reads misprinted `!1…` labels. The default behaviour is unchanged. Also admin support for legacy box labels and mobile scrolling.                                                                                                             |

### C. Standard thermal labels with logo, pallet 75×120

| Commit      | PR   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bbcfc9c05` | #703 | Domain label model: new element `organization_logo` (`source:"organization"`, `fallback:"markiro"`). New optional `fontFamily` (sans-serif/monospace), `lineHeight`, `minFontSizePt`, `textFormat` values `quantity_number`/`sscc_with_title`/`sscc_spaced`, and spec-level `gs1Constraint`, plus new refinements. `generateTspl`/`generateZpl`/`createLabelRenderPlan`/`renderMonoLabel` take an optional `logo` bitmap; with no logo the reserved area stays empty. `lineHeight` or `fontFamily` forces raster text. `RasterizeTextOptions` gains `lineHeight`, `minFontSizePx`. Stock box templates 75×120, 100×100 and 100×150 (dated, date-free, print-name) are replaced by `buildStandardLabelSpec`; 58×40 is unchanged. Stock pallet "Паллета 100×150" becomes "Палета 100×150" (standard layout with logo), and "Палета 75×120" is new. Migration `0185_standard_label_branding.sql` rewrites unedited stock specs in place in every tenant. The station rasterizer implements `lineHeight`/`minFontSizePx`, and the station passes the org logo or the bundled Markiro logo (`apps/station/src/lib/organization-branding.ts`, `box-printing.ts`). The handheld got a Kotlin port. |

### D. Editable A4 pallet sheets (V2)

| Commit      | PR   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `81b596d7b` | #702 | New `PalletSheetSpecV2` (`schemaVersion:2`, `kind:"pallet_sheet"`, A4 portrait/landscape/2×A5) with its own model, renderer (`pallet-sheet-render.ts`, `mono-compose.ts`), branding and `stored-template.ts` discriminator. Postgres migrations 0183/0184: `label_templates.format/revision/seed_key`, `shifts.pallet_sheet_template_id/_snapshot`, `org_profiles.default_pallet_sheet_template_id`, `org_pallet_sheet_template_defaults`. The station SQLite gains a V2 slot. The station prints sheets offline **through the Windows driver only**. New station routes were added to `tools/station-release/verify-api-cors.mjs`. Spec: `docs/superpowers/specs/2026-10-10-station-pallet-a4-printing-design.md`. |
| `e5ca750fd` | #704 | Station: full A4 preview and an A4 test print in workstation setup; print checks reset when the paper changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `e86bba8e8` | #705 | API: the station shift bundle carries the pallet-sheet template selection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### E. Windows driver label printing

| Commit      | PR   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1329be61c` | #696 | Printer profile gets a mode `raw` or `windows_driver`, allowed only for a Windows queue. In driver mode the label is rendered as a mono raster (`mono-render.ts`, `mono-raster.ts`) and sent as graphics through the driver, with recovery and retry for unknown outcomes. The ZPL/TSPL raw path stays the default. It covers test, box, pallet, inventory and product-duplicate labels. Spec: `docs/superpowers/specs/2026-10-10-station-windows-printing-design.md`. |

### F. Warehouse label reprint

| Commit      | PR   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd1fa6021` | #693 | "Складские операции → Повторная печать этикеток": scan any unit DM or box SSCC of the org (other stations, closed shifts), then reprint with a reason on chosen templates without creating identity. It fixes old `!1` labels with the same SSCC. Adds Postgres 0180–0182 (and seeds "SSCC короба 58×40") and new domain modules `warehouse-reprint/*`, `printer-commands.ts`, `render-plan.ts`. `generateZpl`/`generateTspl` were refactored with byte-identical output. |
| `3f59c4232` | #695 | Warehouse sessions polish (pause, finish, resumed choices). The template choice list with search and preview is reused at station shift setup. Adds an API shift label template preview endpoint and CORS routes.                                                                                                                                                                                                                                                         |
| `c4b356805` | #697 | Fixes warehouse roster checks and resumed previews (SQLite migration).                                                                                                                                                                                                                                                                                                                                                                                                    |
| `c60c09455` | #698 | Test only (file DB helper).                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### G. Station sync / reconciliation (cloud API + station)

| Commit      | PR   | Meaning                                                                                                                                                                                                                         |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `80eb79d75` | #701 | Station box reconciliation can be interrupted when sync pauses, and the grant-evidence lookup is batched per box with a single `json_each` tuple query instead of one query per member, so shift entry after a pause is faster. |
| `d4057aade` | #651 | The station's local disassembly trigger deletes the box's reconciliation discrepancy, and startup cleans discrepancies left on disassembled boxes.                                                                              |
| `fb2d5972c` | #646 | API: a warehouse pallet set by the handheld no longer counts as a `pallet_conflict` in station reconciliation.                                                                                                                  |
| `a5f7b21ed` | #650 | API: codes released by a box exception and rescanned in the **same batch** are no longer lost (`reclaimReleasedCodes`). The cloud applied exceptions after scans.                                                               |
| `e20139340` | #652 | Test only.                                                                                                                                                                                                                      |

### H. Station native shell (Rust)

| Commit      | PR   | Meaning                                                                                                                                                                                    |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `d3c315a8e` | #659 | `grant_atomic_execute` refuses a statement whose first word is `END` (SQLite runs it as COMMIT, which gave partial commits). Validation moved into `execute()`.                            |
| `b78b991bb` | #663 | Station data (`station.json` and `station-mirror.db`) moves once from roaming `%APPDATA%` to `%LOCALAPPDATA%` (claim, copy, verify, commit, plus a durability guard).                      |
| `b79414b7b` | #665 | A failed SQLite open is no longer cached, plus storage doc fixes.                                                                                                                          |
| `a8ba0ed99` | #666 | `ReplaceFileW` is replaced by `MoveFileExW(REPLACE_EXISTING\|WRITE_THROUGH)` plus a guard. Errors 1176/1177 could lose `station.json`, which led to a new machine_id and a sealed station. |

### I. Release tooling, CORS, deploy

| Commit              | PR   | Meaning                                                                                                             |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| `41ac5c3bd`         | #644 | Station changelog: credential prose is checked only in the rendered stable-notes line.                              |
| `aaed22588`         | #699 | Changelog allows bare markers in unpublished bodies.                                                                |
| (in #693/#695/#702) |      | `tools/station-release/verify-api-cors.mjs` lists the new station routes (warehouse reprint, template preview, A4). |
| `0ebdcb5a4`         | #694 | Deploy: API-only production rollout.                                                                                |

### J. packages/ui

| Commit      | PR   | Meaning                                                                                    |
| ----------- | ---- | ------------------------------------------------------------------------------------------ |
| `fea5ea848` | #656 | `resetToasts()` is exported: it unmounts the toast root, for test teardown.                |
| `4b0538b71` | #655 | `tokens.css`: `:root, [data-theme="light"]` (light tokens restorable inside a dark scope). |

### K. Dependencies

| Commit      | PR   | Meaning                                                                                                                                                            |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `2accb8457` | #690 | npm security overrides. **rustls 0.23.45 (GHSA-2mjx-qc3c-rqvc) in station and signer**, plus rustls-webpki 0.103.15. multer `limits.parts` fix in API controllers. |

### L. API/contracts with no station or standalone bearing

#667 `65dbb25ca` (product-label history for the compact duplicate print control),
#672 `bfb5fc314` (tenants without cabinet; platform-contracts `tenants.ts`;
migration 0176), #679 `67b64ee8f` (platform report exports), #686 `a9a77ae7f`
(support chat; migrations 0177–0179; platform-contracts `support-chat.ts`),
#670/#674/#678 (billing print forms, offers), #682 (demo requests). Station
commits that only touch the dev gallery (instruction screenshots):
#649 `5a981adef`, #653 `a1d7cf21f`, #654 `dc6892470`, #658 `63e5f5640`.

## 2. Per theme: must the standalone follow, and where

**A. #681 reversed TXT: yes, mandatory (the parity contract is byte-bound).**
The standalone office port takes the format list from `@markiro/domain`
(`apps/standalone/src/office/exports/export-checks.ts:83` filters
`SHIFT_EXPORT_FORMATS`) and renders through the domain (`run-export.ts` with
`renderShiftExport`). After the merge the office offers and renders the new
format automatically, with correct bytes. What breaks or must change:

1. Host allowlist `apps/standalone/host/src/routes/office_exports.rs:33`:
   `SHIFT_FORMATS: [(&str,u32);10]`. Insert `("shift_txt_boxes_reversed", 1)`
   after `("shift_txt_boxes", 2)` (length 11). Until then, `POST
/v1/office/shifts/{id}/exports` (line 265 `!SHIFT_FORMATS.contains`) refuses
   the record **after** the office has already saved the files, so the audit
   trail loses the export.
2. `apps/standalone/proto/fixtures/export-formats.json`: same insertion.
   `apps/standalone/test/protocol.test.ts:936` asserts the fixture equals the
   domain list, so it fails now. `host/tests/office_exports.rs:945-969` and
   `proto/tests/fixtures.rs:1333` read the fixture too.
3. Golden: `packages/domain/test/fixtures/shift-export-parity/golden.json` has
   0 entries for the new format, while both `apps/api/test/standalone-export-parity.test.ts:119`
   and `apps/standalone/test/export-parity.test.ts:143` iterate
   `SHIFT_EXPORT_FORMATS`. Both "runs exactly the golden's exports" key checks
   fail. Regenerate from the cloud side only:
   `EXPORT_PARITY_WRITE=1 pnpm --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`
   (CI refuses the write mode). Expected diff: 21 new keys
   `<case>/shift_txt_boxes_reversed@1/<maxLines>`, one after each existing
   `/shift_txt_boxes@2/` key. Existing entries should be byte-identical (#681
   claims identical bytes for old formats).
4. Hard-coded lists: `apps/standalone/test/export-checks.test.ts:39-77` (the
   with-pallets list becomes 11; the without-pallets list becomes 6, so the
   "five" wording changes; the refusal list gains
   `["shift_txt_boxes_reversed","BOX_COVERAGE_INCOMPLETE"]`) and
   `apps/standalone/test/export-plan.test.ts:51-60` ("five formats" becomes six).
5. No i18n change is needed: the dialog shows the descriptor `label` from the domain.

**B. #692 TSPL EAN128: yes. The code arrives with the merge, but a test and a
physical acceptance are due.** The standalone prints with the domain emitters
(`apps/standalone/src/floor/print/label-emitters.ts` re-exports
`generateTspl`/`generateZpl`; the office uses `office/templates/label-print.ts`).
So box and pallet SSCC labels on TSPL printers are now correct. Before the merge
the standalone printed the corrupt `!1` barcode. Must change:
`apps/standalone/test/floor-label-render.test.ts:202` expects
`BARCODE 76,256,"128",38,0,0,2,2,"!100046006820000035007"`, which now becomes
`BARCODE 76,256,"EAN128",38,0,0,2,2,"00046006820000035007"`. The stock
`buildDatedBoxLabelTemplates()[0]` is 58×40, which #703 left unchanged. Pilot
acceptance: run `docs/acceptance/tspl-sscc.md` on the client's TSPL printer and
scanner (the decoded data must be `00`+SSCC with no `!1`). #700's legacy `!1`
reading is not needed, because no standalone labels are in the field. Upstream
gap: `packages/domain/src/labels/tspl-import.ts:135` accepts only `128`/`EAN13`,
so re-importing TSPL that the domain itself now exports (SSCC as `EAN128`)
fails. This affects the standalone `ImportCodeDialog` and the admin alike.

**C. #703 standard labels with logo: yes. These are the most consequential
follow-ups.**

- The wizard seeds the new layouts:
  `apps/standalone/src/wizard/wizard-form.ts:201-203` uses
  `buildDefaultLabelTemplates()`/`buildPalletLabelTemplates()` and
  `PALLET_LABEL_TEMPLATE_NAME`. A new site therefore gets 75×120/100×100/100×150
  box layouts with `organization_logo`, `lineHeight`, `fontFamily` and
  `minFontSizePt`, a renamed default pallet "Палета 100×150", and a third pallet
  template "Палета 75×120" (19 stock templates, under the host's
  `MAX_STOCK_TEMPLATES = 32`). `office/templates/editor-model.ts:45` takes
  pallet template [0] (the new 100×150) as the blank pallet spec. Cloud
  templates moved per pilot §8 also carry these properties after migration 0185.
- The rasterizer does not follow:
  `apps/standalone/src/labels/rasterizer.ts:103` keeps `ceil(fontSizePx*1.5)`
  and ignores `lineHeight`/`minFontSizePx`. The station's equivalent change is in
  `apps/station/src/lib/rasterizer.ts` (#703, about 24 lines: shrink-to-fit down
  to `minFontSizePx`, then throw if it still does not fit; line height
  `fontSizePx*(lineHeight??1.5)`). Without it, standalone prints differ from the
  cloud and the preview for the new stock templates, with taller text blocks and
  quantities that do not shrink. The office canvas preview
  (`office/templates/label-renderer.ts` `drawText`) also ignores `lineHeight`.
- Logo: the standalone never passes `logo`, so the logo box prints blank and the
  canvas preview's `switch (element.kind)` at `label-renderer.ts:295` silently
  skips `organization_logo`. The cloud station prints the org logo or the
  bundled Markiro logo. The standalone has no org logo (pilot question П15;
  `office/forms/form-data.ts:36`). Decision needed: bundle the Markiro print
  logo (as `apps/station/src/lib/organization-branding.ts` /
  `loadBundledMarkiroLogo` does) and pass it in
  `floor/print/label-render.ts:78`, the office preview and the downloads, or
  accept the blank reserved space.
- Fixtures and host tests still say "Паллета 100×150"
  (`proto/fixtures/bootstrap-request-templates.json`,
  `device-shift-entered-pallets.json`, `host/tests/bootstrap.rs` and others).
  This is cosmetic, since names are data.

**D. #702/#704/#705 A4 pallet sheets V2: not for the pilot.** The standalone
prints A4/A5 pallet placards and reports as HTML forms (plan О-Ф,
`renderPalletPlacardHtml` and related, printed via `iframe.print()` or the
browser). The forms renderers were not touched by main, so `forms-parity` is
unaffected. V2 needs Windows driver printing (E), a V2 template editor and host
storage of a second template format. Only the future cloud-to-standalone move
SQL (pilot §8, **not yet written**; only `tools/standalone-export/sscc.mjs`
exists) must filter `label_templates.format = 'label_v1'` and ignore
`pallet_sheet_v2` rows, `org_pallet_sheet_template_defaults` and
`shifts.pallet_sheet_template_*`.

**E. #696 Windows driver printing: not for the pilot unless the client's
printer needs it.** The standalone has TCP, COM and a Windows spooler queue with
RAW datatype (`apps/standalone/src-tauri/src/printer.rs`,
`printer/spooler.rs`). That covers any ZPL or TSPL printer. Driver mode matters
only for a printer without raw ZPL/TSPL, and it is required for A4 V2. Ask
through the pilot questionnaire (pilot spec line ~901, which already asks for
the connection method). If the answer is "yes", port the mono-raster path
(`renderMonoLabel` is in the domain already) and a GDI print command.

**F. #693/#695/#697 warehouse reprint: out of the MVP.** It has no standalone
equivalent. Pilot spec `2026-10-09-standalone-pilot-mvp-design.md` §4.2 leaves
out validation/duplicate DM and search by KM/SSCC, and the in-shift box and
pallet reprint with a reason exists already (`floor/print/print-resolution.ts`,
decision 36). The searchable template list with preview at shift setup (#695)
is a UX nicety: standalone `floor/shifts/NewShift.tsx` already offers the
template choice per decision 7 (`suggestBoxTemplate`, `fittingTemplates`). This
can wait.

**G. #701/#651/#646/#650: mostly not applicable.** The standalone has no
cloud reconciliation, grants or `offline_grant_*` tables. The host applies a
device batch record by record in order inside one transaction
(`host/src/routes/facts.rs`, loop over `batch.records`). So the cloud's
"exceptions after scans" ordering (#650) does not exist structurally, as long as
the station outbox keeps the order things happened in. Worth one host test:
disassembly or clear, then a rescan of the same codes into a new box, in one
`/v1/device/facts` batch. `host/tests/facts.rs` has no such case.

**H. #659/#663/#665/#666: already covered, with one optional hardening.**

- #659: `apps/standalone/src-tauri/src/local_db.rs:714-716` already refuses a
  leading `END`, with a test at line 818.
- #663: the shell uses `app_local_data_dir()` (`src-tauri/src/lib.rs:342-345`,
  with a comment about roaming). The host uses `%ProgramData%\Markiro\Host`
  (`host/src/config.rs:44-49`). There is no roaming-profile problem, so no
  migration is needed.
- #666: the standalone uses `fs::rename`, which is `MoveFileExW(REPLACE_EXISTING)`
  on Windows, not `ReplaceFileW` (`src-tauri/src/device_config.rs:87`,
  `host/src/config.rs:245`). The 1176/1177 loss path does not exist. The only
  gap is that there is no `MOVEFILE_WRITE_THROUGH`; adding it is optional.
- #665: if the webview caches a failed local-DB open, mirror the change. Not
  checked in depth; it can wait.

**I. Release tooling and CORS: not applicable.** The standalone has its own
`tools/standalone-release` and talks to no cloud route.

**J. packages/ui: no action.** The standalone does not use `toast`
(no `toast`/`resetToasts` import in `apps/standalone/src` or `test`). The
`[data-theme="light"]` selector is harmless: the office sets `data-theme="light"`
on `<html>` (`test/office.test.tsx:139`).

**K. #690 rustls: yes, a security fix.** `apps/standalone/Cargo.lock:3730`
pins `rustls 0.23.43`, which main treats as affected by GHSA-2mjx-qc3c-rqvc.
`rustls-webpki` is already at 0.103.15. The host serves the LAN API over TLS
(`host/src/tls.rs`). Bump with
`cargo update -p rustls --precise 0.23.45 --manifest-path apps/standalone/Cargo.toml`.

## 3. `@markiro/domain` exports consumed by apps/standalone, and which changed

The standalone imports 103 distinct names from `@markiro/domain` in `src/` and
`test/` (the host is Rust and imports nothing). It also imports `@markiro/ui`,
but not `platform-contracts` or `db`. The consumed names that main changed:

| Export                                                      | Change                                                                                                                         | Effect on standalone                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `SHIFT_EXPORT_FORMATS`                                      | +1 entry at index 2                                                                                                            | Office offers 11 formats or 6 without pallets. Fixture, host allowlist and golden must follow (§2A). |
| `renderShiftExport`, `getShiftExportFormat`                 | new id branch; old formats byte-identical                                                                                      | The new format renders. Old goldens are unchanged.                                                   |
| `shiftExportFormatRequiresPallets`                          | unchanged; new format has `boxMode:"boxes"`, so it is not gated                                                                | —                                                                                                    |
| `generateTspl`                                              | SSCC Code128 becomes `EAN128` + `00`; raster forced by `lineHeight`/`fontFamily`; optional `logo`; `organization_logo` element | Labels are correct now. `floor-label-render.test.ts:202` breaks. Logo is blank unless passed.        |
| `generateZpl`                                               | byte-identical for old specs (#693 refactor); new text options and logo for new specs                                          | Same logo and raster notes.                                                                          |
| `labelTemplateSpecSchema`                                   | accepts `organization_logo`, `fontFamily`, `lineHeight`, `minFontSizePt`, new `textFormat`s, `gs1Constraint`; new refinements  | Editor and import accept the new specs. A preview switch skips the logo.                             |
| `labelFieldDisplayValue`                                    | new `textFormat` branches; default branch unchanged                                                                            | Only new templates are affected.                                                                     |
| `elementBoundsMm`                                           | uses `lineHeight`; handles `organization_logo`                                                                                 | Geometry warnings in the editor follow the new templates.                                            |
| `buildDefaultLabelTemplates`, `buildDatedBoxLabelTemplates` | 75×120/100×100/100×150 replaced by standard layouts; 58×40 unchanged                                                           | The wizard seeds the new layouts (§2C).                                                              |
| `buildPalletLabelTemplates`, `PALLET_LABEL_TEMPLATE_NAME`   | 3 templates; "Паллета 100×150" becomes "Палета 100×150"; adds "Палета 75×120"                                                  | Wizard default pallet name and set change; editor blank pallet spec changes.                         |
| `RasterizeTextFn`/`RasterizeTextOptions` (types)            | + `lineHeight`, `minFontSizePx`, `overflow`                                                                                    | The standalone rasterizer compiles but ignores them (§2C, must-do).                                  |
| `parseScannedSscc`                                          | new opt-in `allowLegacyBangOnePrefix`; default unchanged                                                                       | None.                                                                                                |

Unchanged consumed exports include `wrapTextToWidth` (a strict variant was
added beside it), `needsImageRendering`, `mmToDots`/`ptToDots`, `kmHash`,
`classifyScan`, `buildSscc`, `formatSsccHri`, `parseLabelCode`/`parseLabelJson`,
`buildDuplicateLabelTemplate(s)`, the template-eligibility helpers, the PHC
helpers, `formatShiftNumber`, and the forms renderers (`render*Html`; these are
integration-only and untouched by main).

## 4. Station builds

Local tags as of the last fetch; I ran no fetch.
`git tag --list 'station-v*' --sort=-creatordate | head`:
`station-v2.3.0-beta.1, station-v2.2.0, station-v2.2.0-beta.3, -beta.2, -beta.1,
station-v2.1.0, station-v2.1.0-beta.9 … beta.4`.

- **Latest beta: `station-v2.3.0-beta.1`**, tag commit `baf613fd1` "chore(station):
  prepare 2.3.0-beta.1", 2026-10-11 05:49 UTC, parent `bbcfc9c05` (#703). It
  contains everything through #703. It lacks the station UI change #704 (A4
  preview and test print); #705 is API-only.
- **Latest stable: `station-v2.2.0`**, `9e153dbe2`, 2026-10-10 18:15 UTC, parent
  `c60c09455` (#698). It includes #692 (TSPL EAN128), #693/#695/#696/#697
  (warehouse reprint, Windows driver printing), the storage move
  #663/#665/#666, #651 and #659. It excludes #701, #702 and #703. The previous
  stable is `station-v2.1.0` (`6b14859cf`, 2026-09-25).
- **What the workflows publish:**
  - `Publish station beta` (`.github/workflows/station-beta-release.yml`):
    dispatched on `main`. Modes are publish, promote-existing and seed-baseline;
    bumps are next-beta, next-patch-beta, next-minor-beta and next-major-beta.
    It builds on `windows-latest` in environment `station-beta`, with
    `VITE_STATION_API_URL=https://admin.markiro.app`, running `tauri build` NSIS
    signed with the Tauri updater key.
  - Assets (`tools/station-release/artifacts.mjs:157-163`):
    `markiro-station-<v>-windows-x86_64-setup.exe`, `…nsis.zip`,
    `…nsis.zip.sig`, `latest.json`, `release-notes.md`, `release-evidence.json`.
  - Published twice, both immutable:
    (1) a GitHub prerelease `station-v<v>` in
    **`thevladbog/markiro-station-releases`**, plus the channel manifest
    `…/releases/download/station-beta-channel/latest.json`;
    (2) Yandex Object Storage served at
    **`https://releases.markiro.app/station/beta/releases/<v>/`**, with the
    channel `https://releases.markiro.app/station/beta/latest.json`
    (updater endpoints in `apps/station/src-tauri/tauri.conf.json:47-48`).
  - `Publish station stable` (`station-stable-release.yml`) is owner-only. It
    needs `owner_confirmation=PUBLISH-STATION-STABLE`, an accepted
    `source_beta_tag` and `acceptance_confirmed`, and promotes to
    `…/station/stable/…` and the GitHub `station-stable-channel`
    (`tauri.stable.conf.json`).
- **What "getting the current station builds" would take:**
  1. Refresh refs with `git fetch origin --tags`. That was outside my brief; the
     controller or owner runs it, and it may reveal tags newer than beta.1.
  2. List the releases with
     `gh release list --repo thevladbog/markiro-station-releases`, or read
     `https://releases.markiro.app/station/beta/latest.json` (network, read-only).
  3. **Download** an installer, for example
     `gh release download station-v2.3.0-beta.1 --repo thevladbog/markiro-station-releases --pattern '*setup.exe'`.
     This needs the owner's explicit permission (it is a file download; size is
     unknown until listed). Installing it needs a Windows machine.
  4. A build containing #704 does not exist yet. It requires dispatching
     "Publish station beta" on main (next-beta gives 2.3.0-beta.2). That
     changes external state and needs the owner's authorization; per memory,
     auto mode blocks such dispatches, so prepare the command and the owner runs
     it.

## 5. Ranked action list for the controller

### Must-do before the pilot

- **M1. Export parity for #681.** Touches `apps/standalone/host/src/routes/office_exports.rs:33`
  (`SHIFT_FORMATS`, 11 entries), `apps/standalone/proto/fixtures/export-formats.json`,
  `packages/domain/test/fixtures/shift-export-parity/golden.json` (regenerate
  with `EXPORT_PARITY_WRITE=1` from the API test), `apps/standalone/test/export-checks.test.ts`
  and `apps/standalone/test/export-plan.test.ts`. Gates: the standalone vitest
  export suites, `cargo test` for host `office_exports` and `proto` fixtures, and
  the API `standalone-export-parity` test.
- **M2. TSPL test expectation for #692.** `apps/standalone/test/floor-label-render.test.ts:202`.
  Add the physical TSPL SSCC scan check from `docs/acceptance/tspl-sscc.md` to
  the pilot acceptance list.
- **M3. Port the #703 rasterizer.** Add `lineHeight` and `minFontSizePx` in
  `apps/standalone/src/labels/rasterizer.ts` (mirror `apps/station/src/lib/rasterizer.ts`
  @ `bbcfc9c05`) and `lineHeight`/`fontFamily` in the office canvas preview
  `apps/standalone/src/office/templates/label-renderer.ts`. Without it the
  wizard's new stock templates print differently from the cloud and the preview.
- **M4. Decide the logo (owner, П15).** Either bundle the Markiro print logo and
  pass `logo` in `apps/standalone/src/floor/print/label-render.ts`, the office
  preview, thumbnails and downloads (`label-print.ts`), or accept a blank logo
  area on 75×120/100×100/100×150 labels. Also draw or mark the
  `organization_logo` box in `label-renderer.ts:295`.
- **M5. Security:** rustls 0.23.43 to 0.23.45 in `apps/standalone/Cargo.lock`
  (GHSA-2mjx-qc3c-rqvc; host TLS).
- **M6. Run the gates on merge `9ac6f7495`.** It carried no standalone
  follow-ups, so build first with
  `pnpm turbo run build --filter='@markiro/standalone^...'`, then run standalone
  vitest, typecheck, lint, `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`
  (in parts, per memory) and the API parity test. Expect M1/M2 failures and
  possibly wizard or template test drift from the renamed and new stock
  templates.

### Should-do

- **S1.** Host test: disassemble or clear, then rescan the same codes in one
  `/v1/device/facts` batch (the #650 analogue) in `apps/standalone/host/tests/facts.rs`.
- **S2.** Cloud-to-standalone move SQL (pilot §8, not yet written): take only
  `label_templates.format='label_v1'`; ignore V2 sheets and their defaults or
  snapshots; expect `organization_logo` in moved specs (migration 0185).
- **S3.** Ask the pilot client whether any printer lacks raw ZPL/TSPL. If so,
  port #696 driver printing. Otherwise record "RAW only" as the pilot decision.
- **S4.** Upstream domain fix: `packages/domain/src/labels/tspl-import.ts:135`
  should accept `EAN128`, so TSPL the domain exports can be re-imported
  (standalone `ImportCodeDialog`, admin).
- **S5.** Align fixture and test names "Паллета 100×150" to "Палета 100×150" in
  `apps/standalone/proto/fixtures/*.json` and `host/tests/*.rs` (cosmetic).

### Can wait

- A4 pallet sheets V2 (#702/#704/#705). The standalone uses HTML forms.
- Warehouse reprint mode (#693/#695/#697) and the searchable template picker
  with preview at shift setup.
- `MOVEFILE_WRITE_THROUGH` or a flush for `device.json`/`host.json` renames
  (`src-tauri/src/device_config.rs:87`, `host/src/config.rs:245`). Check that a
  failed local-DB open is not cached (#665 analogue).
- #701/#651/#646 reconciliation and #659: not applicable or already done.
- Station release tooling and CORS (#644/#699/`verify-api-cors.mjs`) and
  packages/ui (#655/#656): not applicable.
