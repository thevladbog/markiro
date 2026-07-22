# Plan 03: Catalog, Counterparties & Shifts + Admin Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first user-facing slice: tenant CRUD API (org profile, counterparties, products with GTIN owner auto-detection, lines, shifts) and `apps/admin` — the Markiro admin panel shell (design system from the handoff, RU/EN, light/dark) with catalog, counterparties and shift-planning screens.

**Architecture:** `packages/ui` ports the accepted design handoff (tokens + office-mode components) into typed React; `apps/api` grows one Nest module per aggregate, every route behind `TenantGuard`; `apps/admin` is Vite + React 19 with better-auth client, TanStack Query for data, i18next for RU/EN, `data-theme` for theming. API contracts are stated per endpoint in this plan and mirrored as zod DTOs server-side.

**Tech Stack additions:** react-router 8.2, @tanstack/react-query 5.101, i18next 26.3 + react-i18next 17.0, react-hook-form 7.82 + @hookform/resolvers 5.4, @vitejs/plugin-react 6.0, @testing-library/react 16.3 + jsdom 29.1, @fontsource/ibm-plex-sans + @fontsource/ibm-plex-mono 5.3.

## Global Constraints

- Exact versions above (registry-checked 2026-07-22); if the 7-day quarantine (`minimum-release-age=10080`) rejects one, take the newest version that passes and record it in the task report. Never add quarantine exclusions.
- Design source of truth: `docs/design-briefs/design_handoff_markiro/` — tokens in `design-system/tokens/*.css`, reference components in `design-system/components/**/*.jsx` (+ `.d.ts` prop contracts, `.prompt.md` docs), admin prototype `prototypes/admin-panel.dc.html`. Port faithfully: colors, radii, spacing, control heights (office 40px), status chip anatomy. No CDN assets — fonts via @fontsource packages.
- All UI strings через i18next: RU (default) + EN dictionaries from day one; no hardcoded copy in components. Themes: light default in admin, dark fully working (`data-theme="dark"`).
- Every API route in this plan: behind `TenantGuard`; all queries filtered by `req.tenantId`; zod-validated bodies; English error copy.
- New packages follow repo conventions: ESM (`"type": "module"`) except apps/api; exact pins; `lint`/`typecheck`/`test`/`build` scripts wired for turbo.
- Conventional commits, English. TDD where behavior exists.

---

### Task 1: `packages/ui` — tokens, fonts, theme

**Files:**

- Create: `packages/ui/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/tokens.css`, `src/fonts.css`, `src/theme.tsx`, `src/cn.ts`
- Test: `packages/ui/test/theme.test.tsx`

**Interfaces:**

- Produces: `@markiro/ui` package; `import "@markiro/ui/styles.css"` (tokens+fonts bundled via package `exports` → `./styles.css`); `<ThemeProvider>` + `useTheme()` (`{ theme: "light"|"dark"|"system", setTheme }`, persists to localStorage `markiro.theme`, sets `data-theme` on `<html>`); `cn(...classes)` helper.

- [ ] Step 1: Package scaffold mirroring `packages/domain` conventions; deps: react (peer), @fontsource/ibm-plex-sans@5.3.0 + @fontsource/ibm-plex-mono@5.3.0; devDeps: typescript@6.0.3, vitest@4.1.10, jsdom@29.1.1, @testing-library/react@16.3.2, @vitejs/plugin-react@6.0.4, @types/react (line matching react 19.2). vitest environment: jsdom.
- [ ] Step 2: `src/tokens.css` — copy `design-system/tokens/colors.css` (both themes) verbatim from the handoff, then append the contents of `typography.css` and `spacing.css`. `src/fonts.css` — `@import "@fontsource/ibm-plex-sans/400.css";` (+500/600/700) and mono 400/500/600; set `--font-ui`/`--font-mono` if the handoff tokens reference them. `styles.css` = tokens + fonts (concatenated via a `src/styles.css` that `@import`s both; package exports map exposes it).
- [ ] Step 3 (TDD): failing test — render `<ThemeProvider defaultTheme="dark"><Probe/></ThemeProvider>`; Probe reads `useTheme()`; assert `document.documentElement.dataset.theme === "dark"`; `setTheme("light")` flips it and persists to localStorage. Implement `theme.tsx` (context + effect). `cn` = filter+join test.
- [ ] Step 4: `pnpm turbo lint typecheck test build` green (ui included). Commit: `feat(ui): design tokens, bundled IBM Plex, theme provider`.

