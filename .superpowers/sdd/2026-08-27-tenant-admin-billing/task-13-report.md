# Task 13 — Integrated verification and visual acceptance

## Result

The tenant-owner billing lifecycle now has integrated UI and isolated-Postgres evidence from the
original Task 13 base `4c6c0ac4d`: capacity request creation, platform clarification, immutable
tenant reply retry, initial offer, change request, revised offer acceptance, linked invoice, two
confirmed payments reaching `paid`, issued act, and completed request. The tests assert exact-once
links and events, chronological history, stale and exact-retry behavior, tenant denial, capability
boundaries, and API-returned signed download URLs.

The evidence run and independent visual review exposed three product defects and fix them with
focused regression coverage:

- accepting a revised commercial offer did not find the request link stored against the original
  offer revision, so the request omitted `offer_accepted`; request lookup now stays tenant-scoped
  and resolves a unique request through the offer family;
- the fixed 224 px desktop sidebar clipped almost all admin content at 320/360 px. The shell now
  becomes a top, horizontally scrollable navigation rail on narrow screens while the main region
  remains independently vertically reachable.
- the sidebar footer's inline display style kept a duplicate profile row visible in the compact
  mobile shell. The narrow-screen rule now deliberately overrides that inline style, while the
  organization identity and account controls remain in the header.

MSW is not installed in the workspace manifest, lockfile, store, or linked installation. No new
dependency was introduced. The component journey therefore uses the repository's established
strict fetch router, which throws on every unexpected request. The Chromium harness independently
routes only anchored same-origin `/api/` requests, aborts and records every unexpected request,
and asserts that the record remains empty. This is the bounded variance from the brief's MSW
wording.

## Automated journey

- PASS — admin integrated flow: 1 file / 1 test. It renders the real `BillingLayout`, create,
  request detail, offer detail, invoice detail, and documents pages. The first clarification reply
  returns an ambiguous 503, and the retry assertion compares the exact serialized body and
  idempotency key. Signed request, invoice, and act download responses are opened only from the
  returned URLs.
- PASS — isolated Postgres integrated flow in
  `platform-billing-requests.service.test.ts`: complete lifecycle plus exact create/reply/offer/
  payment-link/act retries, changed-payload rejection, stale-offer denial, foreign-tenant request
  and offer denial, paid invoice, act issue, completion, unique links/events, and chronological
  history. The complete file passed 76/76 and dropped its UUID-named database.
- PASS — the three existing files from the Task 13 narrow command
  (`tenant-billing-actions.e2e.test.ts`, `platform-billing-requests.service.test.ts`, and
  `billing-acts.service.test.ts`) passed 97/97 on disposable databases. The planned
  `tenant-billing-read.e2e.test.ts` does not exist at this base; the current authoritative
  replacements `tenant-billing-read.authorization.test.ts`,
  `tenant-billing-read.integration.test.ts`, and `tenant-billing-read.service.test.ts` passed
  17/17.
- PASS — the current OpenAPI/HTTP boundary, raw auth route policy, and billing profile suites passed
  10/10 outside the filesystem sandbox, where loopback listeners are permitted.
- Route inventory and public OpenAPI behavior did not change. No route-count or generated public
  artifact was edited. The route inventory is DB-conditioned and was an explicit skip in the
  database-free full API attempt; the relevant billing route/OpenAPI checks already passed in the
  focused Task 12/13 suites.

## Package gates

The repository's pnpm wrapper and the local Corepack `pnpm.cjs` both stalled before package-script
execution in the linked worktree. The processes were bounded and stopped. Installed package-local
binaries were used with temporary absolute current-worktree aliases; every alias was restored to
its original relative target afterward.

- PASS — `@markiro/domain`: 22 files / 329 tests; typecheck, lint, build.
- PASS — `@markiro/db`: 27 passed and 18 skipped files; 110 passed and 94 skipped tests;
  typecheck, lint, build. Skips are explicitly infrastructure-conditioned.
- PASS — `@markiro/platform-contracts`: 9 files / 69 tests; typecheck. A consumer build also
  passed.
- PARTIAL — `@markiro/api test`: run with `DATABASE_URL` removed to avoid mutating the shared dev
  database. The first attempt reached a real-pnpm invocation test that stalled for about 70
  seconds; an outside-sandbox retry excluding only that file still failed to terminate inside the
  bounded window and was stopped. DB-dependent files skipped explicitly. The scoped isolated DB
  and HTTP suites above are green; the full aggregate is not claimed as green.
- PASS — `@markiro/api`: typecheck, lint, Nest build.
- PASS — `@markiro/admin`: 71 files / 791 tests; typecheck; lint with 0 errors and 5 inherited hook
  warnings outside the changed billing code; Vite build with the inherited large-chunk advisory.
- PASS — `@markiro/saas-admin`: 25 files / 235 tests; typecheck, lint, Vite build with the inherited
  large-chunk advisory.
- PASS — `@markiro/email`: 3 files / 23 tests; typecheck, lint, build.
- PASS — production-browser TypeScript no-emit.
- PASS — repository Prettier check and `git diff --check`.

