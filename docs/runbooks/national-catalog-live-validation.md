# National Catalog live read validation

Run this gate only against a tenant that the deployment owner has authorized for
National Catalog read validation. It makes only these GET requests:

- `/v3/categories` and an immediate conditional repeat;
- `/v3/attributes`;
- `/v3/feed-product` for a known, tenant-authorized GTIN;
- `/v3/product` for the same GTIN and an immediate conditional repeat.

The repeat must return `304 Not Modified` for `categories` and `product`.
`attributes` and `feed-product` record their outcome and ETag presence, but do
not require a `304`: that behavior is not documented for those methods.

## Required evidence before enabling the integration

Record outside source control:

- tenant identity selected as `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID`;
- the owner's confirmation that the tenant's current GIS MT token may perform
  these reads, including the role/right evidence for categories, attributes,
  own-card, and published-card access;
- a known GTIN that is safe to use as `NATIONAL_CATALOG_LIVE_GTIN`;
- method outcome, result count, and whether an ETag was present.

Do not record or print the bearer, encrypted token material, API key, response
headers, or raw product-card payload. `NATIONAL_CATALOG_LIVE_GTIN` is test data,
not a credential.

## Protected production run

Deploy the revision containing the diagnostic CLI, then start the protected
`Diagnose production runtime` GitHub Actions workflow with `national_catalog`
enabled. The workflow reuses the dedicated `markiro-deploy` SSH identity and
pinned host keys. It resolves exactly one running `api` container and executes
only `dist/national-catalog-live-diagnostic.js` inside it.

The production diagnostic fails closed unless there is exactly one tenant with
an unexpired encrypted ChZ token. It selects one unarchived product from that
same tenant, decrypts the bearer only inside the API container, and uses the
official production National Catalog endpoint. It does not add National
Catalog values to the production Lockbox inventory.

The workflow output is limited to a closed source-status enum, method outcome,
result count, ETag presence, and the aggregate pass/fail flag. Tenant, GTIN,
bearer, provider error message, headers, and payloads are never emitted. An
unexpected internal or transport failure produces only
`MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE {"stage":"<stage>"}`. The stage
is restricted to `configuration`, `credential-validation`, `workspace-setup`,
`api-container-discovery`, `api-cli-transport`, `api-cli-exit`,
`api-cli-evidence-missing`, `api-cli-evidence-invalid`,
`api-cli-exit-mismatch`, `cleanup`, or `unknown`; arbitrary exception text is
never serialized.

## Explicit local or sandbox run

Use the deployment's existing secret store and local environment loader. Do not
place a bearer in a shell command, source file, test fixture, or terminal log.
The active token must already be encrypted in Markiro's `chz_api_tokens` store
for the configured source tenant; the test retrieves it only through
`ChzTokenService`.

Set these non-secret validation settings in the runtime environment:

```text
NATIONAL_CATALOG_BASE_URL=https://authorized-catalog-environment.example
NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID=authorized-tenant-id
NATIONAL_CATALOG_LIVE_GTIN=known-gtin
```

`NATIONAL_CATALOG_BASE_URL` must be the authorized environment selected by the
deployment owner. This configurable local/integration path deliberately has no
default production endpoint; the protected production diagnostic described
above is a separate path with the official endpoint pinned in code. Keep
`NATIONAL_CATALOG_REQUEST_TIMEOUT_MS` at its 15000 ms default unless an operator
has a documented reason to adjust it.

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/national-catalog.live.test.ts
```

The test skips when any of the three `NATIONAL_CATALOG_*` validation settings
above is absent. A skip, `forbidden`, or unsupported method result is a stop
gate: keep the integration disabled and obtain the tenant/right evidence before
starting persistence or feature work.