---

### Task 2: `packages/ui` — office components (forms & display)

**Files:**

- Create: `src/components/{Button,Input,Select,Card,Badge,StatusChip,Table,Field}.tsx`, `src/components/index.ts`
- Test: `packages/ui/test/components.test.tsx`

**Interfaces:**

- Consumes: tokens/theme (Task 1). Port sources: handoff `design-system/components/forms/{Button,Input,Select}.jsx` (+`.d.ts`), `display/*` for Card/Badge/Table specimens (check `display/display.card.html`).
- Produces (typed props, office mode): `Button {variant: "primary"|"secondary"|"destructive"; size?: "md"|"compact"}` (40px/32px heights per handoff), `Input`, `Select`, `Field {label, error?, children}` wrapper, `Card`, `Badge`, `StatusChip {status: "ok"|"error"|"warn"|"info"|"neutral"}` (color+icon+text — never color alone), `Table` (semantic table with `overflow-x:auto` wrapper, numeric cells `font-mono nowrap` class hook).

- [ ] Step 1 (TDD): failing tests — Button renders variants with correct class/height style hooks and fires onClick; StatusChip renders icon glyph + label text for each status; Field associates label/error with input (accessibility: `aria-invalid`, `aria-describedby`).
- [ ] Step 2: Port each `.jsx` reference to `.tsx`, converting inline styles to the CSS-variable-based classes/styles used in the handoff (keep the exact tokens: `--surface-card`, `--line`, `--ok-fg`, etc.). Respect `.d.ts` prop contracts from the handoff where present.
- [ ] Step 3: Suite green; export barrel; turbo green. Commit: `feat(ui): office-mode form and display components`.

---

### Task 3: `packages/ui` — feedback & navigation components

**Files:**

- Create: `src/components/{Alert,Modal,EmptyState,Spinner,Sidebar,PageHeader,Toast}.tsx`; extend barrel
- Test: `packages/ui/test/feedback.test.tsx`

**Interfaces:**

- Port sources: handoff `feedback/{Alert,Modal,EmptyState,Progress}.jsx`, `navigation/{Sidebar}.jsx` (+ prototype sidebar in `prototypes/admin-panel.dc.html`: 224px, `--surface-panel`, logo slot, sections with badges, user card at bottom).
- Produces: `Alert {tone: "ok"|"error"|"warn"|"info"}`; `Modal {open, onClose, title}` (focus trap, Esc closes, overlay per tokens); `EmptyState {title, hint?, action?}`; `Sidebar {items: {to, labelKey, badge?}[], footer}` (renders react-router `NavLink`s — accept a `renderLink` prop to stay router-agnostic); `PageHeader {title, actions?}`; `Toast` minimal imperative helper `toast(tone, message)`.

- [ ] Step 1 (TDD): Modal — renders when open, calls onClose on Esc and overlay click, keeps focus inside; Alert tones map to semantic tokens; Sidebar renders items via injected renderLink.
- [ ] Step 2: Port + implement; Step 3: green + commit `feat(ui): feedback and navigation components`.

---

### Task 4: API — organization profile (GLN, GS1 prefixes)

**Files:**

- Create: `packages/db/src/schema/org-profile.ts` (+ barrel export), migration via `drizzle-kit generate`
- Create: `apps/api/src/modules/org-profile/{org-profile.module.ts,org-profile.controller.ts,org-profile.service.ts,dto.ts}`
- Test: `apps/api/test/org-profile.e2e.test.ts`

**Interfaces:**

