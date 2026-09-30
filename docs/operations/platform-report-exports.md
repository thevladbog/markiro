# Platform report exports

Platform operators generate reports through SaaS admin; production SQL access is not part of this workflow. A request is stored before background processing and is repaired by the scheduled report worker after queue-delivery or process failures. Operators may repeat a failed or expired report; this creates a new request with a fresh idempotency key. Retrying delivery of one unchanged POST keeps its original key.

## Setup and operation

Apply the tracked PostgreSQL migrations before enabling the worker. The API, jobs worker, private object storage and platform authentication must be configured together. Report intents and selected tenants live in PostgreSQL; ZIP artifacts use the private `platform-reports/<report-id>/attempt-<n>/report.zip` namespace. Do not make that bucket public.

History states are `queued`, `processing`, `ready`, `failed` and `expired`. A ready report with zero rows is successful. Pending rows are reconciled by the scheduled worker, fenced leases prevent stale attempts from publishing, and generation stops rather than truncating when row or byte limits are exceeded. Artifacts expire after seven days; cleanup retries confirmed deletion. Download links are issued only for ready, unexpired reports and live for at most 300 seconds.

The minute-scheduled `platform-report-repair` queue dispatches separate `platform-report-run` jobs with the report ID as their singleton key. Generation cannot block the repair worker while it processes the rest of a batch. Expiry cleanup revisits already-expired rows to remove late stale uploads across all three deterministic attempt keys; a failed deletion preserves the previous status and artifact pointer for retry.

SaaS downloads navigate the current tab after the download-link POST completes; they do not require popup permission. Run the isolated regression with `pnpm --dir tools/production-browser --ignore-workspace test:reports`. It uses synthetic API responses and no production database.

Monitor failed rows by their safe error code and the corresponding audit event. Do not log signed download URLs, report payloads or credentials. Creation, terminal failure and download are audited against the current platform principal and explicit tenant selection.

## Artifact interpretation

Each ZIP contains `data.csv` and `metadata.json` with the exact parameters, snapshot time, `definitionsVersion`, the SHA-256 of `data.csv` (`dataSha256`) and metric definitions. Dates are inclusive local calendar dates in the selected IANA timezone; event timestamps in the artifact remain UTC. Current names are snapshot identity labels, not asserted historical names.

Confirmed box labels require `print_verified_at`; reprint requests are separate operational facts. Inventory expected values and code classifications are current projections, while scan and repack facts are interval events. Missing facts are unavailable (`null`), not inferred zero. Badge/PIN values, raw scan codes, authentication material and integration credentials are never exported.

CommerceML reports use an allowlisted journal projection. They can state whether a current temporary upload exists, but the platform does not retain a complete historical raw CommerceML archive. An unavailable historical file must remain unavailable and must not be reconstructed or described as retained.

## Usage, quality and commercial reports

The `usage`, `quality` and `commercial` templates give one row per tenant and local calendar day for platform-usage analytics and supporting evidence. They take the same explicit tenant selection (1–10), inclusive dates (at most 366 days) and IANA timezone as the other templates, and reject every optional filter and the production-date basis.

A row exists only for a tenant-day with at least one recorded fact. A missing row means no recorded fact, not a measured zero. Every numeric column is an additive count or sum, so days can be rolled up to weeks or months; lag is reported as bucket counts, and amounts are RUB kopecks. Server clocks are used wherever they exist and each definition in `metadata.json` names its clock. Late device synchronisation can restate past days, so compare exports by `snapshotAt` and `definitionsVersion`, which is bumped whenever a formula changes.

Privacy modes apply to tenants instead of operators. `identified` shows tenant ids and names and needs the identified capability. `pseudonymous` replaces both with `tenant-01`, `tenant-02`, … in ascending tenant-id order and records only `tenantCount` in the artifact parameters. `aggregate` removes the tenant columns and sums days across the selected tenants. Neither is legal anonymization: a distinctive volume or a small selection can still identify a tenant. Do not name a customer in published material without its consent.

Artifacts keep the seven-day retention. Place downloaded files in an evidence package with `tools/evidence-package` (seal, verify) for long-term retention. Facts the platform does not retain, such as the CommerceML item journal older than 14 days, cannot be regenerated: export the `commerceml` report regularly and keep it in the evidence package.
