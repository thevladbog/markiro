# Synthetic US demo viewer

This is a read-only cabinet identity for the owned US development dataset, not a
publicly hosted demo or a production/customer account. The data is fictional. No
viewer password, enrollment key, backup code or session is distributed by this
document or stored in an evidence artifact.

## Identity and provisioning

The compiled `apps/api/dist/main.us-viewer.js provision` command accepts the
original dataset tenant and owner IDs plus `--confirm-local-synthetic-viewer`.
Its generated password is supplied through bounded private stdin, never command
arguments, environment variables or files. The command verifies the original
synthetic owner, seed/profile provenance and reserved viewer identity before
creating `viewer@us-development.example.test` with only `traceability_auditor`.
A repeat validates that same identity without resetting credentials or MFA.
Provisioning does not convert the owner or grant mutation permissions.

The viewer signs in through the normal password, authenticator enrollment/TOTP
and organization-selection UI. The shell displays “Synthetic demo data — not
real customer activity.” and “Read-only access” (also localized in Spanish).
These labels are presentation, not authorization: the API remains authoritative.

The viewer can inspect reference data, current and excluded event history, lot
balances, Cases, Trace, Readiness, the published Plan and existing frozen Request
runs. Approved existing Plan/package downloads remain audited reads. Mutation,
generation, preparation and retry permissions are not added.

## Acceptance ownership

The additive `demo_viewer_acceptance` job in `.github/workflows/us-development.yml`
owns the new command/store, compiled refusal, compact HTTP, synthetic marker,
browser-fixture unit and full-volume browser suites. The three existing modified
admin suites retain their original browser-matrix owner. New Node tooling tests
are covered by the existing tooling glob; older job blocks, selectors and
predecessor hashes are unchanged.
The new job builds `@markiro/ui` unconditionally before its admin/browser consumers;
API dependency builds alone do not produce that package's exported browser assets.

Actual full-volume acquisition is CI-only: a clean GitHub-hosted Linux checkout,
the exact viewer job, the fixed isolated PostgreSQL identity and checked compiled
source identity are required. The viewer and original positive dataset jobs have
separate guards and share one private acquisition implementation, with fixed
module-relative paths. No environment/job/identity override enables local use.

The browser fixture initializes the full six-month dataset exactly once, then
provisions the viewer through the compiled stdin command. It starts the actual
US app and Vite only after checking their fixed ports are unused. The existing
pinned private object-store image, SDK, capability probes, scoped credentials,
ownership and normal disposal checks remain in force.

The one UI-authenticated browser context inspects Scenario A, partial stock,
correction and orphan history, pagination, Trace and Readiness. It downloads the
published Plan and three package ZIPs in the browser, plus all six artifact kinds
for each of the same three full-volume runs through that context's HTTP facility.
All 22 releases must match native frozen hashes, lengths, MIME/names and exact
correlated viewer audit rows; ZIP entries are checked individually. Whole business
tables and private bytes remain invariant, normal auth deltas are explicitly
checked, and viewing must produce zero provider mutations/failures/active work.
Independent before/after private verification GETs are accounted separately.

Budgets are one initialization at 900,000 ms, setup/disposal at 60,000 ms each,
the complete journey at 300,000 ms, individual browser assertions/reads/download
drains at 5,000 ms, and the job at 45 minutes. There are no retry/repeat policies
or automatic timeout increases.

Setup uses one monotonic budget, paused only for the single bounded native
initialization. API and Vite serving have exact invocation-owned child handles;
Chromium has a loopback-only, ephemeral-port BrowserServer owner. Readiness IPC
contains no viewer credentials. Cleanup starts independent closers together and
waits for serving/browser termination before the installation's unchanged normal
cleanup. Escalation of an exact owned process is reserved within the same disposal
budget and permanently fails acceptance. Late handles and rejected promises remain
observed. A pending inherited installation operation cannot be forcibly canceled
through its frozen interface: deadline expiry is explicitly incomplete failure,
with retained late normal cleanup, never proof of absence or successful disposal.

Only post-authentication synthetic screenshots are permitted, after factor and
password UI is absent, for English/Spanish, light/dark and desktop/narrow layouts.
Authentication failures discard original errors, causes, call logs and DOM.
There are no authentication screenshots, traces, video, cookie/storage-state files
or protocol/debug capture. Owned resources are disposed even after failures;
provider containers and the isolated database require absence verification.

The Vite Plan proxy supports only exact GET collection, canonical UUID item and
PDF paths. Queries, Range, other methods and mutation/preview aliases are denied
for development and preview. This does not modify API authorization.

## Evidence boundary

Pure contracts, source review and builds are not actual browser/provider proof.
Full acceptance requires the reviewed exact source SHA and completed logs from
all original US/Cases owners and the new viewer owner. No local full-volume run,
public hosting, DNS/TLS, deployment, external customer validation or regulatory
acceptance is implied. Hosting is a separate decision described in
[demo-hosting-options.md](demo-hosting-options.md).
