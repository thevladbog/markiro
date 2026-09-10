# Platform report exports

Platform operators generate reports through SaaS admin; production SQL access is not part of this workflow. A request is stored before background processing and is repaired by the scheduled report worker after queue-delivery or process failures. Operators may repeat a failed or expired report; this creates a new request with a fresh idempotency key. Retrying delivery of one unchanged POST keeps its original key.

## Setup and operation

Apply the tracked PostgreSQL migrations before enabling the worker. The API, jobs worker, private object storage and platform authentication must be configured together. Report intents and selected tenants live in PostgreSQL; ZIP artifacts use the private `platform-reports/<report-id>/attempt-<n>/report.zip` namespace. Do not make that bucket public.

History states are `queued`, `processing`, `ready`, `failed` and `expired`. A ready report with zero rows is successful. Pending rows are reconciled by the scheduled worker, fenced leases prevent stale attempts from publishing, and generation stops rather than truncating when row or byte limits are exceeded. Artifacts expire after seven days; cleanup retries confirmed deletion. Download links are issued only for ready, unexpired reports and live for at most 300 seconds.

Monitor failed rows by their safe error code and the corresponding audit event. Do not log signed download URLs, report payloads or credentials. Creation, terminal failure and download are audited against the current platform principal and explicit tenant selection.

## Artifact interpretation

Each ZIP contains CSV data and a definitions JSON file with the exact parameters, snapshot time and metric definitions. Dates are inclusive local calendar dates in the selected IANA timezone; event timestamps in the artifact remain UTC. Current names are snapshot identity labels, not asserted historical names.

Confirmed box labels require `print_verified_at`; reprint requests are separate operational facts. Inventory expected values and code classifications are current projections, while scan and repack facts are interval events. Missing facts are unavailable (`null`), not inferred zero. Badge/PIN values, raw scan codes, authentication material and integration credentials are never exported.

CommerceML reports use an allowlisted journal projection. They can state whether a current temporary upload exists, but the platform does not retain a complete historical raw CommerceML archive. An unavailable historical file must remain unavailable and must not be reconstructed or described as retained.
