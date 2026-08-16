# Corrective legal release verification — 16 August 2026

## Decision

The corrected legal release candidate is internally consistent and passed the automated, rendered-document, read-only Word, browser, Caddy, and production-bundle gates available on this macOS host. Two defects discovered during verification were reproduced before implementation and fixed in separate commits:

- `f5bbfbc81` (`fix(landing): serve scripts under production CSP`) forces executable Astro/Vite modules into same-origin files, without weakening the production CSP;
- `5cb226839` (`fix(production): constrain legacy legal redirects`) replaces Caddy's case-insensitive legacy `path` matchers with four anchored, case-sensitive regular expressions.

The release is not evidence of live DNS/TLS, production deployment, Windows Word, physical printing, or phone/industrial-scanner acceptance. No deployment, push, merge, DNS change, shared-database mutation, or artifact regeneration was performed.

## Immutable release evidence

The artifact tree was hashed before verification and again after the corrective browser/routing work. Every byte remained unchanged.

| File                                                 | SHA-256                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `artifacts.json`                                     | `5e7550ed78ce08d35211353fee4e45378cdc88a46f70441b1a98e333ca3cbbae` |
| `markiro_mkr-brd-01_2026.08-01_en.docx`              | `f990edc536900cdcd1fe4bd8d4d27afbd6b9623110cabb088b82b2409dd5d84d` |
| `markiro_mkr-brd-01_2026.08-01_en.pdf`               | `9dd5071057d05caeb52b1bc917a068b32f2ef7789e54ed98221be3ad45f24c70` |
| `markiro_mkr-brd-01_2026.08-01_ru.docx`              | `52a05b3a84414904fa3aae1fca775fba82891723e1007616e19fbd68ab68a6af` |
| `markiro_mkr-brd-01_2026.08-01_ru.pdf`               | `770cfe6a7818439a59473e24b3527ad888d3bd1188828dba94c791fb78c2865b` |
| `markiro_mkr-dpa-01_2026.08-01_en.docx`              | `928f47925e00d3b89a2615e8b30ac7d9bee9ec7b612b636251ed65292e980d5d` |
| `markiro_mkr-dpa-01_2026.08-01_en.pdf`               | `cd6d79b75105d8cdf36520d44187c735817c69c07cd5dcfcf5f864c9e5e3c62c` |
| `markiro_mkr-dpa-01_2026.08-01_ru.docx`              | `a78fc9aad654767dc1c9ab8efa8dec54fcae0b6767854cdaacfd7d96fed27004` |
| `markiro_mkr-dpa-01_2026.08-01_ru.pdf`               | `b0c7ef9072e4c0c01bad13a11431303206ad41c710543a3faccd5da1b0cca372` |
| `markiro_mkr-pd-01_2026.08-01_en.pdf`                | `b6bfaa83440d3b28a71a8e8c3f305fa657045ab76a3a2804637b6efbcd3fa4b6` |
| `markiro_mkr-pd-01_2026.08-01_ru.pdf`                | `aaa71ff551ca1dfca02de1da588890d4965eb4581aaf3ef39af2105066c9d5e3` |
| `markiro_mkr-pd-02_2026.08-01_en.pdf`                | `c372444a0a759b4a064af137bfd8ce03d752331ad85fe74f04e60c1f883cb24b` |
| `markiro_mkr-pd-02_2026.08-01_ru.pdf`                | `98a14ca38244657265be13c601ba6571df8d08896d8f35f8a25f0fc05f6e63dd` |
| `deploy/production/legal-artifacts-attestation.json` | `8cad54d165ad1025419c14afbca5d23c86788bef353428eb0d125b4aa6197e0d` |

The exact artifact package verifier, production attestation verifier, and final production bundle verifier passed:

- `artifacts:verify`: `Verified 12 immutable legal artifacts` with LibreOffice 26.2.5 and pinned veraPDF;
- `verify-legal-artifacts.mjs`: `Verified 12 committed legal artifacts`;
- `test:production-bundle:contract`: 311/311 passed after the final routing change.

No PDF or DOCX artifact-operation marker was rerun.

## Toolchain

- Node.js `v24.18.0`;
- Corepack/pnpm `11.10.0`;
- Poppler `26.07.0`;
- exact LibreOffice `26.2.5.2 cd7284b4cbbfeb507e630c1aac019f4157393acb`;
- Microsoft Word for Mac `16.112` (`16.112.26081010`);
- Caddy `2.11.4-alpine` through an isolated local container;
- Chromium supplied by the isolated production-browser workspace.

## Package and release gates

All final commands below passed unless a limit is explicitly recorded:

- `@markiro/domain`: 17 files and 228/228 tests, typecheck, lint, build;
- `@markiro/legal-documents`: 4 files and 113/113 tests, typecheck, lint, build;
- `@markiro/landing`: 12 files and 134/134 tests, typecheck, lint, 31-page build, built-site audit;
- `@markiro/api`: 151 files passed, 1 skipped; 1,558 tests passed, 2 skipped; typecheck, lint, build;
- focused Caddy/route-table contracts: 98/98;
- final production bundle contracts: 311/311;
- landing browser regression: 100/100 across Desktop Chrome and Pixel 7;
- production-Caddy legal regression: 18/18 across Desktop Chrome and Pixel 7;
- production-browser TypeScript check;
- `corepack pnpm format:check`;
- `git diff --check`.

The API suite used the unique scratch database `markiro_task6_20260816_0323`. Its absence was proved before creation, all 45 migrations were applied, and it was dropped afterward with a final absence count of zero. The shared development database was not modified. The three API skips are the existing local-infrastructure smoke class and were not represented as database coverage.