The first admin full-suite attempt loaded 65 files / 655 tests successfully but Vite denied six
font-import suites because the installed font files resolve through the parent checkout's linked
`node_modules`, outside the worktree allowlist. The authoritative 791/791 rerun used a temporary
test-only filesystem allowance plus current-worktree package aliases; that config was removed.
The SaaS-admin suite used the same bounded temporary allowance and removed it afterward.

## Browser and accessibility

Storybook is not configured for `apps/admin`: there is no `.storybook` directory, story file,
Storybook manifest entry, or lockfile dependency. Task 13 therefore adds a test-only app-level Vite
harness that mounts the real `appRoutes`, providers, shell, and billing pages. It adds no production
mock route or runtime dependency.

PASS — Chromium 8/8 at the final revision:

- 1440x1024 and 1280x900 render the approved compact office hierarchy: fixed navigation, compact
  header, page title/action/tabs, subscription and offer pair, full-width limits, and lower
  operations/request pair. Typography, neutral panels, thin borders, compact density, green
  actions, and text-bearing statuses align with the approved screenshot. Fixture copy and values
  are intentionally real DTO-shaped test data, so this is a hierarchy/style comparison rather
  than a pixel-identity claim. A geometry assertion also requires the page heading to start beyond
  the measured desktop sidebar edge.
- 360x800 and 320x800 have no document-level horizontal overflow. The main navigation stays
  reachable as a horizontal rail, the billing tabs remain a labelled horizontal rail, and the
  lower `Активная заявка` card is reachable by scrolling the real main region. The 320 px visual
  shows the responsive top navigation, one identity/control row, full title/action, tabs, and an
  unclipped subscription card. The hidden duplicate profile link is asserted in both narrow
  viewports.
- `h1`/`h2` semantics, desktop invoice table to mobile cards, textual status labels, explicit
  loading announcement, error, empty, unmanaged, and forbidden states pass through real routes.
- Keyboard Tab reaches a visibly focused element. The offer alert dialog opens from the real offer
  page, Escape closes it, and focus returns to the `Принять` trigger.
- Every browser scenario asserts zero unexpected API requests. No axe dependency exists, so these
  are focused DOM/browser assertions rather than a claim of a complete automated WCAG audit.

Final ignored evidence files:

- `browser-output/tenant-billing.visual-rend-39d0b-hy-without-clipping-at-1440-chromium/overview-1440.png`
- `browser-output/tenant-billing.visual-rend-8474a-hy-without-clipping-at-1280-chromium/overview-1280.png`
- `browser-output/tenant-billing.visual-rend-e21ae-chy-without-clipping-at-360-chromium/overview-360.png`
- `browser-output/tenant-billing.visual-rend-9aab8-chy-without-clipping-at-320-chromium/overview-320.png`

The paths are relative to
`.superpowers/sdd/2026-08-27-tenant-admin-billing/`. Screenshots remain ignored test output rather
than arbitrary tracked binaries.

The checked-in `docs/design-briefs/tenant-admin-billing.pen` is only a blank 800x600 white frame
(315-byte JSON) and cannot be the stated visual target. Visual inspection therefore used the
approved evidence screenshot
`/Users/thevladbog/.codex/visualizations/2026/08/27/01a04418-fa6b-7c92-8696-7b62228567aa/tenant-admin-billing-direction/komY7.png`.

## Local external boundaries

UNRUN — `docker compose -f docker-compose.dev.yml ps` returned no active repository services. The
dev compose file uses repository-global named `mailpitdata` and `miniodata` volumes, and no
isolated Task 13 API environment was available. Starting that stack would create or reuse shared
state, so it was deliberately not started. Consequently there is no claim of a real Mailpit
delivery or MinIO request/invoice/act upload/download. The automated signed-URL and storage-service
stub assertions above are not represented as local MinIO proof.

Also unrun and unclaimed: production SMTP, bank reconciliation, 1C import, legal validity of the
act, DNS/TLS, production object storage, or deployment.

## Hygiene

- Read-only `pg_database` inspection found no `markiro_platform_billing_requests_*`,
  `markiro_billing_acts_*`, or `markiro_tenant_billing_read_*` scratch database after verification
  (`SCRATCH_DB_NONE` for Task 13 prefixes). Existing unrelated databases were not changed.
- No shared database migration, repair, drop, or data write was performed by the full package
  gate.
- All temporary current-worktree dependency aliases were restored. Pre-existing untracked
  `node_modules` symlinks remain untouched as worktree infrastructure.
- Temporary Vitest configs were removed. Chromium/Vite servers are stopped; port 61592 has no
  listener.

## Changed areas

- `apps/admin/test/billing-flow.test.tsx` — strict deterministic owner lifecycle.
- `apps/api/test/platform-billing-requests.service.test.ts` — isolated authoritative full journey.
- `apps/api/src/modules/tenant-billing/tenant-billing-offers.service.ts` — family-aware revised
  offer/request event fix.
- `apps/admin/src/layout/AppShell.tsx` and `apps/admin/src/global.css` — narrow-screen shell fix.
- `apps/admin/test/browser/*` and `tools/production-browser/*tenant-billing*` — test-only real-app
  Chromium evidence harness and assertions.

## Commit

The scoped commit SHA is reported in the handoff because a commit cannot contain its own SHA.
