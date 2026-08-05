# Bilingual Product-Led README Design

**Date:** 2026-08-05

**Status:** Approved design; awaiting written-spec review

**Scope:** Repository README, README-specific visual assets, and proprietary license

## Goal

Replace the stale engineering-only root README with a bilingual, product-led
technical entry point for Markiro. The result must help a prospective customer
or partner understand the product before giving developers an accurate path to
the architecture, local setup, and verification commands.

The README must describe the current `main` branch rather than future roadmap
promises. It must preserve the established Markiro visual direction and must not
present design handoff screens as proof of a production deployment.

## Audience and language model

The README serves a hybrid audience:

1. owners, production managers, partners, and technical buyers evaluating the
   product;
2. developers and operators evaluating or running the repository.

`README.md` is the canonical English version. `README.ru.md` is a complete
Russian mirror with the same section order, links, commands, and visual assets.
Both files place an `English | Русский` switch directly below the logo. English
is canonical for repository discovery; Russian remains the product's primary
market language.

## Product positioning

Markiro is presented as an industrial platform for Честный знак production
workflows: serialization, code validation, aggregation, label printing,
traceability, offline line work, pickup kiosks, and integrations. Copy is plain,
specific, and operational. It avoids generic digital-transformation language
and emphasizes outcomes such as keeping a line running, detecting duplicates,
recovering offline, and retaining an auditable production history.

The README must distinguish implemented capabilities from roadmap material. In
particular, the current station application is documented as present; the stale
claim that station arrives in a later plan is removed.

## Information architecture

Each language file uses the same sequence:

1. **Brand header** — theme-aware logo, language switch, one-sentence value
   proposition, and compact badge row.
2. **Hero visual** — a wide line-station design preview focused on floor work
   and aggregation.
3. **What Markiro is** — short product definition and intended production
   context.
4. **Why it exists** — line continuity, offline behavior, duplicate control,
   local recovery, and auditability.
5. **Product surfaces** — admin, line station, and pickup kiosk with concise
   localized captions.
6. **Core capabilities** — offline-first workflows, GS1/Честный знак domain
   logic, aggregation and SSCC, ZPL/TSPL labels, multi-tenant boundaries, and
   1C/CommerceML integration.
7. **Architecture** — a compact Mermaid flow showing applications, shared
   packages, the API, PostgreSQL, and station-local SQLite.
8. **Quick start** — prerequisites, guarded environment initialization, Compose,
   migrations, API, and admin startup.
9. **Development** — repository map, focused commands, full validation gate,
   and database-backed test caveats.
10. **Documentation** — links to architecture, design briefs, OpenAPI, roadmap,
    and `AGENTS.md`.
11. **License** — proprietary notice and a link to `LICENSE`.

Detailed operational narratives currently embedded in `README.md`, including
tenant-owner provisioning and label-editor behavior, are shortened to concise
summaries or links. The root README remains an entry point, not an operator
manual or exhaustive API reference.

## Brand header and badges

The accepted Markiro/«Прибор» identity from the design handoff is reused without
redesign. Local light and dark SVG variants are copied into
`docs/assets/readme/` and rendered through a `<picture>` element with
`prefers-color-scheme` sources.

The badge row includes:

- real GitHub Actions badges for `CI` and `CodeQL` on `main`;
- static version/technology badges for Node 24+, pnpm 11.10, TypeScript, Docker,
  PostgreSQL, and Tauri;
- a `License: Proprietary` badge.

Badges remain on one compact row where viewport width permits. No coverage,
release, package-version, or license badge is added unless the repository has a
real source for the claim.

## Interface imagery

Three images are rendered from the existing high-fidelity HTML design handoff:

- `line-station.dc.html` — wide hero image;
- `admin-panel.dc.html` — product-surface gallery image;
- `pickup-kiosk.dc.html` — product-surface gallery image.

The handoff is reference material, not production code. Images use the Russian
prototype content in both language versions; captions are localized. The README
labels the gallery as product design previews so it does not imply a verified
live deployment.

The station image spans the content width. Admin and kiosk images appear below
it in a two-column HTML table that degrades to readable images on GitHub. Output
assets are stored under `docs/assets/readme/` as optimized WebP files around
1440–1600 pixels wide. They are checked visually for clipping, unreadable text,
blank states, missing fonts, and accidental browser chrome.

No new AI-generated UI, stock factory photography, or external image CDN is in
scope. If a handoff prototype cannot render reliably, the implementation fixes
only the capture prerequisites or omits that image; it does not fabricate a
replacement screen.

## Architecture visual

The Mermaid diagram is intentionally small. It communicates these boundaries:

- admin and kiosk web clients call the NestJS API;
- the Tauri station combines a React UI with a local SQLite journal and syncs
  with the API when connectivity is available;
- the API persists tenant data in PostgreSQL;
- applications consume shared domain, database, UI, and email packages where
  applicable.

The diagram is explanatory rather than exhaustive. It does not model every job,
integration, object-storage flow, or deployment component.

## Quick-start contract

The quick start follows the root `AGENTS.md` safety rules and current manifests:

```bash
corepack enable
pnpm install --frozen-lockfile
if [ ! -e .env ]; then
  cp .env.example .env
fi
docker compose -f docker-compose.dev.yml up -d
set -a
source .env
set +a
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/api dev
```

Admin startup remains a separate command. Mailpit and MinIO endpoints are kept
as a concise development note. The text must not suggest overwriting an existing
`.env`, placing secrets on a command line, or using development credentials in
production.

## Proprietary license

Add a root `LICENSE` file for:

```text
Copyright © 2026 Vladislav Bogatyrev
All rights reserved.
```

The license grants no permission to use, copy, modify, publish, distribute,
sublicense, or sell the software without prior written permission from the
copyright holder. It does not call publicly visible source code confidential.
The README identifies the repository as proprietary and links to the complete
notice. The wording is a practical repository notice, not a substitute for
jurisdiction-specific legal review.

## Files

Expected additions and changes:

- modify `README.md` — canonical English README;
- add `README.ru.md` — Russian mirror;
- add `LICENSE` — proprietary All Rights Reserved notice;
- add `docs/assets/readme/logo.svg` and `logo-dark.svg`;
- add `docs/assets/readme/station.webp`;
- add `docs/assets/readme/admin.webp`;
- add `docs/assets/readme/kiosk.webp`.

Existing handoff files remain unchanged unless a narrowly scoped capture defect
must be fixed and separately justified.

## Validation

Implementation validation must include:

1. confirm every local link and image target in both README files exists;
2. compare heading order, commands, URLs, badges, and image references across
   both languages;
3. verify CI and CodeQL badge workflow paths against `.github/workflows/`;
4. verify Node and pnpm versions against `package.json`;
5. verify Quick Start commands against `.env.example`, package scripts, and
   `docker-compose.dev.yml`;
6. render and visually inspect both logo variants and all three screenshots;
7. confirm each screenshot came from its named handoff prototype and includes no
   browser chrome or local path disclosure;
8. run Prettier on supported Markdown files and `git diff --check` on the full
   change;
9. inspect staged scope explicitly so unrelated user changes remain uncommitted;
10. report visual capture limitations and external badge/network checks
    separately from local automated checks.

Product code tests are not required solely for README prose and static assets.
If implementation changes a handoff script or any executable project file,
focused checks for that file become required.

## Non-goals

- redesigning the Markiro brand or logo;
- implementing the landing page;
- generating fictional production screenshots;
- translating the UI itself;
- changing product behavior, deployment, CI, or dependency policy;
- writing exhaustive operator, API, or installation manuals;
- choosing a jurisdiction-specific commercial software agreement.
