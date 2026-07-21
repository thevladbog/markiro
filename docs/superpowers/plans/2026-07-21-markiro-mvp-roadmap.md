# Markiro MVP — Plan Roadmap

> Master index. Each plan is written and executed separately
> (spec → plan → implement), produces working, testable software, and
> unblocks the next. Source specs: `docs/architecture.md`,
> `docs/design-briefs/00–05`, design handoff
> `docs/design-briefs/design_handoff_markiro/`.

| # | Plan | Scope | Depends on |
|---|------|-------|-----------|
| 01 | **Foundation & GS1 domain core** (written: `2026-07-21-01-foundation-gs1-domain.md`) | Turborepo+pnpm scaffold, CI, `packages/domain`: check digits, GTIN, KM DataMatrix parsing, SSCC, scan classification, shift-scan validation | — |
| 02 | DB package & API skeleton | `packages/db` (Drizzle PG schemas: orgs/users/counterparties/products/shifts/codes partitioned/scan_events), NestJS app, Better Auth (organization, api-key plugins), docker-compose dev, health/OpenAPI | 01 |
| 03 | Catalog, counterparties & shifts | CRUD API + admin panel shell (`packages/ui` from handoff tokens, sidebar, RU/EN i18n, light/dark), product cards with GTIN owner auto-detection, shift planning | 02 |
| 04 | Label templates | Domain: template model, ZPL/TSPL generation, Cyrillic canvas rasterization + font coverage check; admin: template library + WYSIWYG editor + preview | 03 |
| 05 | Station shell | Tauri 2 app (Windows), device enrollment, offline PIN/badge auth, SQLite mirror via drizzle sqlite-proxy, shift select/ad-hoc create, validation screen + signal system (flash/sound), hardware module (serial scanner, ZPL/TSPL printers, idento-agent-shaped contract) | 04 |
| 06 | Aggregation & sync | SSCC range allocation, box/pallet flow + box-fill UI, exceptions (disassemble/replace/reprint/undo), idempotent batch sync, cross-terminal duplicates & conflict screen, multi-terminal presence | 05 |
| 07 | Exports, history & dashboard | pg-boss jobs, GIS MT / 1C file adapters (per-counterparty), export history, code history page (hot path), live dashboard (SSE) | 06 |
| 08 | Landing & deployment | Astro landing, Caddy + compose bundle, Yandex Cloud deploy, CI/CD releases, Tauri updater channel, Windows installer signing | 03+ (deployable as soon as API/admin exist; final content after 07) |
| 09 | Hardening & lifecycle | Parquet archiving job + lookup, retention & takeout, station shift purge, code-pool KPI, load/perf pass on codes table, RU/EN + theme QA sweep | 07 |

## Global constraints (apply to every plan)

- Versions pinned per `docs/architecture.md` §1 (Node 24, TS 6.0, NestJS 11.1,
  Drizzle 0.45, better-auth 1.6, React 19.2, Vite 8.1, Tauri 2.11, pg-boss 12,
  Astro 7, Zod 4.4; pnpm 11.10 + turbo 2.10). Root `.npmrc` stays as committed
  (npmjs registry, save-exact, engine-strict, minimum-release-age=10080).
- All UI: RU primary + EN, light + dark themes, Markiro design system
  (office/floor modes) from the handoff.
- No CDN assets anywhere; fonts (IBM Plex Sans/Mono, OFL) bundled.
- Multi-tenant: every domain table carries `tenant_id`; `codes` and
  `scan_events` month-partitioned from day one.
- TDD throughout; vitest for TS, cargo test for Rust.
