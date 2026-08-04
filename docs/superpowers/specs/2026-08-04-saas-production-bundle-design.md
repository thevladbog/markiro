# SaaS Production Bundle — Design Spec

**Date:** 2026-08-04
**Status:** Approved in design discussion; written-spec review pending
**Slice of:** Markiro MVP roadmap plan 08, deployment foundation
**Related:** `docs/architecture.md`,
`docs/superpowers/specs/2026-08-03-tenant-team-email-profile-design.md`,
`docs/runbooks/cabinet-rbac-rollout.md`

## Problem

Markiro now has a usable tenant cabinet, invite-only team lifecycle, durable
email, private S3 media, offline station and kiosk clients, and first-owner
provisioning. It still cannot be deployed as a reproducible SaaS release. The
repository has only a development Compose file; there are no production
images, reverse-proxy routes, runtime migrations, production health gates, or
container-level smoke tests.

The first customer should not be deployed from a developer checkout or by
running pnpm directly on a VM. A release must be an immutable pair of images
plus a Compose contract whose startup, migrations, routing, failure behavior,
and rollback can be exercised before any Yandex Cloud credentials exist.

This slice creates that production bundle. It deliberately does not provision
cloud resources. Yandex Cloud networking, DNS, Managed PostgreSQL, Object
Storage, registry credentials, backups, monitoring, and the first live rollout
are the next slice and consume the interfaces defined here.

## Goals

- Build immutable production images for the Nest API and the admin/Caddy edge.
- Run one explicit migration job before an API version becomes healthy.
- Serve the cabinet and every existing public API/device route from one TLS
  endpoint without changing client contracts.
- Separate liveness from readiness and expose degraded optional dependencies.
- Keep secrets outside images, Compose source, logs, and command output.
- Make deploy, health-gated rollout, rollback, and first-owner provisioning
  reproducible for a single-VM SaaS MVP.
- Verify the real production bundle in CI with PostgreSQL, Mailpit, and MinIO.

## Non-goals

- No Yandex Cloud Terraform, VM creation, security groups, DNS, registry login,
  Managed PostgreSQL, Object Storage bucket creation, or backup automation.
- No public landing page, billing, subscription state, or platform SaaS admin.
- No kiosk PWA hosting and no station installer publication. Their existing API
  routes remain reachable; their artifact delivery stays in later release work.
- No horizontal API or Caddy cluster. The bundle is one edge and one API
  process, matching the selected one-VM MVP.
- No automatic database rollback. Migrations remain forward-only.
- No third-party Caddy modules in this slice.

## Chosen topology

The production Compose project has three services:

1. `migrate` runs the compiled database migrator from the API image and exits.
2. `api` starts only after `migrate` completes successfully and is reachable
   only on the private Compose network.
3. `edge` contains the built admin SPA and Caddy, starts only after the API is
   ready, and is the only service publishing ports 80 and 443.

PostgreSQL, SMTP, and S3 are external production dependencies. The production
Compose file must not start local substitutes for them. A CI-only overlay adds
PostgreSQL, Mailpit, and MinIO without weakening production defaults.

The cabinet and API share one public origin. This preserves the admin client's
existing `/api` convention, avoids a new build-time API URL, and keeps Better
Auth cookies same-site. Station, kiosk-device, and 1C clients continue to use
the same server URL with their root-mounted routes.

## Images and build contract

### API image

The API image is a multi-stage build based on the exact official
`node:24.19.0-bookworm-slim` tag. The builder installs with Corepack pnpm
11.10.0 and `--frozen-lockfile`, builds `@markiro/api...`, and creates a
production-only deployment closure. The runtime stage contains:

- compiled API and workspace dependency output;
- production Node dependencies, including Sharp's native runtime;
- the ordered SQL migration directory;
- the compiled runtime migration CLI;
- a small Node healthcheck script; and
- `tini` as PID 1 for signal forwarding and zombie reaping.

The runtime process runs as the image's unprivileged `node` user. The Compose
service uses a read-only root filesystem, a bounded `/tmp` tmpfs, drops all
Linux capabilities, sets `no-new-privileges`, and exposes port 3000 only to the
private network. SIGTERM reaches Nest, which already enables shutdown hooks so
pg-boss and PostgreSQL pools close before the container grace period expires.

### Edge image

The edge image builds `@markiro/admin...` with the same pinned Node builder,
then copies only `apps/admin/dist` and the production Caddyfile into the exact
official `caddy:2.11.4-alpine` image. It contains no pnpm store, source tree,
Node runtime, or secrets.

Caddy's `/data` and `/config` directories use named volumes so ACME account and
certificate state survive container replacement. The admin assets are part of
the immutable image. No source or host-directory bind mount is allowed in the
production Compose file.

