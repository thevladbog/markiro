# US-03 Receiving CSV browser checkpoint

The owner approved the grouped three-step flow in chat: file/common header,
read-only preview, explicit draft confirmation. This implements the connected UI
stage of the [approved import specification](../specs/2026-09-08-us-03-receiving-csv-import-design.md)
after the [HTTP checkpoint](2026-09-09-us-03-receiving-csv-http.md).
Work remains local to `codex/us-mvp`, without release permission.

## Implemented boundary

- Receiving writers can open Import CSV from the registry. The existing header,
  reference and document controls are reused; no name matching or inferred data.
- Downloadable v1 blank template, UTF-8/100-row/256-KiB guidance and early byte cap.
  English column keys are unchanged; all application explanations use EN/ES.
- Read-only saved preview shows file/row/header findings, original physical line
  numbers, literal cells, normalizations and proposed common header. Any blocking
  finding disables continuation. Correct the source file and preview again.
- Malformed over-wide rows display only their first 18 cells with an explicit
  total-cell warning. This bounds DOM work only: original bytes, saved evidence,
  complete row validation and the blocking error remain unchanged.
- The client captures original header/file input before awaiting transport. It
  verifies strict response shape, file identity/bytes hash, row cells, normalized
  header and proposal digest before allowing confirmation.
- Confirmation uses the shared checkbox and one request-bound operation key.
  Unknown results offer only an explicit retry of the same captured command.
  A definitive rejection stops recovery and cannot silently allocate a new key.
- Acknowledgement is not the editor's state: a separate validated GET opens the
  current record. Once acknowledged, recovery retries GET only, never apply.
- Session/permission loss clears file, preview and command state. Unmount/late
  responses cannot reopen the editor; dirty navigation uses existing warnings.
  No import data or operation key enters local/session storage.
- Vite forwards only the three exact CSV endpoint shapes. New tests join the
  read-only US workflow; inherited operational workflow locks remain unchanged.

## Verification

Focused failing tests preceded implementation. Additional red/green cases proved
uncertain-to-definitive recovery, retained-file visibility, bounded malformed-row
rendering, singular row labels and unconditional CI test selection.

- Full admin suite passed 1,440 tests across 121 files before the final two
  client/lifecycle tests and copy cleanup. The final focused CSV/registry set
  passed 41 tests across three files, including late-read and raw-header capture.
- Admin typecheck/lint and both primary and isolated-US builds passed. Existing
  five RU hook warnings, jsdom canvas/navigation limitations and large-chunk
  notices are unrelated and are not hidden.
- Final Chromium run passed both the existing full US journey and the new CSV
  journey (2/2, no skips; 71.85 seconds including setup/cleanup). CSV smoke uses real MFA, session, API and an owned
  disposable US database. It validates blank-template bytes; malformed-file
  blocking; literal leading zeros and decimal strings; visible normalization;
  keyboard confirmation; committed-but-lost apply response; same-key retry;
  acknowledged-but-lost GET; and one creation/application with exact actor,
  tenant, target, outcome and audit metadata.
- The browser flow captures six states at 1440/1024/390 px in EN/ES and both
  themes, asserts no horizontal page overflow, checks the existing logo geometry
  and locally loaded brand font, and rejects external browser requests.
  Final screenshots are under
  `/var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/markiro-us-csv-browser-uu7RKD`.
  Desktop preview and narrow Spanish dark confirmation originals were personally
  inspected; an earlier run also covered the narrow Spanish dark input screen.
- All 20 US tool contracts passed, including 19 isolation/browser-entry cases.
  The release-isolation checker, repository formatting and `git diff --check`
  passed. Final admin typecheck/lint, both builds and the 41 focused tests passed.
- Read-only cleanup checks found zero disposable US fixture databases, no CSV
  tables in the base US database and no listeners on ports 3100/5174.

Reproduce the browser check after building API/workspace dependencies and
installing the separate production-browser tool workspace:

```sh
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev node --test tools/us-development/test/receiving-csv-flow.smoke.mjs
```

It owns ports 3100/5174 and a randomly named migrated database. Never substitute
the primary database URL or migrate the base US database. Locally, the existing
main-checkout Playwright runtime was consumed read-only through `NODE_PATH`.
Screenshots contain synthetic data only; no MFA material is captured.

## Review and remaining work

Inline review reconciled request/receipt identity, stale async completion,
permission loss, raw/normalized values, read recovery, bounded rendering,
locale parity and the proxy allowlist against the approved specification.
Shared components and existing industrial styling preserve the current identity;
no design-system, logo, font or `.pen` edits are included.

INT-002 and US-03 remain in progress. CSV output needs its separately approved
artifact/spreadsheet policy. This checkpoint does not establish hosted, native
device, screen-reader, external-service or fluent-Spanish acceptance. Unchanged
server/domain/DB package suites were not repeated for this frontend increment;
real browser persistence was exercised through the existing disposable fixture.
No new dependency, migration, primary-checkout edit, commit, push or deployment.
