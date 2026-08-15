# Task 4 implementation report

## Scope

Published the already validated Task 3 legal artifacts on the bilingual landing,
added exact common-document verification routes, and extended build/browser
integrity checks. No generated legal artifact was changed and no external
publication or deployment was performed.

## TDD evidence

- RED: `corepack pnpm --filter @markiro/landing exec vitest run src/lib/legal-artifacts.test.ts test/legal-rendered-page.test.ts src/lib/audit.test.ts`
  exited 1 because `src/lib/legal-artifacts.ts` and the static `/d/...` output did
  not exist. The existing audit tests remained green.
- Focused GREEN: the loader and rendered-route suites passed 27/27, followed by
  the combined Task 4 focused suite at 37/37.
- The new built-site artifact corruption test was also observed RED before the
  audit implementation and then passed GREEN.
- The first browser run found two real harness/expectation gaps: Astro preview
  omitted the DOCX MIME header on macOS and case-insensitive filesystem lookup
  returned 200 for a lowercase code. The production-browser static server now
  serves the exact built route map with explicit MIME types, so the corrected
  focused browser suite passed 7/7 before the full run.
- Review fix round RED added 10 focused failures before production changes:
  symbolic public root/ancestor rejection, exact `/legal/files` equality for an
  extra file/directory/symlink, built-site audit rejection, and literal Data
  Matrix URL assertions. The focused fix suite then passed 51/51.
- Production smoke and edge contracts were extended before the Caddy change.
  The direct adapter exposed the exact generated Caddy representation; after the
  implementation and expectation correction, the real adapter suite passed
  17/17. A second independent review identified and closed stable ancestor-inode
  revalidation and production no-slash smoke coverage gaps.

## Behavior implemented

- Strict build-time artifact manifest loader:
  - exact schema and generator versions;
  - released registry descriptor matching;
  - safe lowercase basename and exact `/legal/files/` href generation;
  - PDF/DOCX media-type rules and template-only DOCX enforcement;
  - missing file, symlink root/ancestor/file, path escape, byte-size, and SHA-256 rejection;
  - `O_NOFOLLOW` handle reads, ordinary-file `fstat`, stable file and ancestor
    `dev`/`ino` revalidation before and after reads, and immutable tree checks;
  - exact ordinary-entry equality between `/legal/files` and manifest filenames,
    rejecting any unlisted file, directory, or symlink;
  - complete active/superseded/withdrawn release-set validation.
- Compact localized artifact controls on each document and registry entry:
  PDF/A-2b, full visible SHA-256, size, copy action, download type, matching
  translation, and the exact bilingual template warning for editable DOCX.
- Real literal Data Matrix SVG with an 11.5 mm symbol, an additional 0.7 mm quiet
  zone on every side, the exact no-trailing-slash verification URL as its payload,
  and an adjacent text link.
- One bilingual static verification page per released code/revision/date, using
  exact uppercase code params, with RU authoritative and EN informational copy.
- Bounded branded `404.html` with `noindex`; malformed and lowercase verification
  URLs neither enumerate codes nor expose filenames/manifest details.
- Production Caddy now serves that bounded branded body with an actual HTTP 404
  for unmatched landing GET/HEAD requests. Reserved namespaces and non-read
  methods retain isolated plain 404 responses.
- Sitemap discovery for the four unambiguous common verification pages; the
  high-level `llms.txt` map remains limited to reading pages.
- Built-site audit now validates manifest bytes/hashes and rejects unlisted linked
  artifacts.
- Browser coverage downloads all 12 artifacts, verifies exact sizes and media
  types, checks exact-case routing and bounded 404 behavior, and exercises every
  route at desktop and Pixel 7 widths without horizontal overflow or console
  errors.

## Verification

- Landing tests: 133/133 passed.
- Review-fix focused tests: 51/51 passed; final focused loader/audit/render rerun
  passed 43/43 after stable ancestor snapshots were added.
- Astro typecheck: 0 errors, 0 warnings, 0 hints.
- Landing ESLint: passed.
- Landing build: 31 pages built, including four exact verification routes and
  branded 404.
- Built-site audit: passed, including current artifact SHA-256 verification.
- Production smoke harness: 78/78 passed, including a direct exact
  `/d/MKR-PD-01/2026.08.01/2026-08-15` request with redirect following disabled,
  status 200, and exact canonical.
- Production Caddy edge contract through the actual `caddy:2.11.4-alpine`
  adapter: 17/17 passed; branded static 404 remains status 404 and does not proxy,
  while reserved/non-HTML denials remain plain.
- Production-browser TypeScript: passed.
- Required root wrapper `corepack pnpm test:landing:browser`: did not reach
  Playwright. pnpm 11.10.0 aborted its dependency-status purge in the non-TTY
  environment with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
- Established direct equivalent
  `tools/production-browser/node_modules/.bin/playwright test --config landing.playwright.config.ts`:
  96/96 passed across Desktop Chrome and Pixel 7.
- Post-self-review all-route overflow/console rerun after making the digest fully
  visible: 60/60 passed across Desktop Chrome and Pixel 7.
- `git diff --check`: passed.
- Prettier check for every touched Prettier-supported file: passed. Astro files
  are not parseable by the repository's installed Prettier configuration, so
  they were verified through `astro check`, build, and browser rendering.

## Visual inspection

Inspected full-page screenshots at 100% for:

- RU registry, Desktop Chrome;
- RU privacy policy and controls, Pixel 7;
- bilingual `MKR-PD-01` verification, Desktop Chrome;
- bilingual `MKR-PD-01` verification, Pixel 7.
- bounded branded 404, Pixel 7.

The compact controls, full hashes, URL wrapping, Data Matrix and its visible
quiet zone, template warning, branded 404, and language hierarchy remain legible
without horizontal overflow. Browser-computed Data Matrix symbol width is between
43 and 44 CSS px (11.5 mm at CSS reference-pixel conversion), with a wider wrapper
for the quiet zone. A redundant self-verification link found in review was removed
from verification pages.

## Limits

- Automated browser checks and visual screenshots do not prove that the Data
  Matrix scans from a physical A4 print; that remains Task 6 external acceptance.
- No Microsoft Word, provider-contract, legal-correctness, live DNS/TLS, or
  production delivery claim is made by this task.
- No deployment, public DNS change, or external publication was performed.
