# Kiosk PWA Production Design

**Status:** approved in the 2026-08-08 deployment session

## Goal

Publish the existing `@markiro/kiosk` PWA at
`https://kiosk.markiro.app` without adding a VM, load balancer, backend group,
or public IP. Keep the cabinet at `https://admin.markiro.app`, preserve the
single-VM MVP budget, and keep public DNS disabled until the existing first
go-live gates pass.

## Product boundary

Markiro has two different kiosk delivery surfaces:

- The browser-installable kiosk PWA is the subject of this change. It is served
  from `kiosk.markiro.app` and uses the existing kiosk pairing and device-token
  protocol.
- The desktop Tauri kiosk is a separate packaged application. Its UI is bundled
  into the installer and therefore needs no public hostname or TLS certificate.
  It still uses the public API's server-side TLS and will need separate installer
  and updater signing work. This design does not add or change a Tauri shell.

The existing line-station Tauri application is also out of scope.

## Current constraints

- The production edge image currently builds and serves only `@markiro/admin`.
- The kiosk manifest has root scope and root `start_url`; serving it below an
  admin path would collide with admin navigation and service-worker ownership.
- The kiosk API client defaults to `/api` and appends `/kiosk/*` routes.
- `KIOSK_ORIGIN` is already the API's narrowly scoped browser-origin boundary
  for kiosk routes and is deliberately excluded from Better Auth origins.
- The Yandex production stack already has one private app VM, one ALB, one
  backend group, SWS, ARL, a reserved public address, and Cloud DNS.
- The current first go-live remains gated. This change must not publish either
  application record early or bypass plan, apply, rehearsal, or smoke evidence.

## Chosen architecture

### One edge image, two independent sites

The existing edge build produces both frontends:

- `@markiro/admin` is copied to `/srv/admin`.
- `@markiro/kiosk` is copied to `/srv/kiosk`.

The runtime remains the existing unprivileged Caddy image. It contains no Node
runtime, package manager, source tree, or build credentials.

Caddy selects the site by exact Host:

- `admin.markiro.app` serves `/srv/admin` and retains the current production
  API, Better Auth, CommerceML, station/kiosk device, health, OpenAPI, and docs
  route table.
- `kiosk.markiro.app` serves `/srv/kiosk`. It proxies only
  `/api/kiosk/*`, stripping the leading `/api` before forwarding to the API.
  It does not expose Better Auth, CommerceML, station routes, documentation, or
  the admin SPA.
- Any unknown Host receives `404`.
- Non-GET/HEAD requests that do not match an explicitly allowed proxy route
  receive `404` rather than an SPA document.

Both sites retain release-SHA headers, compression, immutable hashed-asset
caching, no-cache SPA entrypoints, security headers, and a self-contained CSP.
The kiosk service worker continues to exclude `/api/*` from navigation fallback
and runtime caching.

### Configuration boundary

Add one non-secret deployment variable:

```text
MARKIRO_KIOSK_DOMAIN=kiosk.markiro.app
```

Terraform receives it as `kiosk_domain`. The deploy workflow, preflight,
remote-deploy boundary, Compose environment, smoke checks, DNS checks, and
Caddy receive the same validated hostname. Validation requires lowercase FQDNs
and rejects equality between admin and kiosk domains.

The runtime Lockbox continues to contain:

```text
KIOSK_ORIGIN=https://kiosk.markiro.app
```

Preflight compares that origin to `https://${MARKIRO_KIOSK_DOMAIN}` without
printing the environment value. A missing, differently schemed, port-bearing,
path-bearing, or mismatched value fails closed before containers start.

### Existing Yandex ingress, second hostname

Reuse the existing reserved IPv4 address, ALB, HTTP router, backend group, SWS
profile, ARL profile, logging, and app target group.

Add a separate managed Certificate Manager certificate for
`kiosk.markiro.app`. The existing admin certificate is not replaced. Terraform
creates the kiosk DNS validation record and waits for the certificate to become
issued before attaching it to the existing HTTPS listener. The listener keeps
the admin certificate in its default handler and serves the kiosk certificate
through a kiosk SNI handler. The existing virtual host accepts the exact admin
and kiosk authorities and forwards both to the same private Caddy backend.

Add a second application A record for `kiosk.markiro.app`, gated by the same
`public_dns_enabled` boolean as the admin record. Certificate validation records
remain available while public application records are disabled.

Expose the kiosk certificate ID/status and both production hostnames as
non-sensitive Terraform outputs. No new compute, ALB, backend, address, DNS
zone, SWS, ARL, or log group resource is created.

## Monitoring

Keep the existing 16-alert contract. Do not add a seventeenth alert.

Update the existing `certificate_risk` query to select both certificate IDs and
combine the two time series with `series_min(...)`. The alert therefore evaluates
the certificate with the fewest remaining days using the existing Warning `30`,
Alarm `14`, and one-hour window. Its category and existing console alert ID stay
unchanged.

