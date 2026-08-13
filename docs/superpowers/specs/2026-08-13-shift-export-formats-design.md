# Shift export formats and retained reports

**Status:** approved for planning on 2026-08-13.

## 1. Goal

Allow an administrator or manager to open a closed shift, choose one of four
built-in report formats, optionally split the result by a maximum physical-line
count, and receive one or more immutable files through the shift's retained
export history.

This MVP deliberately has no format editor, uploaded templates, tenant-specific
templates, or counterparty assignments. The same versioned built-in formats are
available to every tenant and counterparty. A later custom-template feature can
extend the registry without changing the job, history, or artifact model.

## 2. Built-in format registry

Formats are JSON-compatible descriptors registered in code. A descriptor
contains at least:

```json
{
  "id": "shift_txt_flat",
  "version": 1,
  "label": "[TXT][Без коробов] Отчет смены",
  "extension": "txt",
  "mimeType": "text/plain; charset=utf-8",
  "boxMode": "flat"
}
```

The descriptor is metadata, not an executable user template. A deterministic
renderer is mapped to `(id, version)` in code. The API returns the available
descriptors to the cabinet; the client never invents a format ID or label.

The MVP registry contains exactly four entries:

| ID                | Cabinet label                    | Content                                                                                      |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `shift_txt_flat`  | `[TXT][Без коробов] Отчет смены` | One canonical KM per line                                                                    |
| `shift_txt_boxes` | `[TXT][С коробами] Отчет смены`  | SSCC line, its KM lines, then an empty separator line for every box, including the final box |
| `shift_csv_flat`  | `[CSV][Без коробов] Отчет смены` | Header `code`, then one canonical KM per record                                              |
| `shift_csv_boxes` | `[CSV][С коробами] Отчет смены`  | Header `box_sscc;code`, then one `SSCC;KM` record per item                                   |

CSV uses UTF-8 with a BOM, semicolon delimiters, CRLF record separators, and
standard CSV quoting: a field containing a semicolon, quote, CR, or LF is
double-quoted and embedded quotes are doubled. The BOM is not a physical line.
TXT uses UTF-8 without a BOM and LF separators. The literal GS byte (`0x1D`)
inside a canonical KM is preserved in both formats.

## 3. Authoritative shift contents

An export can be requested only for a shift whose status is `closed`.

The flat formats contain every authoritative code currently owned by the shift.
The canonical KM comes from the authoritative scan identified by
`code_registry`, not from an arbitrary duplicate scan row.

The boxed formats contain only active memberships of active closed boxes:

- the box has a non-null SSCC and `closed_at`;
- the box is not disassembled;
- the item is neither displaced nor operator-removed;
- the code is still authoritatively owned by this shift and membership.

Before rendering a boxed format, the worker compares the authoritative shift
codes with the codes represented by eligible boxes. Any unboxed authoritative
code, open box, missing SSCC, displaced ownership mismatch, or other incomplete
coverage fails the export. It must not produce a plausible but incomplete file.

Ordering is deterministic. Flat codes are ordered by authoritative scan time,
then code hash. Boxes are ordered by SSCC; their items are ordered by
authoritative scan time, then code hash.

Counts in metadata and filenames come from the records that actually enter the
artifact, never from a cached shift counter.

## 4. Request and optional line splitting

The closed-shift card has a `Сформировать отчет` action. Its dialog shows the
four descriptors and an optional `Разбить на файлы` control. When splitting is
enabled, `Максимум строк в файле` is a required positive integer and defaults to
`2000`. The API accepts an integer from 2 through 1,000,000 and does not trust
the client-side default. A boxed block that cannot fit under the chosen value is
reported by the worker as described below.

The limit counts physical logical lines in the encoded artifact, regardless of
their meaning:

- every KM line counts;
- an SSCC line counts;
- every empty TXT box separator counts;
- every CSV header counts and is repeated in each part;
- the UTF-8 BOM does not count.

For flat formats, rows fill each part up to the limit. For boxed formats, a box
is an indivisible block. If the next complete block would exceed the limit, the
whole block starts the next part. No part may exceed the configured limit. If a
single box block cannot fit in an otherwise empty part (allowing for the CSV
header where applicable), the export fails with a data/parameter error. The
expected business case has much smaller boxes, but the guard remains mandatory.

When splitting is disabled, the export produces one artifact without a line
limit. Splitting that happens to produce only one part still uses the ordinary
unsuffixed filename.

## 5. Artifact filenames

Each artifact filename describes that part, not the whole shift:

```text
<product>_<code-count>[_<box-count>]_<shift-date>[_часть_<N>].<extension>
```

Examples:

```text
Вода_газированная_1980_165_2026-08-13_часть_1.csv
Вода_газированная_520_44_2026-08-13_часть_2.csv
Вода_газированная_2500_2026-08-13.txt
```

The product name and shift date are snapshotted when the export starts. The date
is the shift's planned date in `YYYY-MM-DD`, not the report-generation date.
Whitespace, path separators, shell/filesystem-reserved punctuation, control
characters, and other escapable characters are replaced with `_`. Consecutive
underscores collapse and leading/trailing underscores are removed. Cyrillic is
preserved. A safe non-empty fallback is used if sanitization removes the entire
product name. The server owns the filename; the browser uses the server-provided
download name.

The box count segment is present only for boxed formats. `_часть_N` is present
only when the result has more than one part, and numbering starts at 1.

## 6. Job, history, and artifacts

Report generation is always asynchronous. The request creates one tenant-scoped
shift export row with status `queued`, then enqueues a pg-boss job. The worker
transitions it through `processing` to `ready` or `failed`.

The export row stores:

