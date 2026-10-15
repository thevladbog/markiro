# ИМП — final whole-part review (review commit 76f6adc28, base 2c726efba)

Scratch worktree `/tmp/claude/wt/rv-imp` (detached at 76f6adc28; tree restored, `git status --short` empty). Disposable Postgres 17 container `markiro-rv-imp-pg` (127.0.0.1:55621, cloud migrations 0001–0185) was used and removed.

## Verdict

**Needs fixes before the first real cut-over, and five of them before the first beta.** The host route, the credential handling and the page are solid. The re-verified fixes from Task 6 hold at HEAD: the `AdminImport` extractor checks the role before the body and returns fixed texts, and the field-by-field test is in place. I count 1 Critical, 4 Important and 9 Minor findings.

- **The Critical** is an SSCC duplicate on rollback. The tool emits no cut-over row for an extension of the organization's prefix that the cloud never issued (typically pallets). So nothing tells the owner to move that cloud counter, and the documented rollback re-issues the standalone's pallet serials.
- **The Important findings:**
  - the cloud's new A4 pallet-sheet templates are imported as thermal pallet templates;
  - a cross-tenant prefix collision exits 0 with a stderr line only, and is invisible when this tenant never issued under the prefix;
  - stale "migration deferred" statements remain in `standalone-install.md`;
  - nothing guards against a rehearsal file, or an old file, being imported into production.

## (a) Findings, most severe first

### Critical

**C1. No cut-over row for an unused extension of the organization's prefix, so the rollback duplicates pallet (or box) SSCCs.**

Where: `tools/standalone-export/sscc.mjs` `planSsccCounters` (rows only from counters/blocks/printed), `transform.mjs:476`, runbook §5 «для каждой строки сводки», §8 step 2 «повторных SSCC не будет».