The branch contained one Task 1 formatting drift in `packages/legal-documents/src/registry.ts`. Prettier changed only the wrapping of a type-only import; the legal 113/113 suite and all legal static gates passed afterward.

## PDF and DOCX visual verification

All 8 PDFs were rendered with Poppler at 144 dpi and every one of their 16 pages was inspected. Page counts were 1/1/2/2/3/3/2/2 for the RU/EN release pairs; every page measured A4 (`595.304 × 841.89 pt`). The inspection found no clipping, overlap, unintended wrap, or furniture collision. Headers and footers are compact, revision identity is `2026.08/01`, Russian dates use `DD.MM.YYYY`, URLs appear in metadata rather than footers, definition separators are em dashes, and every Data Matrix has its quiet zone.

All 4 DOCX templates were converted read-only with the exact LibreOffice binary and all 6 A4 pages inspected. They were also opened in Microsoft Word for Mac with `read only=true` and exported to temporary PDFs; all 6 exported pages were inspected. A cold first Word export of the English letterhead briefly showed a monospaced-glyph overlap; reopening after Word initialized produced a clean export and the issue did not recur. This is not Windows Word evidence.

The bundled `render_docx.py` wrapper did not honor the supplied exact-binary path and started bundled LibreOffice Dev 26.8 alpha. Its output was not accepted as the release check; direct invocation of the exact 26.2.5 binary supplied the recorded evidence.

## Data Matrix verification

Literal payloads were checked against the shared four verification URLs. An independent macOS Vision decode of real rendered pixels succeeded for the first page of all 8 PDFs and the first page of all 4 exact-LibreOffice DOCX renders, returning the exact corrected URL in every case.

The repository's lightweight ASCII helper decoded PD-01 and PD-02 but stopped on the larger DPA symbol at unsupported codeword 242. Because the independent image decoder accepted that symbol and the payload was exact, this is a bounded helper capability limit rather than an artifact defect; the helper and artifact bytes were not changed.

Physical phone, handheld/industrial scanner, and printed-page decoding were not run.

## Browser and Caddy verification

The 100-case landing suite covered every RU/EN legal page, both registries, all four verification pages, downloads, canonical/hreflang metadata, responsive alignment, and bounded malformed verification pages at Desktop Chrome and Pixel 7.

The additional real-Caddy suite used the production Caddyfile and a case-sensitive Docker volume containing the built landing. On both viewports it proved:

- the production CSP is present on `/legal/` and the corrected PD-01 verification page;
- copy controls execute and enter the localized copied state;
- there are zero console, page, or CSP errors;
- exactly four old identity URLs return 308 to their corrected URL;
- truncated, lowercase, adjacent-code, extra-segment, and invalid-date paths return the branded bounded 404.

### Defect 1: CSP-blocked controls

RED: 4/4 real-Caddy tests failed because the first copy button remained `Копировать`; Chromium reported that the inline module violated `script-src 'self'`.

Root cause: Astro/Vite inlined the small `LegalArtifactControls` module while Caddy intentionally rejected inline executable scripts.

GREEN: `assetsInlineLimit: 0` forces executable build modules into fingerprinted same-origin assets. The CSP itself is unchanged and contains neither `unsafe-inline` nor a broad hash/nonce exception. Final result: 4/4 focused CSP/control tests and then 18/18 combined Caddy tests passed.

### Defect 2: case-insensitive legacy redirects

RED: after moving the landing build from a macOS bind mount to a case-sensitive Docker volume, real Caddy still returned 308 for lowercase legacy document codes. Direct HEAD confirmed the redirect. Caddy's ordinary `path` matcher is case-insensitive, while the adapted-config test helper had incorrectly modeled it as case-sensitive.

GREEN: only the four legacy matchers now use anchored, escaped, case-sensitive `path_regexp` expressions. The test helper models ordinary Caddy paths case-insensitively and regular expressions according to their actual flags. Final results: 18/18 real-Caddy tests, 98/98 focused edge/smoke contracts, and 311/311 production bundle contracts.

## Wrapper and infrastructure limits

- The canonical `corepack pnpm test:landing:browser` wrapper stopped before Playwright because its nested invocation selected pnpm 11.18.0 while the repository requires 11.10.0. The established direct workspace binary ran the exact 100 tests and passed.
- An initial production-bundle attempt inside the filesystem sandbox produced only Docker-socket, loopback-listen, and pnpm SQLite `EPERM` failures. The same exact 311-test command outside the sandbox passed 311/311 after final code.
- The first local Caddy bind mount inherited macOS case-insensitive lookup and could not prove lowercase 404 behavior. The accepted final run copied `dist` into an isolated Docker volume, establishing Linux-style case-sensitive lookup.
- No live production host, DNS, ACME certificate, SMTP/demo delivery, analytics, CRM, or search-index state was exercised.

## External checks still required

Before calling the public deployment externally accepted, perform or explicitly waive:

- Windows desktop Word open/print of all four DOCX templates;
- physical A4 print inspection;
- phone and target industrial-scanner Data Matrix scans from PDFs, DOCX prints, and downloaded public files;
- live DNS, TLS certificate, all three production authorities, redirects, CSP, artifact downloads/hashes, form delivery, and monitoring after deployment.

Independent controller/code review remains the next workflow gate; it should focus on release-identity agreement, route confinement, artifact immutability, CSP behavior, responsive layout, and absence of accidental legal-semantic changes.
