# Public inventory integration API

`/public/v1` is the versioned integration surface. Send `x-api-key` with a key created in the cabinet's Public API integration settings. Copy its secret at creation; it cannot be recovered later. Cabinet cookies, Station/Handheld keys, kiosk credentials and signer credentials do not authenticate these routes. Do not put keys in URLs, source control or logs.

Paths below are relative to the API server. The production edge exposes this
surface under `/api/public/v1` on the admin host, using its existing `/api/*`
proxy. For example, product listing is `GET https://<admin-host>/api/public/v1/products`.
Use `/public/v1/products` when connecting directly to a local API server.

Every request requires a current enabled public key, the route's explicit scope, and the tenant's current `publicApi` entitlement. Inventory routes additionally require `inventory`; unknown entitlement facts deny access. The existing native device API keeps its own authorization and recovery rules. Removing public API access does not delete prepared tasks, source files, snapshots, receipts or results, and does not make native recovery depend on public API scopes.

| Scope                   | Routes relative to `/public/v1`                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `catalog.products.read` | `GET /products`, `GET /products/:id`                                                                        |
| `inventory.read`        | `GET /inventories`, `GET /inventories/:id`, `GET /inventories/:id/progress`, `GET /inventories/:id/results` |
| `inventory.prepare`     | `POST /inventories`, `POST /inventories/:id/imports/:status`, `POST /inventories/:id/snapshots`             |
| `inventory.start`       | `POST /inventories/:id/start`                                                                               |

Assign only required scopes. Legacy keys with no scopes have no public route access. Changing scopes takes effect on new requests and retries; an earlier completed receipt does not bypass current authorization. Product listing excludes archived products and supports optional `search` and `status=draft|active`. Draft product `boxCapacity` can be null. Public inventory projections contain business IDs, dates and state; they exclude native manifests, device/operator credentials, internal storage keys and cabinet-only actions.

## Prepare a task

Obtain the intended production line ID and any label-template configuration from the cabinet. Product IDs come from the product endpoints. Preparation uses existing inventory product, date, mode and template validation.

1. Send `POST /inventories` with `Idempotency-Key` and JSON:

   ```json
   {
     "productId": "10000000-0000-4000-8000-000000000001",
     "lineId": "10000000-0000-4000-8000-000000000002",
     "mode": "check",
     "productionDateFrom": "2026-08-01",
     "productionDateTo": "2026-08-31"
   }
   ```

2. For the returned inventory ID, upload one supported CHZ export per status: `EMITTED`, `INTRODUCED`, `APPLIED`, `RETIRED`, `WRITTEN_OFF`, `DISAGGREGATION`. Send multipart/form-data with exactly one binary part named `file` to `/inventories/:id/imports/:status`, and a distinct Idempotency-Key per upload. Extra fields and extra files are rejected. The existing CHZ reader validates file format, container, 64 MiB upload limit, digest, status, GTIN and rows. It supports the same CSV/XLSX/ZIP input handling as cabinet inventory imports; consult the route's errors and cabinet import documentation for source diagnostics. Do not convert or substitute invented code lists for the original source export. An empty status requires its valid CHZ empty-export representation.

3. Select the successful import IDs explicitly and send `POST /inventories/:id/snapshots`:

   ```json
   {
     "imports": {
       "EMITTED": "10000000-0000-4000-8000-000000000003",
       "INTRODUCED": "10000000-0000-4000-8000-000000000004",
       "APPLIED": "10000000-0000-4000-8000-000000000005",
       "RETIRED": "10000000-0000-4000-8000-000000000006",
       "WRITTEN_OFF": "10000000-0000-4000-8000-000000000007",
       "DISAGGREGATION": "10000000-0000-4000-8000-000000000008"
     }
   }
   ```

4. Send `POST /inventories/:id/start` with `{}` and a new Idempotency-Key. The response contains `inventoryId`, `snapshotId` and `status: "running"`. It deliberately excludes the persisted native manifest. Native devices execute the factory workflow using their existing API.
5. Read the inventory and `/progress` for counts. `/results` returns a public projection of live scan evidence. It does not execute scans or generate regulatory submissions. This surface has no cancellation, closure, correction or regulatory submission mutation.

## Retries and results

Every POST requires `Idempotency-Key` (1–200 printable characters). Retain the same key for an identical retry, including after a lost response. Reusing it for another payload returns 409. Import replay includes inventory/status, filename, MIME type and bytes digest, so preserve those values. Receipts are scoped to tenant, public key and operation. A newly issued key does not own the previous key's receipt. Digest deduplication may return an existing cabinet or public import; its original actor and evidence remain authoritative.

`GET /inventories/:id/results?limit=50` returns `items` and `nextCursor`. Limit is 1–100. Optional `classification` is `expected`, `protected`, `ineligible`, `unknown` or `voided`. When `nextCursor` is non-null, URL-encode it and send it as `cursor`, preserving classification and limit. Cursors are opaque, shape-validated and bound to tenant/inventory/filter/limit; malformed or differently bound cursors return 400. Pages follow the existing evidence owner's ordering and are live, not a frozen export: changing scans/corrections between pages can change page membership. Restart traversal when a consistent current view is needed; frozen archival exports remain a cabinet workflow.

Errors preserve existing API/domain envelopes. Typical statuses are 400 for invalid input/cursor, 401 for invalid credential, 403 for missing scope or entitlement, 404 for absent/cross-tenant resources, 409 for replay or lifecycle conflicts, 413 for an oversized source, 422 for source/domain validation, 429 for rate or usage limits and 503 for recognized infrastructure uncertainty. Failed import parsing returns the public import diagnostics as the 422 body. Unexpected infrastructure failures may return 500; retain the original idempotency key and retry after recovery. Never interpret a timeout or lost response as proof the effect did not commit. If access is removed, use the cabinet's retained history and existing recovery workflow instead of attempting to bypass authorization.

A 429 response can occur before any public controller runs. Pause requests and respect the key's configured rate window or usage refill before retrying; use bounded backoff rather than immediate retry loops. An exhausted usage allowance without a refill requires the cabinet administrator to review the key's allowance. Keep the same Idempotency-Key and payload for mutation retries. The current limiter does not send a Retry-After header, so do not assume an exact retry delay is supplied.

## Deployment and provenance

The combined operation registry is `p1c.native.v1`; public operations use separate `public.*.v1` IDs with `api_key_scope` authorization. They do not widen the existing cabinet operation IDs. Strict offline grant enforcement and production policy durations require their separate approved rollout; exposing these public routes does not activate them.

New imports use attempt-owned object keys for every writer: cabinet/CHZ attempts use their actual import ID, and public attempts use their durable receipt effect ID. Snapshot readers accept the exact historical cabinet content-addressed path as a read-only compatibility case. Existing records and objects are not rewritten. Failed attempts cannot delete a different attempt's winning source. Ambiguous or successfully deduplicated losing objects may remain retained; this change adds no cleanup job.

Before exposing public routes in production, drain/stop old cabinet and CHZ import cleanup writers and deploy the new writer/reader code together. Old binaries can still delete a shared historical key while a public receipt references that cabinet winner. Tests of the new writer do not establish safety during an overlapping old-writer deployment. Apply the reviewed forward migrations and build shared packages before the API. Validate the full workflow and rollback/recovery plan in the release environment; this implementation task performs no production activation.