- tenant, shift, `(format_id, format_version)`, and optional maximum lines;
- status and bounded safe error code;
- snapshotted product name and shift date;
- total exported code/box counts;
- creating actor and idempotency key;
- source snapshot start, completion time, and retry metadata.

A child artifact row stores, for every part:

- part number and physical line count;
- that part's code and box counts;
- immutable filename, MIME type, byte size, checksum, and private object key.

The worker reads the source in one consistent database snapshot. It renders and
uploads every part to temporary private object keys first. Only after every part
has uploaded and its checksum has been verified does one database transaction
publish all artifact metadata and mark the export `ready`. A failure publishes
no downloadable subset; temporary objects are cleaned up by the failed job or a
bounded sweeper.

A ready export and its objects are immutable. Intentionally running the same
format again creates a new export. A request idempotency key only collapses a
network retry of the same user action; it does not prevent a later deliberate
rerun.

## 7. Shift history and late offline data

The shift card shows `Сформированные отчеты`. One history row represents one
generation request and shows descriptor label, actor, creation time, parameters,
aggregate counts, and status. A ready row expands to its artifact parts; each
part shows line/code/box counts, byte size, and its own download action. A failed
row shows a safe reason and a `Повторить` action.

Download authorization is rechecked and returns a short-lived URL for a private
object. Tenant boundaries are enforced by the server for list, create, retry,
and download operations.

Closed shifts can still receive legitimate late offline synchronization. The
worker stores the instant at which its source snapshot started. If the shift's
`late_data_at` becomes later than that instant, the export is marked in the UI
as `Данные смены изменились — сформируйте новую`. The old artifact remains
downloadable and auditable; it is never silently regenerated or overwritten.

Exporting accumulated data remains available in subscription read-only mode.
Cabinet authorization requires the established operations-read/export access;
station and kiosk device credentials cannot reach these routes.

## 8. Errors and recovery

Safe user-visible data/parameter failures include:

- shift is not closed;
- shift has no authoritative codes;
- boxed coverage is incomplete;
- a required box is open, disassembled, or lacks an SSCC;
- one indivisible box block exceeds the configured physical-line limit;
- unknown or retired `(format_id, format_version)`;
- invalid line-limit value.

Storage, database, and queue failures are infrastructure failures and remain
retryable. They are not rewritten as business-data errors. Audit records include
tenant, actor, shift, export, format/version, parameters, outcome, and bounded
metadata, but never raw KMs, signed download URLs, or object-storage credentials.

## 9. API surface

The cabinet contract exposes these operations:

- `GET /shift-exports/formats` lists current built-in descriptors;
- `POST /shifts/:shiftId/exports` creates an export with format/version,
  optional maximum lines, and an idempotency key;
- `GET /shifts/:shiftId/exports` lists that shift's history and artifact
  metadata;
- `POST /shift-exports/:exportId/retry` retries one failed export;
- `GET /shift-exports/:exportId/artifacts/:artifactId/download` obtains a
  short-lived download for one ready artifact part.

OpenAPI and the admin client are updated together. Status polling may use the
existing query layer; this MVP does not require WebSocket or SSE job updates.

## 10. Verification

Focused deterministic renderer and splitter tests cover:

- exact bytes for all four formats;
- literal GS preservation;
- BOM only for CSV, repeated CSV headers, semicolon quoting, and line endings;
- exact physical-line counts at, below, and across a limit;
- indivisible boxes and the next-box-to-next-part rule;
- failure when one box block exceeds the limit;
- deterministic ordering;
- per-part code/box counts and filenames;
- filename sanitization for whitespace, slashes, quotes, controls, repeated
  unsafe characters, Cyrillic, and an empty-safe fallback.

Database/API/job tests cover:

- tenant isolation and cabinet/device authorization;
- closed-shift-only creation and empty/incomplete-data failures;
- exclusion of removed, displaced, and disassembled contents;
- selecting the authoritative canonical KM in duplicate/conflict histories;
- idempotent request retry versus a deliberate rerun;
- atomic publication of multiple artifacts and cleanup after partial storage
  failure;
- retryable infrastructure failures;
- private short-lived downloads;
- late offline data marking an old export stale without mutating it.

Admin component tests cover the four format choices, split control and default,
validation, queued/processing/ready/failed states, stale warning, retry, and
per-part downloads. A browser acceptance pass downloads representative TXT and
CSV artifacts and verifies filenames and visible history. Automated byte-level
tests, not a text editor screenshot, are authoritative for BOM and GS behavior.

## 11. Explicitly out of scope

- uploaded or edited templates;
- per-tenant or per-counterparty format assignment;
- arbitrary JSON transformation DSL;
- direct GIS MT/Chestny ZNAK submission;
- scheduled/recurring exports;
- automatic email or external delivery;
- ZIP download of every part;
- deletion or rewriting of ready export history.

## 12. Acceptance criteria

1. From a closed shift, an authorized cabinet user can choose any of the four
   named built-in formats and optionally set a maximum physical-line count.
2. Generation runs through pg-boss and appears in retained shift history; it is
   never tied to one long-running download request.
3. Flat reports contain every authoritative shift KM exactly once. Boxed reports
   contain every authoritative shift KM exactly once under an eligible complete
   box, or fail without publishing a file.
4. Every split part obeys the physical-line limit; a box is never divided.
5. CSV headers/BOM/quoting and TXT box separators follow this specification, and
   literal GS bytes survive unchanged.
6. Every artifact has a sanitized server-owned filename with per-part counts,
   shift date, and `_часть_N` only for a multi-part result.
7. No part is downloadable until all parts have been stored and published
   successfully.
8. Ready files are immutable, tenant-scoped, privately stored, and retained in
   history; a rerun creates a new report.
9. Late offline data visibly makes an older report stale without deleting or
   changing it.
