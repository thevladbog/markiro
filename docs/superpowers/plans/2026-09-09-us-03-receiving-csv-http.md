# US-03 Receiving CSV HTTP checkpoint

Status: implemented locally on `codex/us-mvp`; no publication or release enabled.

## Approved boundary

This checkpoint implements the HTTP boundary approved after the
[atomic apply service](2026-09-09-us-03-receiving-csv-apply-service.md).
The [approved CSV design](../specs/2026-09-08-us-03-receiving-csv-import-design.md)
remains the product contract. No new delivery, finalization, QA or lot-assignment
semantics are introduced.

Only the isolated `UsDevelopmentModule` registers the CSV controller and runtime
store. Every route uses the real US session/MFA guard and reloads current
Receiving-write membership and profile in its transaction. Saved GET and successful
replay require WRITE, not the less restrictive live-record READ capability.
Tenant, actor and request ID are server-owned. Responses are `no-store`.

| Method | Path                                        | Success             | Body limit                        |
| ------ | ------------------------------------------- | ------------------- | --------------------------------- |
| POST   | `/traceability/receiving/imports/preview`   | 201 saved findings  | 512 KiB JSON; 256 KiB decoded CSV |
| GET    | `/traceability/receiving/imports/:id`       | 200 saved findings  | Existing 16 KiB parser            |
| POST   | `/traceability/receiving/imports/:id/apply` | 200 acknowledgement | 16 KiB JSON                       |

The larger preview limit matches only that exact POST route, including Express's
case-insensitive and optional-trailing-slash forms. Other methods, nested paths,
existing Receiving writes and other business routes retain their limits.
Host, mutation Origin and uncompressed `application/json` remain mandatory.

## Public responses

`receivingCsvPreviewSchema` explicitly projects metadata, normalized header,
original row cells, field issues, normalizations, saved reference findings and
the normalized proposal/digest. Original header and file bytes remain private
persisted evidence. File errors return no partial rows or proposal. Reopening
an expired preview is allowed and never re-resolves today's catalog. The existing
saved reader verifies bytes/hash/proposal integrity before projection.

`receivingCsvApplyResponseSchema` separates:

- `request`: the captured requested import ID, operation key and expected digest;
- `receipt`: the immutable original CSV outcome, including its original key,
  import ID and event record.

The response binds both digests. An applied preview with another requested key
returns the original receipt; an equal-content alias preview may also return a
different original import ID. There is no misleading `created`/`replayed` flag
derived from key equality. All apply successes use HTTP 200.

`matchesReceivingCsvApplyResponse` checks a response against captured request
context. A future browser client must then GET the receipt's event ID for current
state. Acknowledgement replay is not proof that the event is still a draft.
No automatic creation retry, browser storage, proxy extension or UI is added here.
Existing Receiving receipt unions and stored historical receipt bytes stay unchanged.

## Verification

TDD first established missing shared schemas and 404/old-limit failures for the
unregistered HTTP routes. Real loopback HTTP tests use synthetic password/TOTP
credentials and a newly created, migrated, disposable US database, never the
base database or RU environment.

Covered: request/receipt correlation, same-key retry, different-key reuse, alias
preview, live GET after edit, exact audit metadata and single creation, invalid
CSV evidence, strict body/path context, cross-tenant denial, current role changes,
MFA/session denial, absent profile, stale/expired/digest-conflicted application,
successful historical replay after expiry, route-local body limits, Host/Origin,
compression rejection, saved corruption, sanitized database failure and OpenAPI.

Local verification results:

- Full shared-contract package: 792 tests passed, no skips.
- CSV/HTTP/Receiving command regression: 233 tests across 11 files passed,
  no skips. The 32-test Receiving HTTP suite also passed again after the final
  explicit response projection.
- Deployment-entry, isolated composition and environment tests: 52 passed,
  no skips. The loopback composition test required sandbox escalation.
- Isolation/browser-entry contracts: 19 passed, including closed CSV proxy paths;
  the release-isolation checker passed.
- API and shared-contract typecheck, lint and build passed; DB compiled exports
  rebuilt before consumers. Repository formatting and `git diff --check` passed.
- Read-only cleanup inspection found zero disposable US fixture databases and
  no CSV tables in the unmigrated base US database.

The full API package was not rerun: its ordinary RU environment-dependent suites
are outside this isolated fixture run and have a previously recorded missing-env
limitation. Browser interaction, hosted infrastructure and external release
settings were not exercised. No full-API or hosted-readiness claim is made.

## Remaining work

Next: the English/Spanish browser import flow, explicit confirmation, request-bound
acknowledgement handling, live GET recovery and an exact browser proxy allowlist.
Safe CSV output remains a separate open part of INT-002. INT-002 stays in progress.
No commit, push, PR, deployment, new dependency or migration is part of this checkpoint.