The repository records exact base tags. Published Markiro images use the git
commit SHA as their immutable tag; production refuses an empty or mutable
`MARKIRO_IMAGE_TAG`. A release record stores the resolved API and edge image
digests before deployment.

## Public route contract

Caddy preserves or rewrites paths as follows:

| Public request                      | Upstream behavior                                                     |
| ----------------------------------- | --------------------------------------------------------------------- |
| `/api/auth/*`                       | proxy unchanged to Better Auth at `/api/auth/*`                       |
| `/api/*`                            | strip only the leading `/api`, then proxy to root-mounted Nest routes |
| `/station/*`                        | proxy unchanged                                                       |
| `/kiosk/*`                          | proxy unchanged                                                       |
| `/1c_exchange`                      | proxy unchanged, including non-JSON request bodies                    |
| `/health`, `/health/*`              | proxy unchanged                                                       |
| `/openapi.json`, `/docs`, `/docs/*` | proxy unchanged                                                       |
| `/assets/*`                         | serve immutable admin assets with long-lived cache headers            |
| every other GET/HEAD                | serve an existing file or `index.html` for SPA routing                |
| every other non-GET request         | return 404; never fall through to `index.html`                        |

The ordering is explicit in one Caddy `route` block so SPA fallback can never
swallow an API request. Caddy forwards the authoritative client chain; the API
runs with `NODE_ENV=production` and `TRUST_PROXY_HOPS=1`, matching exactly one
reverse-proxy hop.

Static responses use zstd/gzip where supported. Fingerprinted assets receive a
one-year immutable cache policy; `index.html` is `no-cache` so a deployment
cannot strand users on an old asset manifest. HTTPS responses set HSTS,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and
`Referrer-Policy: strict-origin-when-cross-origin`. The CSP is exactly:

```text
default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'
```

CI asserts the exact header and rejects external script, style, font, image, or
connection origins in the built `index.html`.

## Runtime migrations

Production does not install or execute `drizzle-kit`. `@markiro/db` provides a
compiled runtime CLI around Drizzle's PostgreSQL migrator. It reads only
`DATABASE_URL` and a packaged migrations directory, takes a fixed PostgreSQL
advisory lock, applies pending migrations, and releases the lock on success or
failure. It emits migration identifiers and status, never the connection URL.

The `migrate` service uses the exact same API image tag that will be started.
Compose requires `service_completed_successfully` before starting `api`. A
failed migration blocks the release and leaves the previous running deployment
untouched when the deploy procedure is followed; operators inspect the
migration log and database state rather than restarting in a loop.

Migrations committed in one release must be backward-compatible with the
immediately previous API image. Destructive cleanup is a later release after
the old image is no longer a rollback target.

## Health model

The existing `GET /health` remains a compatibility alias for liveness.

`GET /health/live` returns 200 when the process event loop can serve requests.
It does not query the network or database and is the container liveness probe.

`GET /health/ready` returns a bounded component report:

- PostgreSQL query succeeds: required;
- pg-boss has started and accepts work: required;
- SMTP verification state: optional, reported as healthy, degraded, or
  unknown;
- S3 bucket probe state: optional, reported as healthy, degraded, or unknown.

Required failures produce HTTP 503 and `status: "unavailable"`. Optional
failures keep HTTP 200 with `status: "degraded"`; production operations that do
not need mail or avatars remain available. Error output contains stable
categories and timestamps, never credentials, endpoints with userinfo, or raw
provider errors. Every probe has a short timeout and cached state so a health
request cannot create an unbounded dependency fan-out.

Compose uses `/health/ready` for the API healthcheck. Caddy does not become a
release success signal until the API is ready and the cabinet root responds.

## Configuration and secrets

`compose.production.yml` accepts non-secret release variables from the shell:

- `MARKIRO_IMAGE_TAG` — required immutable git SHA;
- `MARKIRO_DOMAIN` — required public hostname;
- `ACME_EMAIL` — required certificate account contact;
- `MARKIRO_ENV_FILE` — optional path, default `.env.production`.

The external environment file supplies the existing API contract:
`DATABASE_URL`, Better Auth secret and URL, admin/kiosk origins, pairing
pepper, SMTP credentials and sender, mail payload encryption key, and S3
endpoint/credentials/bucket. A committed `.env.production.example` lists every
key with descriptions but contains no usable credential, development default,
or secret-shaped placeholder.

`.env.production`, release records containing private registry references, and
local Caddy data are ignored. The runbook requires mode 0600 on the environment
file. Operators use `docker compose config --quiet`; they must never print the
fully rendered Compose config because it expands secrets.

Production `loadEnv()` continues to reject missing SMTP and S3 values. The
bundle adds no fallback to Mailpit, MinIO, localhost, or an insecure TLS mode.

