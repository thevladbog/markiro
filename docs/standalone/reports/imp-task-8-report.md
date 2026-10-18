# Report: plan IMP Task 8 - webview page «Сервис → Перенос из облака»

Status: DONE_WITH_CONCERNS. Commit b75a3c30e `feat(standalone): «Перенос из облака» in the office: the file, a check, the import` on claude/imp-cloud (worktree /tmp/claude/wt/imp, base 44c909363). One `Co-Authored-By: Claude Opus 5.5` trailer. `git status --short` empty after the commit and after the final mutant run.

## What was done

Files: `src/office/import/import-notes.ts`, `src/office/import/CloudImportPage.tsx`, `src/office/nav.ts`, `src/office/routes.tsx`, `src/i18n/ru.json`, `test/cloud-import-page.test.tsx` (25 tests).

The brief's code was applied, then changed where the binding credential rules and review-class defects required it:

Credential handling (binding):

- The parsed file (verifiers, badge salt) lives ONLY in `useRef<HeldFile | null>` (`{file, importId}`). React state holds a `FileView` made once at read time: org name/INN/GLN, tenant name, exportedAt, the first 15 characters of the checksum (`sha256:9716b9df…`), the SSCC table rows (cutover counters), shift-number text and the notes already rendered to strings. No hash can be reached from it.
- The request is sent with `useOfficeSession().call(...)` + `api.importFromCloud`, NOT `useOfficeMutation`: react-query keeps a mutation's `variables` (the whole payload) in the mutation cache. The brief used `useOfficeMutation`; the test scans the mutation cache and would catch it.
- The ref is emptied on success (also on a dry run that answers `repeated`), when another file is chosen, on «Убрать файл» (new button), and in the unmount cleanup. A fixable refusal (GLN, a lost answer, site_not_empty) keeps it for the retry (the brief's test sends three refusals with one chosen file) - the file is dropped as soon as the flow ends or the operator takes it away.
- A read still in progress when a newer file is chosen or the page closes is dropped unseen (generation counter). Late answers of the host after unmount change nothing (not even `resetQueries`).
- The failure is stored as a text (never as the error object); `console` is untouched.

UX:

- File read through `readCloudExportBlob` (size cap before reading). Rejection words: not JSON / other format / shape (names the field PATH of the first Zod issue, never a value) / version / checksum / not `.json` (FileDropZone `onRejected`) / unreadable.
- Shows the rehearsal warning, org line, GLN mismatch warning against `GET /v1/office/org`, checksum prefix, the SSCC table, shift numbers, ALL the file's notes (24 in the golden file) in words; unknown note code / entity / field / reason / purpose are shown as they stand (explicit allow-lists in `import-notes.ts`, parity-tested against ru.json, because the test i18n throws on a missing key); the SSCC hint says the cross-tenant SSCC warning of the tool is on its stderr and not in the file.
- «Проверить» = dry run; «Перенести» enabled only after a successful check; the confirmation dialog names the counts of the check (new lines, counterparties, templates, products, operators, badges), says the import is irreversible and cannot be repeated with another file, and for a rehearsal file adds a line to import it only onto a rehearsal site. 400 ms press guard: a press on the dialog's submit within 400 ms of its opening is ignored (second half of a double click that opened it under the cursor).
- Double-submit: `pending` ref guard (two presses in one act send once) + `sending` disables Check / Clear / Import / the drop zone; FormDialog's own in-flight guard; `importId` is made once per FILE READ (not per request: the idempotent repeat after a lost answer needs the same id, and Task 6 returns `repeated`/`already_imported` by it). I read "importId per attempt" in the dispatch as "per file read".
- Failure shown once: on the page, or in the dialog when it is open. Mapped by code: `site_not_empty` (with entity words, unknown entity -> «записи»), `already_imported`, `org_gln`, `validation_failed` with a field path, everything else through `errorMessageKey` (tested: forbidden, internal, unknown error). Failure cleared when the next attempt starts.
- A dry run that answers `repeated` is the end of the import (done card, file dropped).
- After success: result card with counts, «станции получат … обычной синхронизацией», delete the file, translate the cloud SSCC counters; `resetQueries(["office"])`; the focus moves to the result region (see defect below).
- Access: nav item in section «Сервис» for admin only + `RequireRole` on the route (the role-change test drops the page and the file).

## Defects found by the strengthened tests (fixed)

1. Focus after the import went to nowhere: the Modal's cleanup gives focus back to the (now removed) page button AFTER a layout effect. Moved to a passive `useEffect` (runs after the dialog cleanup); the test waits for it explicitly; mutants "focus not moved" and "region not focusable" are killed.
2. An act warning in the rehearsal test: an `await rewritten(...)` between opening the page and choosing let the profile query's notification arrive outside act (only the delayed-setImmediate stand showed it deterministically). The test now builds the file before opening the page.

## RED / GREEN

- RED: first the page tests did not compile (module absent) - the brief's tests were adapted and written first against the missing modules; `import-notes.js` / `CloudImportPage.js` did not exist at that point (not captured to a file; the implementation was written in the same step as the first run).
- GREEN: `vitest run test/cloud-import-page.test.tsx --reporter=verbose`: 25 passed, stderr empty (/tmp/claude/imp-t8-run9.txt). Under the delayed-`setImmediate` stand (3 ms; scratch setup + config inside the package root, both deleted): 25 passed, stderr empty (/tmp/claude/imp-t8-stand4.txt).
- Full Vitest `exec vitest run --testTimeout=60000 --hookTimeout=60000`: 150 files, 4660 tests, all pass, stderr 0 bytes (Task 7: 149 / 4635; +1 file, +25 tests). Plan says 69 files / 1760 tests (a different baseline); brief's own page tests were 7, measured 25 (18 added).
- `typecheck` 0, `lint` 0 (full `eslint .`), `build` 0 (only the old chunk-size warning), `git diff --check` clean, `grep -F '\u04'` only `pairing-code.ts:66`; ru.json checked for duplicate keys with a `object_pairs_hook` (none; all `office.cloudImport.*` keys unique).
- Prettier gate proved live (scratch file failed with exit 1 and was deleted); changed paths pass.

## Mutants (script /tmp/claude/impl-imp-t8/mutants.py, results mutants-final.out; run on the COMMITTED code; every file restored: `cmp` against the pre-mutation copy equal, tree clean afterwards)

Final run: 68 listed, 66 mutated and ALL 66 KILLED, 2 anchors gone (two redundant guards deleted after the first run: `held.current === mine` in the catch, `done === null` on the trial card). Sha256 of the committed files: CloudImportPage.tsx `bb4c8433…`, import-notes.ts `10715eda…`, nav.ts `44b91c9f…`, routes.tsx `1c1d09e0…`. In the first run (before the last edits) six survived and led to changes: unmount without generation bump (test did not wait for a read), drop zone not busy while reading, failure not cleared on a new attempt, focus not moved / region not focusable (real defect 1), plus the two redundant guards. After the fixes the six were re-run and killed, then the whole list again.

| Mutant (one line)                                                                                                                                                                 | Killed by (first)                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| nav roles admin+technologist                                                                                                                                                      | is in the menu of an administrator only                                                                      |
| route without RequireRole                                                                                                                                                         | closes, and drops the file, when the user's role changes                                                     |
| file copied into view state                                                                                                                                                       | holds the file in a ref only, and nothing of it reaches ...                                                  |
| file put in the query cache / console                                                                                                                                             | same test (cache scan / console spies)                                                                       |
| file kept after the import                                                                                                                                                        | same test; takes a check that finds the import already made                                                  |
| unmount keeps the file / does not bump generation                                                                                                                                 | closes, and drops the file...; drops a file still being read when the page closes                            |
| forget does not bump generation / stale read not dropped / stale unreadable not dropped                                                                                           | drops a file that is still being read when a newer one is chosen                                             |
| pending guard removed / never released; sending never released                                                                                                                    | sends nothing twice...; shows the file...                                                                    |
| Check / Clear / Import / drop zone not disabled while sending; drop zone not busy while reading                                                                                   | sends nothing twice...; drops a file that is still being read...                                             |
| Import button ignores the check                                                                                                                                                   | shows the file, the counters and the notes...                                                                |
| dry run's repeated answer not final                                                                                                                                               | takes a check that finds the import already made as the end                                                  |
| importId per request / fixed for every file / dry-run flag false                                                                                                                  | shows the file...; sends the same import again...; drops the file at the end of a flow                       |
| cache not reset after the import                                                                                                                                                  | shows the file... (getOrg read twice)                                                                        |
| late answer applied after page closed                                                                                                                                             | keeps the office's cache as it was when the page closes before the import answers                            |
| failure shown twice / not in dialog / not cleared on new attempt                                                                                                                  | sends the same import again... (says the failure once); clears the last failure when the next attempt starts |
| site entity words open                                                                                                                                                            | names what a site holds in words...                                                                          |
| press guard removed / 0 ms / 800 ms / from epoch                                                                                                                                  | ignores a press on the confirmation in its first 400 ms... (800: all confirm tests)                          |
| rehearsal line missing / always / rehearsal alert missing                                                                                                                         | marks a rehearsal file...                                                                                    |
| confirmation counts mixed (products/operators, badges/products, lines created/present)                                                                                            | names the counts in the check and in the confirmation                                                        |
| check counts mixed (defaults only org, operators=products, lines swapped)                                                                                                         | same                                                                                                         |
| focus not moved; result region not focusable                                                                                                                                      | moves the focus to the result when the import is done                                                        |
| shape path dropped; extension refusal dropped; unreadable not caught; read without size check                                                                                     | says in words why a file cannot be read ...; refuses a damaged file...                                       |
| GLN compared the wrong way / null shown                                                                                                                                           | shows the file...; shows the file, and no GLN warning, when the profile cannot be read                       |
| checksum prefix 10; issued column shows printed; no-window text dropped; unknown owner; shift numbers placeholder; empty notes; notes count                                       | shows the file...; tells an owner nobody knows and a window that does not fit...                             |
| repeated answer worded as new                                                                                                                                                     | sends the same import again...; takes a check that finds...                                                  |
| unknown note code not shown as is; note words open; photo missing from field set; kind always box; record id prefix 4; product names not looked up; entity of a code not inferred | the notes of the export tool (both tests); shows the file...                                                 |

Restore proof per mutant: the script copies the file to /tmp/claude/impl-imp-t8/*.orig, checks `cmp` and the sha256 after the restore (all "restored" in mutants-final.out), and the working tree was `git status` clean at the end.

## Anchor adaptations (mechanical)

- `nav.ts`: no `users` -> end-of-array anchor; `backups` already is the last item and `office.nav.sections.service` already exists. The import item was appended after `backups` in section «Сервис».
- `routes.tsx`: the route anchor after `users` was no longer at the end; `import` was inserted after `backups`.
- `ru.json`: `sections.service` exists; the nav key `cloudImport` was added after `backups`, and the `cloudImport` block before `backups` (the brief's anchor `wrongCurrent` no longer ends `office`).
- CSS: `standalone-actions` (brief) does not exist; `standalone-form__actions` and `office-note` are used.
- No `access.ts` capability: administrator-only pages are gated by `OFFICE_NAV` + `RequireRole` (as users/devices); `shell.test.ts` needed no row.

## Concerns

1. The request object (with the hashes) still lives in the pending promise chain and in the API's IPC call until it settles; nothing can be done about that. The mock's `calls` in tests hold it by design.
2. If the page is left while the host is importing, the import still completes on the host, and nothing in the office says so (no toast, the cache is not reset; every page refetches on mount because `staleTime` is 0).
3. Dropping the file only on the end of the flow means a refused file stays in memory while the operator reads the refusal and until they leave the page or press «Убрать файл». Dropping on every refusal would break the brief's retry flows (GLN fix, lost answer).
4. A rehearsal file may be imported (with the extra warning) - the brief only asks for a mark; the host accepts it. Owner may want to forbid it.
5. The scan helper reads React internals (fiber hooks) in tests; a React upgrade may need its `__reactContainer$`/hook-shape assumptions revisited.
6. Not checked: real WebView2, a real 32 MiB file's reading time, a real keyboard/screen-reader pass; the dialog's initial focus is the first focusable (the close button) by `Modal`.
7. Pre-existing and out of scope, as in Task 6/7: the real wizard flow's GLN compare uses the profile read at page open (a profile fixed in another tab is not seen until the page reopens).
