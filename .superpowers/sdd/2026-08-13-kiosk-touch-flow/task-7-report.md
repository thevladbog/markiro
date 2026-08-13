# Touch flow Task 7 implementation report

## Outcome

The final kiosk flow now has an enforced device floor and verified fixed geometry. Exactly 480×800 and 800×480 are supported; a viewport below both orientation minima replaces the active flow with a bounded diagnostic that states the measured size. Pairing no longer lets the keypad overlap scan/service controls. Low-height outcome screens no longer compress `Готово` below the touch floor.

The browser-only acceptance fixture composes the production post-login screens, tokens and layout with a 100-line mixed cart and deterministic result variants. It does not replace application routing. A committed Playwright gate drives the real `App` from Pairing through durable pairing into branded Login, then uses the fixture only for otherwise non-deterministic post-login visual states. The fixture is served only by Vite from `test/`; the production entry and PWA build remain unchanged.

## TDD and automated verification

- RED: `KioskLayout` had no minimum-size decision or diagnostic; CSS kept the landscape minimum inside the portrait breakpoint; reduced-motion left control transitions active; the low-landscape outcome acknowledgement shrank below 48 px.
- Focused Task 7 after review fixes: 4 files / 56 tests passed.
- Complete kiosk suite: 30 files / 597 tests passed. Existing intentional console/React `act` diagnostics remain noisy; no test failed or skipped.
- TypeScript `--noEmit`, full `src test vite.config.ts` ESLint with zero warnings, Vite PWA production build, changed-file Prettier and `git diff --check` passed.

## Browser acceptance

The real Vite app and its acceptance fixture were inspected in Codex In-app Browser at both exact minima. The same matrix is now encoded in `tools/production-browser/tests/kiosk-touch-flow.spec.ts`; its 19 Chromium scenarios passed:

- Pairing: initial, scan-waiting and server-address states; eight cells, keypad, scanner setup and submit remained in separate bounded regions.
- Login: bundled Markiro fallback plus organization name; portrait centered composition and landscape animation/copy columns.
- Cart: 100 mixed lines, one non-expandable 12-bottle box plus loose DataMatrix lines; exactly 5 portrait / 3 landscape rows, visible pager and CTA.
- Operation, all six writeoff reasons, and 100-line confirmation.
- Accepted, offline queued, rejected and partial outcomes. Refusal details are bounded to two safe concrete reasons plus a count of additional refusals; the panel never becomes a nested scroll region.
- Real integrated route: keyboard-wedge badge `BADGE-1`, SSCC `346006820000000021`, cash operation and server-confirmed `ORD-26-40` via an ephemeral local fixture API.

For every state, `documentElement.scrollHeight === innerHeight` and the active `.kiosk-screen` scroll/client dimensions matched. The automated browser gate also rejects any descendant with scrollable overflow. All measured interactive controls stayed within the viewport and at least 48 px high; the Pairing scan action now uses the shared 64 px floor-sized `Button` contract. Pairing had no intersecting controls. Sampled text contrast was 16.36:1 for primary and 8.16:1 for secondary copy. Browser semantic snapshots exposed headings, status/alert copy, labels and reason radiogroup roles; the visible focus ring measured 2 px.

## Review fixes

Independent Chromium review found three gaps despite the first green DOM gate: an internally scrolling outcome conflict panel, the Pairing scan action computing to 40 px because the shared Button's inline default won over CSS, and no committed reproducible browser runner. RED reproduced the first two in focused tests. The fix bounds refusal copy without hidden scroll, selects `size="floor"` at the component boundary, and adds the standalone Playwright matrix described above. The final browser rerun caught and closed one further 18 px portrait refusal-panel clip without weakening the assertion. The real App Pairing→Login path and every deterministic post-login state now run in Chromium at both exact minima.

## External checks not performed

- [ ] Physical 480×800 portrait device
- [ ] Physical 800×480 landscape device
- [ ] HID scanner with real DataMatrix GS separators
- [ ] GS1-128 SSCC label with AIM `]C1`
- [ ] Web Serial scanner where supported
- [ ] Installed PWA restart and seven-day stale-data gate offline
- [ ] Real company logo through object storage
- [ ] Long-running brightness/burn-in observation

The browser acceptance does not stand in for those hardware and operational checks.