Scenario: the client never cut a pallet block in the cloud. Pallets came late (#605 and later), so there is no `(prefix, 1)` `sscc_counters` row. The file then has only the `(prefix, 0)` row; I demonstrated it with a counter and a block for ext 0 only, and `planSsccCounters` returned one row. From there:

1. The standalone starts pallets at the wizard's 0.
2. The owner reseeds only the rows in the summary.
3. On rollback the cloud's `counterState` reports `nextSerial` = firstSerial (0) for pallets, and its first pallet block re-cuts 0…199.
4. The cloud then prints SSCCs the standalone already printed.

The runbook's §8.2 explicitly promises no duplicates. The page's SSCC table also hides that pallets start at 0. The same holds for boxes if the cloud never issued any.

Fix: always emit both extensions for `gln[0..9]`. With `issued` null, `standaloneStart` = firstSerial and `cloudReseedTo` = firstSerial + window. Add a transform test (org prefix with ext-0 data only → two rows) and update the runbook §5 wording ("every row, including «выдано —» rows of the organization"). The golden file already has both org rows, so it does not change.

### Important

**I1. A4 pallet-sheet templates (`label_templates.format = 'pallet_sheet_v2'`, migration 0183) are exported as ordinary `pallet` thermal templates, with no note, and the host accepts them.**

Where: `export.sql` templates SELECT (no `format`), `transform.mjs:272-298`, `host/src/validate.rs:490` (`template_spec` checks only object, depth and size).

Evidence:

- Migration 0183 seeds three such templates per organization («Палета А4 · вертикальная/горизонтальная/две А5»).
- Against the migrated Postgres I inserted the 0183 portrait sheet for the seeded tenant and ran `runPsql` + `buildExportFile`. It came out in `payload.templates` as `purpose: "pallet"`, spec `{schemaVersion: 2, kind: "pallet_sheet"}`, with no note.
- The domain's `labelTemplateSpecSchema.safeParse` gives false for it and true for a 0185 `organization_logo` label.
- I put the sheet spec into the golden file's pallet template, and the host `--test cloud_import` stayed green (20/20). So the host stores a sheet even as the organization's and a category's default pallet template. The fixture was restored and its sha256 checked.

Consequence: three broken «Палета А4» templates on every migrated site. They can be chosen for a shift in the office, and the station then refuses the shift at entry (`floor/shifts/shift-snapshot.ts:49`), which stops the line until the office replans.

Also silently not migrated (no note, missing from the runbook's lists):

- `org_profiles.default_pallet_sheet_template_id`
- `org_pallet_sheet_template_defaults`
- `shifts.pallet_sheet_template_id` (history, fine)

Fix:

- `export.sql`: `'format', to_jsonb(t)->>'format'` (tolerant of a pre-0183 copy, where the key is absent and becomes null, read as label_v1).
- `transform.mjs`: drop `format <> 'label_v1'` with `template_dropped` reason `pallet_sheet`. A product default pointing at one becomes `product_template_dropped`. Emit a count note `pallet_sheet_defaults_lost`, and add words in `import-notes.ts`/ru.json.
- Runbook §1: «А4-листы паллет не переносятся до плана А4». Carrying them into the standalone's sheet library is plan А4's job (CARRY).

**I2. A cross-tenant SSCC collision is a stderr line only, exit 0; it is invisible when this tenant never used the prefix; and the runbook's remedy is insufficient.**

Where: `export.sql` `prefixes` CTE (only this tenant's counter/block prefixes), `cli.mjs:sharedPrefixWarnings`, runbook §4.3.

- **(a)** «номера могут повториться» still writes the file and returns 0. Neither the file nor the page carries it.
- **(b)** Suppose another tenant of the same DB holds serials under this tenant's GLN prefix (a trial tenant with the same GLN) or a counterparty prefix, and this tenant itself has no counter or block there. Then `otherTenantsSscc` is empty and no warning appears, while the standalone starts at 1.
- **(c)** The runbook offers «поднять счётчик автонома выше чужого номера» as an alternative. But the other tenant keeps issuing in the live cloud after the cut-over, so raising once does not protect. Both are needed: stop or reseed the other tenant beyond the standalone's window, and raise the standalone's counter.

Fix:

- `prefixes` adds `substr(org_profiles.gln,1,9)` and the counterparties' GLN prefixes.
- A colliding row stops the export with `sscc_prefix_shared` (exit 2) unless `--accept-shared-prefix`.
- Optionally add a file note so the page shows it.
- Rewrite runbook §4.3.
- Add the survived mutant M11 (other tenants' block end `to_serial` → `from_serial`) as a seed row whose block end is the maximum.

**I3. `docs/runbooks/standalone-install.md` still says the migration is deferred.** Lines 17–19 say «перенос … — **отложен**, памятки перехода нет … Не обещайте клиенту перенос», and install step 6 at line 235 says «переноса данных из облака в пилоте пока нет». Both contradict the new memo. Fix: point to `standalone-cloud-cutover.md`, keep "not verified on real data/Windows", and change step 6 to «пустая база; перенос — по памятке переключения, только на новую площадку после мастера».

**I4. Nothing guards against a rehearsal file or a stale file being imported into production.**

Where: `CloudImportPage.tsx` (rehearsal is only an `Alert` plus one confirm sentence), the host (accepts `rehearsal: true`).

A file exported before the freeze — a rehearsal, or an earlier aborted cut-over — has SSCC starts below serials the cloud issued since, so importing it means duplicates. The page shows `exportedAt` but never its age.

Fix (code, small):

- for `rehearsal: true` the confirm dialog requires an explicit checkbox «это пробная установка, она будет удалена»;
- a warning when `exportedAt` is older than ~12 h;
- the done card for a rehearsal says «площадку удалить до переключения».

The full host-side forbid (owner question 9.1.2) needs an install mode that does not exist, so I recommend the page guard now. This blocks the cut-over, not the beta: in the beta the owner imports rehearsal files on purpose.

### Minor

- **m1. The CLI write is not atomic.** `writeFileSync(path, {flag:"wx", mode:0o600})` writes straight into the final name. On a disk-full or a kill, a partial file holding verifiers stays, and the re-run then fails with `EEXIST`. The temp+rename item queued as a FINAL WAVE item in imp-minors (T3 report) was **not done**; runbook §9.2 only documents it. Fix: write `<name>.partial` with `wx`, 0600 and fsync, then `linkSync(partial, final)` (no-overwrite) and `unlinkSync(partial)`; unlink the partial on any failure; add a test with a failing writer.
- **m2. The default `--out-dir .` can drop the credential file into the repository.** Running from the repo root, as the runbook's commands do, puts it in the working tree, and `.gitignore` has no `markiro-cloud-export-*.json`. Fix: add the ignore line, and either require `--out-dir` or refuse a directory inside a git work tree.
- **m3. Mutant M14 survived: the host's forward-only SSCC upsert has no boundary test.** `WHERE excluded.next_serial > sscc_counters.next_serial` → `>= current − 1` stayed green, which would lower a counter by one. Add a case where the file's start equals the site's counter and one where it is one below.
- **m4. `ssccPrinted` is filtered by `prefixes`.** A tenant's printed boxes under a prefix with no counter or block row (pre-block legacy boxes, which the spec §8.4 itself names) are ignored. Drop the filter for this tenant's own printed SSCCs; a foreign prefix only yields a harmless `unknown` floor row. This rides with I2.
- **m5. The «validation_failed = файл повреждён / другая версия» wording is not always right.** `require_groups` also answers `validation_failed` («no such product group»). The group lists are identical today (host 0008 copies cloud 0099, and nothing adds groups later), so this is DOC only.
- **m6. The organization logo is not migrated (listed), but the runbook does not say what that means for labels.** Imported templates carrying `organization_logo` (the 0185 standard labels) print a white area in the standalone (`label-renderer.ts:321`) until plan А4. Add one runbook line under §1 and §2.2 step 3.
- **m7. Two casts against the webview rules.** `cloud-import.ts:200,257` use `value as Record<string, unknown>`. Polish.
- **m8. Duplicate template names after the import.** The cloud's stock templates arrive as non-stock copies next to the wizard's (same names). Cosmetic; the runbook says «нетиповыми», so DOC.
- **m9. The plan's «Отклонения при исполнении» still says «План не исполнен» (dated 2026-10-11, Task 1 only).** The section (c) below replaces it.

### Verified as correct (re-verified at HEAD)

**SSCC arithmetic.** issued 9 999 gives start 10 000, issued 10 000 gives 20 000, pallet issued 0 gives 10 000, and box counter `next=1` adds no candidate. An exhausted prefix stops with `sscc_exhausted`. A non-9-digit prefix or extension ∉ {0, 1} gives `sscc_input_invalid`. A window must be > 0. `cloudReseedTo` is null at ≥ 10^7.

**Freeze rationale.** Runbook §3.3 (2 000/200 blocks) matches the cloud constants (`BOX_BLOCK_SIZE` comments, `PALLET_BLOCK_SIZE` 200), and the cloud reseed semantics described in §5 (`seedFloor`, `atomicSeedSscc`, `findSeedBlocker`, revocation) match `sscc.service.ts:139-334`.

**Shift numbers.** Month keys match (domain `shift-number.ts`, host `shifts::month_key`). The host has a single counter writer (`shifts.rs:289`). Forward-only is enforced in the route and tested.

**Credentials.**

- PIN PHC moves byte for byte.
- The tool's `hashBadge` equals the domain's `deriveDigestB64`/`verifyPhc` (checked).
- The import modules log nothing (`no_secrets_in_logs` and `cloud_import_logs`, both green unsandboxed).
- The audit row holds only the summary.
- `JSON.parse` errors are masked.
- Unreadable bodies get fixed texts.
- The page holds the file in a ref only: no react-query mutation, and it is cleared on done, replace, remove and unmount.

**Route.** One `begin_write`; `require_admin` before the body and again in the transaction; repeat by `importId`; `already_imported`; empty-site order; GLN; groups; dry run rolls back.

**CI.**

- `verify-static` builds the domain, then runs the tool tests.
- `verify-api-tests` runs them after `db:migrate` with `STANDALONE_EXPORT_TEST_DATABASE_URL`; the seed and cleanup in `finally` touch only fixed `imp-test-*` ids, and the credentials are the CI placeholders already in the job.
- `affected.mjs` routes `tools/standalone-export/` to both jobs; proto fixtures fall into the standalone default (verify_static).
- Nothing secret is printed: the test fixture hashes are test values.
- psql on `ubuntu-latest` is assumed (the runner image ships a PostgreSQL client), not exercised (no push).

## (b) TRIAGE

| Item                                                           | Source                     | Status at HEAD                                                 | Decision                                                  | Reason                                                  |
| -------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| Dropped non-MONYY counter surfaced                             | imp-minors 1 / T1 m1       | `shift_counter_unreadable` throws; tested                      | DROP (done)                                               | verified                                                |
| `max(number_seq)` cross-check                                  | imp-minors 1               | `shiftNumberMaxima` → `shift_counter_behind`; mutant M5 killed | DROP (done)                                               | verified                                                |
| Domain built before equivalence test in CI                     | imp-minors 1 / m5          | ci.yml verify-static                                           | DROP (done)                                               | verified                                                |
| RangeError → `sscc_input_invalid`                              | T1 m2                      | done                                                           | DROP                                                      | verified                                                |
| `windowOf` validation                                          | T1 m3                      | done                                                           | DROP                                                      | verified                                                |
| Cross-tenant prefix maxima                                     | T1 m4                      | stderr-only, prefixes too narrow                               | **FIX** (I2)                                              | collision possible, exit 0                              |
| affected.mjs for sscc-serials.json; narrowed catch             | T1 m5                      | proto fixtures → verify_static; `ERR_MODULE_NOT_FOUND`         | DROP (done)                                               | verified                                                |
| Runbook: read cross-tenant warning; shift_counter_behind stops | T3 report                  | runbook §4                                                     | DOC (rewrite with I2)                                     | remedy text insufficient                                |
| CLI temp+rename (FINAL WAVE)                                   | T3 report                  | **not done**                                                   | **FIX** (m1)                                              | partial file with verifiers                             |
| Delete-after-import warning                                    | T3 report                  | CLI stderr + page + runbook                                    | DROP (done)                                               | verified                                                |
| Host never logs request / audit without verifiers              | T4 report                  | tests green                                                    | DROP (done)                                               | verified                                                |
| badgeSalt absent = keep site salt                              | T4 report                  | done                                                           | DROP                                                      | verified                                                |
| T6 m1 ApiJson quoting                                          | T6 review                  | `AdminImport` fixed texts                                      | DROP (done)                                               | verified                                                |
| T6 m2 / owner: loopback-only import                            | T6 review, OWNER-DECISIONS | open; documented §9.1.1                                        | CARRY (owner)                                             | owner decision; default kept                            |
| T6 m3 role before body                                         | T6 review                  | done                                                           | DROP                                                      | verified                                                |
| T6 m4 SSCC rev pinned                                          | T6 review                  | done                                                           | DROP                                                      | verified                                                |
| T6 m5 dry run of done import                                   | T6 review                  | pinned                                                         | DROP                                                      | verified                                                |
| T6 m6 one file → one site; rehearsal not on prod               | T6 review                  | runbook §0.5, §9.1.2                                           | **FIX** (I4, page guard)                                  | operator error = SSCC dup                               |
| T8 c2 leaving page mid-import                                  | T8 report                  | runbook §6.2 explains                                          | DROP                                                      | documented, safe (repeat → already_imported, audit row) |
| T8 c4 rehearsal importable                                     | T8 report                  | —                                                              | **FIX** (I4)                                              | as above                                                |
| T9 c1 install.md stale                                         | T9 report                  | not fixed                                                      | **FIX** (I3)                                              | doc lies                                                |
| T9 c2 cabinet names «сверить на месте»                         | T9 report                  | marked                                                         | DROP                                                      | honest                                                  |
| T9 c6 spec §31 renumber at merge                               | T9 report                  | noted                                                          | CARRY (merge)                                             | controller                                              |
| C1 org prefix both extensions                                  | this review                | —                                                              | **FIX**                                                   | rollback duplicates                                     |
| I1 A4 sheets                                                   | this review                | —                                                              | **FIX** (drop + note); carrying sheets → CARRY to plan А4 | broken templates, line stop                             |
| m3 forward-only boundary test (M14)                            | this review                | —                                                              | FIX (test)                                                | guard unpinned                                          |
| m4 ssccPrinted filter                                          | this review                | —                                                              | FIX (with I2)                                             | legacy boxes ignored                                    |
| m5 validation_failed group wording                             | this review                | —                                                              | DOC                                                       |                                                         |
| m6 logo blank on labels                                        | this review                | —                                                              | DOC                                                       |                                                         |
| m7 casts                                                       | this review                | —                                                              | DROP / polish                                             |                                                         |
| m8 duplicate template names                                    | this review                | —                                                              | DOC (exists)                                              |                                                         |
| m2 out-dir in repo                                             | this review                | —                                                              | FIX (with m1)                                             | credential file in work tree                            |

### Fix wave (≤ 5 commits)

1. **`fix(standalone-export): both extensions of the organization's prefix in the cut-over table; A4 pallet sheets left out with a note`** (C1 + I1).
   - `sscc.mjs`/`transform.mjs` take the org prefix as a required key.
   - `export.sql` adds `'format', to_jsonb(t)->>'format'`; `transform.mjs` drops sheets (`template_dropped` reason `pallet_sheet`; `product_template_dropped`; `pallet_sheet_defaults_lost` count read from `default_pallet_sheet_template_id` and `org_pallet_sheet_template_defaults` via `to_jsonb`, tolerant).
   - Add a sheet row to `raw-cloud.json` and `seed-cloud.sql`, regenerate the golden file, and update the notes/checksum expectations in the proto, host and Vitest suites. Add `import-notes.ts` + ru.json words.
   - Runbook §1/§5.
2. **`fix(standalone-export): a prefix another tenant issues under stops the export`** (I2 + m4 + M11).
   - `prefixes` += org and counterparty GLN prefixes; `ssccPrinted` unfiltered for this tenant.
   - `sscc_prefix_shared` (exit 2) unless `--accept-shared-prefix`.
   - A SQL seed row where the other tenant's block end is the maximum.
   - Rewrite runbook §4.3.
3. **`fix(standalone-export): the transfer file appears whole or not at all`** (m1 + m2): partial + link + unlink, cleanup on failure; `.gitignore` `markiro-cloud-export-*.json`; refuse an `--out-dir` inside a git work tree (or require the flag); tests.
4. **`fix(standalone): a rehearsal or old file asks twice before it is imported; forward-only boundary pinned`** (I4 + M14): page checkbox for rehearsal, export-age warning (> 12 h), rehearsal done-card line, ru.json keys, Vitest; host test for the equal and one-below SSCC counter.
5. **`docs(standalone): install runbook points to the cut-over memo; logo, group and template notes`** (I3 + m5 + m6 + m8): fix `standalone-install.md` lines 17–19 and step 6; add the cut-over memo lines; replace the plan's «Отклонения при исполнении» with (c).

Before the first beta: commits 1, 2, 3 and 5. Commit 4 before the first real cut-over; it can ride along if time allows.

## (c) Отклонения при исполнении (для плана, заменяют запись от 2026-10-11)

- **Задачи 1–9 исполнены** на ветке `claude/imp-cloud` (от `2c726efba`, последний коммит `76f6adc28`). Ревью по задачам — только у задачи 1 и задачи 6 (с исправлением `ef91b772b`). Задачи 2, 3, 4, 5, 7, 8 и 9 прошли только итоговое ревью всей части.
- **Задача 2 приостанавливалась (`NEEDS_CONTEXT`).** Причина — хеши PIN и бейджей и соль в файле. Решение контроллера 2026-10-11 (вариант А, владелец может переиграть): файл несёт `pinPhc`, `badgePhc`, `badgeSalt`; открытых кодов в нём нет; файл чувствителен.
- **Обязательные добавки задачи 1 (imp-minors 1–3) исполнены.**
  - `shift_counter_unreadable` останавливает выгрузку.
  - Сверка `max(number_seq)` со счётчиками — новая остановка `shift_counter_behind`, и при `--rehearsal` тоже (в плане такой остановки не было).
  - `RangeError` из `sscc.mjs` — код `sscc_input_invalid`.
  - Проверка окон в `windowOf`.
  - CI собирает домен до теста; `catch` сужен до `ERR_MODULE_NOT_FOUND`.
- **Межарендаторная проверка SSCC (m4) сделана слабее, чем просил m4.** Она только читает: `otherTenantsSscc` превращается в предупреждение в stderr, в файл и на страницу не попадает, на стартовые номера не влияет (чтобы эталонный файл не менялся). Итоговое ревью требует остановки выгрузки (I2).
- **`package.json` в задаче 3 не менялся:** строка `test:standalone-export` появилась ещё в задаче 1.
- **Запись «файл целиком или никак» (временный файл и переименование) не сделана.** Она стояла в imp-minors как пункт финальной волны; в памятке есть только совет удалить неполный файл.
- **Маршрут импорта получил собственный извлекатель `AdminImport` (правка ревью задачи 6).** Роль администратора проверяется до чтения тела; любой нечитаемый запрос получает фиксированный текст без значений. Добавлены тест «каждое поле файла попадает в свою колонку» и тест умолчаний категорий с разными группами.
- **Сухой прогон с `importId` уже сделанного переноса возвращает сохранённый итог** (`dryRun: false`, `repeated: true`). Это закреплено тестом.
- **Страница вызывает хост через `call`, а не через `useOfficeMutation`:** иначе мутация держала бы запрос с хешами в кэше react-query. Файл хранится только в `useRef`.
- **Номер раздела спецификации — §31:** §25–§30 заняты другими потоками. При слиянии раздел перенумеровывается, ссылки в памятке и `AGENTS.md` правятся вместе с ним.
- **`docs/runbooks/standalone-install.md` в задаче 9 не исправлен** (его не было в списке файлов): там всё ещё «перенос отложен». Исправление идёт волной правок.
- **Итоговое ревью нашло:**
  - нет строки переключения для неиспользованного облаком расширения префикса организации, поэтому откат повторяет SSCC (C1);
  - А4-листы паллет облака (0183) переносятся как термошаблоны паллет (I1);
  - межарендаторный префикс не останавливает выгрузку (I2);
  - нет защиты от пробного или старого файла в боевой установке (I4).

  Всё это закрывает волна правок из пяти коммитов.

## Evidence

**Build and focused suites at 76f6adc28:**

- `cargo build --workspace --tests --offline --locked` — green (48.7 s).
- `node --test tools/standalone-export/test/*.test.mjs` — 108 tests: 107 passed, 1 skipped (SQL, no DB).
- `export-sql.test.mjs` with the disposable Postgres 17 (all cloud migrations to 0185 applied) — 1/1 passed.
- `cargo test -p markiro-host --test cloud_import --test cloud_import_rules` — 20 + 22 passed.
- `-p markiro-proto --test cloud_import` — 11 passed.
- Unsandboxed `--test cloud_import_logs --test no_secrets_in_logs` — 1 + 2 passed.
- Vitest `test/cloud-import.test.ts test/cloud-import-page.test.tsx` — 2 files, 53 passed.

**Experiments:**

- **A4 sheet in the real export.** Inserted the 0183 A4 sheet plus the 0185 «Палета 75×120» (with `organization_logo`) into the seeded tenant. The export puts both into `payload.templates` as `pallet` with no note. The domain `labelTemplateSpecSchema` gives the sheet false and the logo label true.
- **Host accepts the sheet.** With the sheet spec put into the golden file's pallet template (the organization's and category 8's pallet default), host `--test cloud_import` stayed 20/20 green. The fixture was restored; `shasum -c` OK.
- **C1 demonstration.** `planSsccCounters` with ext-0 counter and block only returns a single row, with no pallet row.
- **Badge hashing.** `hashBadge` equals the domain's `deriveDigestB64` and passes `verifyPhc`.

**Mutants** (harness `/tmp/claude/rv-imp-scratch/mut.py`; every file restored with cmp and sha256; Rust files touched; final `git status --short` empty):

| #   | Mutant                                               | Result               |
| --- | ---------------------------------------------------- | -------------------- |
| M1  | `standaloneStart` ceil without +1 (off-by-one)       | killed               |
| M2  | printed max ignored                                  | killed               |
| M3  | `cloudReseedTo` `<` → `<=`                           | killed               |
| M4  | consumed max ignored                                 | killed               |
| M5  | `shift_counter_behind` tolerates −1                  | killed               |
| M6  | CLI `wx` → `w`                                       | killed               |
| M7  | cross-tenant boundary `>=` → `>`                     | killed               |
| M8  | `export.sql` block max `to_serial` → `from_serial`   | killed               |
| M9  | printed pallets dropped                              | killed               |
| M10 | stale device with null `last_seen_at` ignored        | killed               |
| M11 | other tenants' block end `to_serial` → `from_serial` | **survived** (m4/I2) |
| M12 | archived duplicate GTIN refused                      | killed               |
| M13 | `lastSeq` 0 accepted                                 | killed               |
| M14 | SSCC upsert lowers counter by 1                      | **survived** (m3)    |
| M15 | own templates not "non-empty"                        | killed               |
| M16 | checksum not compared                                | killed               |
| M17 | file kept after done                                 | killed               |
| M18 | double-submit guard removed                          | killed               |
| M19 | import enabled without check                         | killed               |

## Owner checklist on the REAL client data (prioritized)

1. **Run a rehearsal on a fresh restored copy.**
   - Keep the exit code, the whole stdout (summary + checksum) and the whole stderr.
   - Run the tool from a personal folder outside the repo, with `--out-dir` set to a `chmod 700` folder.
2. **The SSCC table, for every prefix and extension.**
   - Compare «выдано облаком до» with the cabinet's «Счётчики SSCC» and with the highest SSCC of the last boxes and pallets (code search).
   - **Until C1 is fixed:** if the organization's prefix lacks a pallet (or box) row, move that cloud counter by hand to standalone start + 100 000 (pallets) or + 1 000 000 (boxes) in the cut-over step, and write it in the protocol.
3. **Check other tenants on the same 9-digit prefix**, read-only on the copy:
   - `sscc_counters`/`sscc_blocks` rows of other tenants with `issuer_prefix = <first 9 digits of the GLN>`;
   - `org_profiles` with a GLN that shares the same 9-digit prefix.

   If any exist: stop. Decide (stop or reseed that tenant too) before the cut-over, not after.

4. **A4 pallet sheets.** Count the client's templates with `format = 'pallet_sheet_v2'` and shifts that used them. Until I1 is fixed, archive or disable every imported «Палета А4 …» template right after the import, and never choose it for a shift. Tell the client that A4 sheets come with plan А4.
5. **Read every note with the client:** `operator_dropped`, `badge_dropped`, `product_dropped`, `template_dropped`, `template_default_dropped`, `product_value_cleared`, `counterparty_sscc_used` (if present, there is no cut-over without a decision), `planned_shifts_not_moved`, `sscc_window_does_not_fit`.
6. **Trial site.** Check:
   - record counts equal the summary;
   - a sample of operators signs in with the old PIN and badge on a real station (Windows);
   - every imported template prints on the client's real printer (Cyrillic, DataMatrix, SSCC scan); logo areas will be blank;
   - the standalone «SSCC» screen ≥ «автоном начнёт с» for both extensions.
7. **Shift numbers.** The summary's month counters match the cloud's last shift number for each month; `shift_counter_behind` never appeared.
8. **Cut-over day, in this exact order:**
   1. close and export all cloud shifts;
   2. sync the station (queue and quarantine 0, no `blockedBy`);
   3. freeze the cloud;
   4. take the copy AFTER the freeze;
   5. run the export (exit 0; read stderr);
   6. reseed every summary row in the cabinet, including the organization's both extensions, and check that the cabinet shows the values;
   7. on the host PC: wizard with the same GLN → «Проверить» → «Перенести»; compare the checksum prefix with the cut-over summary;
   8. first shift, then the ЧЗ upload;
   9. host backup.
9. **Never import a rehearsal file, or any file exported before the freeze, into production.** One file goes to one site.
10. **Delete the file everywhere.** Format the flash drive, then delete the file from the host PC and the owner PC. Delete the temporary Postgres instance of the copy. After any write error, delete a partial file.
11. **Keep the cloud read-only for the agreed rollback period.** On rollback:
    1. close the standalone's shifts and keep its database;
    2. confirm every cloud counter (both extensions, every prefix the standalone issued under) is above the standalone's «SSCC» screen values;
    3. only then start the cloud station.
