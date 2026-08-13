# Touch flow Task 7 implementation report

## Outcome

The final kiosk flow now has an enforced device floor and verified fixed geometry. Exactly 480×800 and 800×480 are supported; a viewport below both orientation minima replaces the active flow with a bounded diagnostic that states the measured size. Pairing no longer lets the keypad overlap scan/service controls. Low-height outcome screens no longer compress `Готово` below the touch floor.

The browser-only acceptance fixture composes the same production screens, tokens, reducers and layout with a 100-line mixed cart and deterministic result variants. It is served only by Vite from `test/`; the production entry and PWA build remain unchanged.

## TDD and automated verification

- RED: `KioskLayout` had no minimum-size decision or diagnostic; CSS kept the landscape minimum inside the portrait breakpoint; reduced-motion left control transitions active; the low-landscape outcome acknowledgement shrank below 48 px.
- Focused Task 7: 3 files / 11 tests passed.
- Complete kiosk suite: 30 files / 595 tests passed. Existing intentional console/React `act` diagnostics remain noisy; no test failed or skipped.
- TypeScript `--noEmit`, full `src test vite.config.ts` ESLint with zero warnings, Vite PWA production build, changed-file Prettier and `git diff --check` passed.

## Browser acceptance

The real Vite app and its acceptance fixture were inspected in Codex In-app Browser at both exact minima:

- Pairing: initial, scan-waiting and server-address states; eight cells, keypad, scanner setup and submit remained in separate bounded regions.
- Login: bundled Markiro fallback plus organization name; portrait centered composition and landscape animation/copy columns.
- Cart: 100 mixed lines, one non-expandable 12-bottle box plus loose DataMatrix lines; exactly 5 portrait / 3 landscape rows, visible pager and CTA.
- Operation, all six writeoff reasons, and 100-line confirmation.
- Accepted, offline queued, rejected and partial outcomes.
- Real integrated route: keyboard-wedge badge `BADGE-1`, SSCC `346006820000000021`, cash operation and server-confirmed `ORD-26-40` via an ephemeral local fixture API.

For every state, `documentElement.scrollHeight === innerHeight` and the active `.kiosk-screen` scroll/client dimensions matched. All measured interactive controls stayed within the viewport and at least 48 px high. Pairing had no intersecting controls. Sampled text contrast was 16.36:1 for primary and 8.16:1 for secondary copy. Browser semantic snapshots exposed headings, status/alert copy, labels and reason radiogroup roles; the visible focus ring measured 2 px.

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