## Edge abuse controls

The official Caddy image does not contain an HTTP rate-limit directive. This
slice does not silently introduce a community module or an unpinned Go build.
Existing API-specific database-backed limits remain the application backstop.
No generic edge body limit is added because `/1c_exchange` legitimately accepts
large CommerceML uploads; endpoint-specific application limits remain
authoritative.

Public go-live additionally requires one of these controls in the cloud slice:

- a provider/WAF edge rate limit in front of Caddy; or
- a separately reviewed custom Caddy image with an exact source revision,
  reproducible build, SBOM, vulnerability scan, and per-source/global policy.

Until that control is verified, the production bundle is release-candidate
infrastructure, not authorization to expose anonymous routes to the internet.
This makes the current limitation explicit rather than claiming that standard
Caddy provides a feature it does not ship.

## Deploy and rollback procedure

The bundle's runbook defines this order:

1. verify the environment file permissions and required variables;
2. record API/edge image digests and the current deployed tag;
3. confirm a fresh managed-PostgreSQL backup and object-storage policy in the
   cloud environment;
4. pull both images by the approved immutable tag;
5. run `migrate` once and stop on any non-zero exit;
6. recreate `api`, wait for readiness, then recreate `edge`;
7. smoke the cabinet, auth boundary, device route, and first-owner workflow;
8. retain the previous tag and release record until the observation window
   ends.

Application rollback restores the previous API and edge image tag without
reversing migrations. It is permitted only while the release's migrations are
backward-compatible. If readiness fails, the edge is not switched to the new
API. If a post-switch smoke fails, restore the previous immutable images and
preserve logs; never edit production containers or database rows by hand.

## CI verification

A dedicated production-bundle job runs on pull requests and performs the
following against the exact Compose/Docker sources committed for production:

1. validate Dockerfiles, Caddy adaptation, Compose interpolation, and absence
   of development bind mounts or published API ports;
2. build API and edge images from a clean Docker context;
3. start PostgreSQL, Mailpit, and MinIO through a CI-only overlay;
4. initialize the private test bucket;
5. run the packaged `migrate` service twice to prove replay safety;
6. start API and edge under `NODE_ENV=production` and wait on readiness;
7. assert admin root/assets and SPA fallback;
8. assert `/api/auth/*` is preserved, `/api/*` is stripped once, and station,
   kiosk, 1C, health, docs, and OpenAPI routes are not served as SPA HTML;
9. prove the API has no host-published port and runs unprivileged;
10. stop the API with SIGTERM and assert a clean bounded exit;
11. show sanitized container logs only on failure and remove test volumes in an
    unconditional cleanup step.

The normal repository verify, tenant-team infrastructure, CodeQL, dependency,
Rust, and Windows jobs remain unchanged. The production-bundle job is an
additional gate, not a replacement.

## Failure behavior

- Invalid or missing production configuration fails API startup before it
  listens.
- A migration failure prevents API startup and returns a non-zero job status.
- PostgreSQL loss makes readiness 503; liveness stays 200 while the process can
  still serve, allowing orchestration to distinguish restart from dependency
  outage.
- SMTP or S3 loss makes readiness degraded but does not take unrelated factory
  operations offline. Their own operations continue to return explicit errors
  or durable retry states.
- API unavailability produces a proxy 502/503, never the admin SPA shell.
- Missing frontend files return SPA fallback only for GET/HEAD routes.
- ACME state survives edge replacement; certificate issuance failure is
  visible in Caddy logs and does not cause an insecure HTTP fallback.

## Acceptance criteria

- A clean checkout can build both production images with pinned toolchain and
  base-image versions.
- `compose.production.yml` contains only `migrate`, `api`, and `edge`, with no
  embedded database, SMTP sink, S3 emulator, credential, or source bind mount.
- The packaged migrator is replay-safe and does not require dev dependencies.
- The API runs unprivileged, privately, and with graceful shutdown.
- Public routing matches the table above, including Better Auth and 1C body
  handling.
- Required dependency loss yields readiness 503; SMTP/S3 loss yields a bounded
  degraded report without exposing provider details.
- CI boots and tests the real production bundle, including migration replay and
  shutdown.
- The operator runbook defines deploy, smoke, rollback, secret handling, and
  the external edge-rate-limit go-live gate.

## External references

- Official Caddy image guidance: https://hub.docker.com/_/caddy
- Official Node image tags: https://hub.docker.com/_/node
- Standard Caddy directives: https://caddyserver.com/docs/caddyfile/directives
- Caddy module status for non-standard HTTP rate limiting:
  https://caddyserver.com/docs/modules/http.handlers.rate_limit