- Table `org_profiles`: `tenant_id text PK REFERENCES organization(id)`, `gln text`, `gs1_prefixes text[] NOT NULL DEFAULT '{}'`, `inn text`, `updated_at timestamptz DEFAULT now()`.
- `GET /org/profile` → `{ gln: string|null, gs1Prefixes: string[], inn: string|null }` (empty defaults if row absent). `PUT /org/profile` body `{ gln?, gs1Prefixes?, inn? }` (zod: gln 13 digits or null; prefixes: array of 4–12 digit strings) → upsert, returns profile. Both behind TenantGuard.
- Produces for Task 6: service method `getPrefixes(tenantId): Promise<string[]>`.

- [ ] Step 1 (TDD e2e, env-gated like existing): unauthenticated → 401; after sign-up+org create+**set-active** (`POST /api/auth/organization/set-active` with organizationId — this also closes the Plan-02 handoff: assert the guarded route 200s only after set-active) — GET returns defaults; PUT roundtrips; second org sees its own empty profile (tenant isolation).
- [ ] Step 2: schema + `db:generate` migration (verify no spurious codes/scan_events statements — config already excludes them); service+controller with zod pipe pattern (create `apps/api/src/zod.pipe.ts` once: `ZodValidationPipe(schema)` — reused by all modules in this plan).
- [ ] Step 3: green (focused e2e + turbo). Commit: `feat(api): organization profile with GLN and GS1 prefixes`.

---

### Task 5: API — counterparties CRUD

**Files:**

- Create: `apps/api/src/modules/counterparties/{module,controller,service,dto}.ts`
- Test: `apps/api/test/counterparties.e2e.test.ts`

**Interfaces (all under TenantGuard):**

- `GET /counterparties` → `{ items: Counterparty[] }`; `POST /counterparties` `{ name, gln, inn?, gs1Prefixes?, notes? }` → 201 Counterparty; `PATCH /counterparties/:id` partial same fields; `DELETE /counterparties/:id` → 204 (409 with English message if referenced by products/shifts — catch FK violation).
- `Counterparty = { id, name, gln, inn: string|null, gs1Prefixes: string[], notes: string|null, createdAt }`.
- zod: name 1..200; gln exactly 13 digits; prefixes 4–12 digits each.