The dashboard certificate widget uses the same combined query. The protected
alert-spec artifact records the exact two-certificate selector. Once Terraform
has created the kiosk certificate and emitted its ID, the operator updates the
existing console alert from the artifact and verifies the query and channel
before the next protected acceptance run.

## Security and failure handling

- The kiosk hostname never serves the admin bundle.
- The admin hostname never serves the kiosk bundle or service worker.
- The kiosk hostname proxies only the kiosk API namespace.
- Pairing codes, device tokens, tenant isolation, rate limiting, and offline
  queue semantics do not change.
- SWS, global ARL, per-IP ARL, and ALB logging cover both authorities.
- Invalid or missing hostname/origin configuration fails preflight.
- Missing frontend build output fails the image build.
- Missing or non-issued kiosk TLS evidence blocks ALB attachment and go-live.
- Unknown hosts, unsupported methods, and unrecognized kiosk paths fail with
  non-SPA `404` responses.
- API responses and `/api/*` requests are never service-worker cached.
- The deployment continues to use one digest-pinned edge image, so admin and
  kiosk static assets switch atomically with the release SHA.

## Rollout

1. Merge and publish a release whose edge image contains both immutable builds.
2. Set `MARKIRO_KIOSK_DOMAIN=kiosk.markiro.app` in each workflow environment
   that already carries `MARKIRO_DOMAIN`.
3. Verify the runtime Lockbox has the exact matching `KIOSK_ORIGIN` without
   displaying its value.
4. Run the protected infrastructure plan with
   `public_dns_enabled=false`. Review the new kiosk certificate, validation
   record, authority, listener certificate, outputs, and alert query changes;
   reject replacement or deletion of the existing admin certificate, ALB,
   address, backend, VM, or durable data resources.
5. Approve and apply the reviewed plan. Wait for the kiosk certificate to become
   issued.
6. Update the existing certificate-expiry console alert from the generated
   alert-spec artifact and retain the same alert ID.
7. Run the first deployment rollback rehearsal and successful first deployment
   using the existing ordered gates. Private smoke uses `curl --resolve` for
   both hostnames while public DNS remains absent.
8. Verify the kiosk shell, manifest, service worker, release SHA, and kiosk API
   boundary through the reserved ALB address.
9. Only after all first-go-live gates pass, apply
   `public_dns_enabled=true` to publish both A records and run post-DNS smoke for
   both hostnames.

If either hostname fails private smoke, public DNS remains disabled and the
existing rollback and cleanup workflow handles the single atomic edge release.

## Automated acceptance

### Frontend and image

- `@markiro/admin` and `@markiro/kiosk` production builds pass.
- The edge Dockerfile installs only the required workspace inputs and builds
  both apps.
- The runtime contains `/srv/admin` and `/srv/kiosk`, retains the non-root Caddy
  user, and contains no build toolchain.
- The kiosk build includes `index.html`, `manifest.webmanifest`, service-worker
  assets, icons, fonts, and hashed bundles.

### Routing and smoke

- Caddy adaptation proves exact admin and kiosk Host matchers in direct and ALB
  modes.
- Admin route parity remains unchanged.
- The kiosk host returns its own shell and never the admin shell.
- `/api/kiosk/*` reaches the API with the correct stripped path and finite
  transport timeouts.
- `/api/auth/*`, `/1c_exchange`, `/station/*`, `/docs`, and unknown mutation
  routes on the kiosk host return non-SPA `404` responses.
- Kiosk manifest and service worker are reachable, while API paths cannot become
  navigation fallbacks.
- Private and public smoke verify the exact release SHA on both authorities.

### Infrastructure and contracts

- Terraform formatting and validation pass with pinned provider `0.215.0`.
- Contract tests prove one existing ALB, address, backend, VM, SWS, and ARL; two
  exact authorities; one admin default certificate plus one kiosk SNI
  certificate handler; separate validation records; and two application A
  records behind one DNS gate.
- Contracts reject equal domains, an ungated kiosk A record, replacement of the
  admin certificate, an unprotected kiosk route, or a new public compute path.
- Alert-spec contracts prove `series_min(...)` covers exactly both certificate
  IDs while preserving the existing `certificate_risk` category.
- Production bundle, workflow, runbook, and browser-doc contract suites pass.

## Manual and external acceptance

Automated checks do not prove:

- Certificate Manager issuance in the live folder.
- DNS convergence on public resolvers.
- PWA installation and fullscreen behavior on the target tablet or desktop.
- Scanner behavior, offline restart, queued-order recovery, or service-worker
  update takeover on physical hardware.
- The separate Tauri kiosk's installer, code signing, updater signing, Windows
  behavior, or hardware integration.

Record these as separate evidence. Do not label the Tauri kiosk, Windows,
scanner, or physical-device surface accepted from browser or CI results.

## Cost impact

The design adds no compute, address, ALB, backend, database, or log-group
resource. Certificate Manager is not charged separately. The existing Cloud DNS
zone gains validation and application records; only normal DNS request usage
changes. This preserves the accepted MVP infrastructure profile.