- [ ] Step 1 (TDD e2e): CRUD happy path; cross-tenant isolation (org B cannot GET/PATCH org A's id → 404); validation 400 on bad GLN.
- [ ] Step 2: implement (drizzle queries always `where eq(tenantId)`); Step 3: green + commit `feat(api): counterparties CRUD`.

---

### Task 6: API — products CRUD + GTIN owner check

**Files:**

- Create: `apps/api/src/modules/products/{module,controller,service,dto}.ts`
- Test: `apps/api/test/products.e2e.test.ts`

**Interfaces (TenantGuard):**

- `GET /products?search=&status=` → `{ items: Product[] }`; `POST /products` `{ gtin, name, productGroup?, boxCapacity?, palletCapacity?, defaultCounterpartyId?, status? }`; `PATCH /products/:id`; `DELETE /products/:id` (409 if referenced by shifts).
- `Product = { id, gtin14, name, productGroup, boxCapacity, palletCapacity, status: "draft"|"active", defaultCounterpartyId, createdAt }`. `gtin` input accepted as GTIN-8/12/13/14 → normalized via `normalizeToGtin14` (@markiro/domain); invalid → 400 `GTIN_INVALID`; duplicate per tenant → 409.
- `POST /products/gtin-check` `{ gtin }` → `{ gtin14, owner: "own" | "counterparty" | "unknown", counterpartyId?: string, counterpartyName?: string }` — logic: normalize; `gtinMatchesPrefix` against org profile prefixes (Task 4 service) → "own"; else against each counterparty's prefixes → "counterparty"+id/name (first match); else "unknown". This backs the catalog's owner-hint UX (design brief 03).
- Status rule: product becomes `active` only when boxCapacity AND palletCapacity AND productGroup are set; otherwise stays/downgrades to `draft` (server-computed on create/patch — clients don't send status; drop it from POST/PATCH bodies).

- [ ] Step 1 (TDD e2e): create with EAN-13 normalizes to gtin14; duplicate 409; gtin-check returns own/counterparty/unknown across three seeded prefixes; draft→active flips when capacities+group filled via PATCH; cross-tenant 404.
- [ ] Step 2 implement; Step 3 green + commit `feat(api): products CRUD with GTIN owner detection and draft rule`.

---

### Task 7: API — lines + shifts planning CRUD

**Files:**

- Create: `apps/api/src/modules/lines/{module,controller,service,dto}.ts`, `apps/api/src/modules/shifts/{module,controller,service,dto}.ts`
- Test: `apps/api/test/shifts.e2e.test.ts`

**Interfaces (TenantGuard):**

- Lines: `GET /lines`, `POST /lines {name}`, `PATCH /lines/:id {name}`, `DELETE /lines/:id` (409 if referenced).
- Shifts: `GET /shifts?status=&from=&to=&lineId=` → `{ items: Shift[] }` (joined `productName`, `lineName`, `counterpartyName`); `POST /shifts` `{ productId, mode, plannedQty?, plannedDate?, lineId?, counterpartyId?, boxCapacity?, palletCapacity?, palletsEnabled? }` — server prefill: box/pallet capacity default from product when omitted; counterparty defaults from product's defaultCounterpartyId; `mode: "aggregation"` requires boxCapacity (400 otherwise); **products with status "draft" are rejected (422, "Product card is incomplete")** — the design's draft-blocks-shift rule; `PATCH /shifts/:id` allowed only while `status === "planned"` (409 otherwise); `DELETE /shifts/:id` only planned (409 otherwise); `POST /shifts/:id/close` allowed from `active` (station will activate in Plan 05; admin can close a stuck shift — audit note field required `{reason}`).
- `Shift = { id, status, mode, productId, productName, lineId, lineName, counterpartyId, counterpartyName, plannedQty, plannedDate, boxCapacity, palletCapacity, palletsEnabled, createdFrom, openedAt, closedAt, createdAt }`.

- [ ] Step 1 (TDD e2e): create from active product prefills capacities+counterparty; draft product → 422; aggregation without boxCapacity → 400; PATCH after (test-hook: set status active via direct db update) → 409; list filters; tenant isolation.
- [ ] Step 2 implement; Step 3 green + commit `feat(api): lines and shift planning CRUD with product defaults`.

---

### Task 8: API — CORS, trusted origins, OpenAPI polish

**Files:**

- Modify: `apps/api/src/main.ts`, `apps/api/src/env.ts`, `apps/api/src/auth/auth.setup.ts`, `packages/db/src/auth-config.ts`, `.env.example`, `.github/workflows/ci.yml` (env), `docker-compose.dev.yml` (no change expected — verify)
- Test: `apps/api/test/cors.e2e.test.ts`

**Interfaces:**

- New env `ADMIN_ORIGIN` (default `http://localhost:5173`). `app.enableCors({ origin: [env.ADMIN_ORIGIN], credentials: true })`; better-auth `trustedOrigins: [env.ADMIN_ORIGIN]` (thread an options param through `buildAuth` — keep the narrowed `Auth` type intact; extend the opts object `{ secret, baseURL, trustedOrigins?: string[] }`).
- All new modules (Tasks 4–7) registered in AppModule; every controller tagged for OpenAPI (`@ApiTags`) so `/docs` groups cleanly.

- [ ] Step 1 (TDD): cors e2e — preflight OPTIONS from ADMIN_ORIGIN gets `access-control-allow-origin` + credentials; foreign origin gets none. Auth POST from trusted origin (Origin header set) succeeds; from foreign origin → rejected by better-auth (403/401 — assert actual behavior and pin it).
- [ ] Step 2 implement (env + main + buildAuth opts); ci.yml job env adds `ADMIN_ORIGIN: http://localhost:5173`.
- [ ] Step 3 green + commit `feat(api): CORS and better-auth trusted origins for the admin app`.

---

### Task 9: `apps/admin` — scaffold, auth flow, i18n, theme

**Files:**

- Create: `apps/admin/` (Vite React TS app): `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/app.tsx` (router), `src/api/client.ts` (fetch wrapper, credentials include, base `/api` via Vite proxy → `http://localhost:3000`), `src/auth/client.ts` (better-auth react client + organization plugin client), `src/i18n/{index.ts,ru.json,en.json}`, `src/pages/auth/{Login,Register,CreateOrg,SelectOrg}.tsx`
- Test: `apps/admin/test/i18n.test.tsx` + auth page render tests

**Interfaces:**

- Deps: react@19.2.7, react-dom, react-router@8.2.0, @tanstack/react-query@5.101.4, better-auth (client, exact 1.6.23), i18next@26.3.6, react-i18next@17.0.10, react-hook-form@7.82.0, @hookform/resolvers@5.4.0, zod@4.4.3, @markiro/ui (workspace), @markiro/domain (workspace — client-side GTIN pre-validation).
- Routes: `/login`, `/register`, `/org/create`, `/org/select`, guarded layout `/` (redirects: no session → /login; session without active org → /org/select which lists orgs via auth client and calls set-active, offers create).
- better-auth client: `createAuthClient` from `better-auth/react` with `organizationClient()` plugin (check import path in installed package; document actual paths).
- i18n: `useTranslation()`; RU default, EN toggle; dictionaries seeded with auth + nav + common keys used in this plan (both languages, no missing-key warnings in tests).

- [ ] Step 1: scaffold + Vite proxy `/api → localhost:3000`; wire ui styles import; ThemeProvider at root.
- [ ] Step 2 (TDD-ish): i18n test — renders a component in RU by default, switches to EN; login page render test (labels from dictionaries, submit calls auth client — mock at fetch level with msw? Keep simpler: inject auth client via context and pass a fake in tests).
- [ ] Step 3: manual verification against the running api (document in report: register → create org → land on shell placeholder); turbo green (admin lint/typecheck/test/build wired). Commit: `feat(admin): app scaffold with auth flow, RU/EN, theming`.

---

### Task 10: `apps/admin` — shell (sidebar, header, guards)

**Files:**

- Create: `src/layout/{Shell.tsx,Header.tsx,useActiveOrg.ts}`; route stubs `src/pages/{dashboard,catalog,counterparties,shifts,settings}/index.tsx`
- Test: `apps/admin/test/shell.test.tsx`

**Interfaces:**

- Shell per admin prototype: 224px sidebar (`Sidebar` from @markiro/ui, items: Обзор/Каталог/Смены/Контрагенты/Настройки with i18n keys), content area with `PageHeader`; header shows org name, user, theme toggle, lang toggle, sign-out.
- `useActiveOrg()` — wraps auth client session; exposes `{ orgId, orgName }`; Shell renders only with active org (else redirect logic from Task 9).

- [ ] TDD: shell renders nav items from dictionaries; sign-out calls auth client and redirects; dashboard stub shows EmptyState. Implement, green, commit `feat(admin): app shell with sidebar navigation`.

---

### Task 11: `apps/admin` — counterparties screens

**Files:**

- Create: `src/pages/counterparties/{index.tsx,CounterpartyForm.tsx,api.ts}`
- Test: `apps/admin/test/counterparties.test.tsx`

**Interfaces:**

- `api.ts`: typed fetchers for Task 5 endpoints (TanStack Query hooks: `useCounterparties`, `useCreateCounterparty`, `useUpdateCounterparty`, `useDeleteCounterparty`).
- List page: Table (name, GLN, INN, prefixes count), PageHeader action «Добавить контрагента», EmptyState, delete with confirm Modal (409 → toast with server message). Form (Modal): react-hook-form + zodResolver mirroring server zod (name/GLN/INN/prefixes chips input — simple comma-separated input is acceptable this plan).
- Tests: fetch-mocked (vi.stubGlobal fetch or msw): renders list, validation error on bad GLN shown from zod before submit, create flow calls POST with normalized payload.

- [ ] TDD → implement → green → commit `feat(admin): counterparties management`.

---

### Task 12: `apps/admin` — catalog screens (GTIN hint)

**Files:**

- Create: `src/pages/catalog/{index.tsx,ProductForm.tsx,api.ts}`
- Test: `apps/admin/test/catalog.test.tsx`

**Interfaces:**

- List: Table (GTIN mono, name, group, capacities, StatusChip draft/active), search input, filter by status.
- ProductForm: on GTIN field blur/change (valid checksum only — pre-validate with `isValidGtin` from @markiro/domain to avoid noisy calls) → `POST /products/gtin-check` → inline hint: owner "counterparty" → Alert info «Владелец ГТИН — {name}. Подставить контрагента?» with one-tap apply to defaultCounterpartyId select; "unknown" → warn hint (non-blocking, per brief 03: helpful, not blocking). Draft rule surfaced: banner «Черновик — заполните группу и вместимости, чтобы запускать смены» when status draft.
- Tests: gtin-check mocked → hint renders and one-tap sets the select; invalid GTIN never triggers the check; draft banner logic.

- [ ] TDD → implement → green → commit `feat(admin): product catalog with GTIN owner hint`.

---

### Task 13: `apps/admin` — shifts screens

**Files:**

- Create: `src/pages/shifts/{index.tsx,ShiftForm.tsx,api.ts}`
- Test: `apps/admin/test/shifts.test.tsx`

**Interfaces:**

- List: Table (date, product, line, mode badge, plan, counterparty «для: X» when tolling, StatusChip planned/active/closed), filters (status, period), «Запланировать смену».
- ShiftForm: product select (active only — draft products show disabled with hint), mode radio (validation/aggregation), plannedQty, date, line select, counterparty select prefilled from product default (overridable), capacities prefilled from product (editable when aggregation; hidden when validation), palletsEnabled toggle + palletCapacity.
- Tests: prefill behavior on product change; aggregation toggles capacity fields; draft product disabled in select.

- [ ] TDD → implement → green → commit `feat(admin): shift planning screens`.

---

### Task 14: Integration polish, docs, ledger

**Files:**

- Modify: `README.md` (admin app section: dev commands, port 5173, env), `docs/architecture.md` (no changes expected — verify §1 structure now matches reality), roadmap marker
- Test: full-suite verification

- [ ] Step 1: end-to-end manual pass against dev stack (api + admin dev server): register → org → profile (GLN+prefixes) → counterparty → product (gtin-check hint) → shift planned; RU/EN toggle and dark theme spot-check on every new screen; record screenshots/notes in report.
- [ ] Step 2: README admin section; verify turbo pipeline covers admin (lint/typecheck/test/build) and CI stays green locally (`pnpm format:check && pnpm turbo lint typecheck test build` with env).
- [ ] Step 3: Commit `docs: admin app quickstart; plan 03 wrap-up`.

---

## Self-review notes

- Roadmap coverage: CRUD API ✓ (T4–7), admin shell + ui package from handoff ✓ (T1–3, 9–10), GTIN owner auto-detection ✓ (T6+T12), shift planning ✓ (T7+T13), RU/EN + themes ✓ (T1, T9, global), Plan-02 handoffs ✓ (CORS/trustedOrigins T8; set-active e2e T4).
- Deliberate scope cuts: label templates (Plan 04), station flows/activation (Plan 05), dashboard live data + exports/history (Plan 07) — dashboard route ships as EmptyState stub; users/operators screen (Plan 05 needs operator entity first); org settings screen limited to profile fields via API (full settings UI when more settings exist).
- Consistency: DTO field names match db schema camelCase mappings; `gtin-check` contract identical in T6 (server) and T12 (client); draft rule enforced server-side (T6/T7) and surfaced client-side (T12/T13).
