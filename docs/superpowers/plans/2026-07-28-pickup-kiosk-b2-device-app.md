# Pickup Kiosk Plan B-2 — the device app (`apps/kiosk`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/kiosk` — the touch-screen self-service kiosk a warehouse worker uses to scan their badge and the Chestny ZNAK codes of the product they are taking — working offline, on top of the device contracts frozen by Plan B-1.

**Architecture:** A React 19 + Vite 8 PWA (no Tauri: the requirement is "every platform including Android tablets", and serial access is desktop-Chromium-only). Modules with one responsibility each, mirroring `apps/station`'s discipline: a pure screen state machine (`nextKioskView`) that is unit-testable without rendering, a pluggable `ScanSource` seam (keyboard wedge everywhere, Web Serial where available), an IndexedDB store whose snapshot writes are atomic, and a sync worker that drains a `deviceSeq`-ordered queue. Credentials never arrive in plaintext — the device verifies a scanned badge with one PBKDF2 derivation against `badgeSalt` and a digest map.

**Tech Stack:** TypeScript 6, React 19.2, Vite 8.1, Vitest 4.1 + jsdom + Testing Library, `@markiro/domain` (scan guard + PHC verifier + barcodes), `@markiro/ui` (dark/floor theme), i18next, IndexedDB (`fake-indexeddb` in tests), `vite-plugin-pwa`.

## Global Constraints

- **Versions pinned** per `docs/architecture.md` §1 (Node 24, TS 6.0, React 19.2, Vite 8.1, Vitest 4.1, Zod 4.4; pnpm 11.10 + turbo 2.10). Root `.npmrc` stays as committed: **`save-exact`** — every dependency is pinned to an EXACT version, no `^`/`~` — plus `minimum-release-age=10080`, so any new package must be ≥7 days old.
- **`@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` must be listed as DIRECT dependencies of `apps/kiosk` at `5.3.0`.** `@markiro/ui`'s `./styles.css` export points at unbuilt source, so its transitive `@import "@fontsource/…"` resolves from the _consuming app's_ `node_modules`. Both `apps/admin` and `apps/station` list them for exactly this reason. Omitting them breaks the build.
- **No CDN assets anywhere**; fonts are bundled through those packages.
- **RU primary + EN**, `ru.json`/`en.json` strictly key-parallel — in test mode a missing key **throws**, so every string must exist in both.
- **Dark/floor theme**: `data-theme="dark"` on `<html>` (prevents a light flash before React mounts) _and_ `<ThemeProvider defaultTheme="dark">`.
- **Touch targets ≥44 px**, primary actions 56–84 px; hover is never load-bearing.
- **Relative imports carry the `.js` suffix** (repo-wide convention, even under `moduleResolution: "bundler"`).
- **`exactOptionalPropertyTypes: true`** and `noUncheckedIndexedAccess: true` — never assign `undefined` to an optional; build objects with conditional spread.
- **Credentials are PBKDF2 verifiers, never plaintext.** The device holds `badgeHash`/`pinHash` only. Badge lookup costs ONE derivation (`deriveDigestB64(scan, badgeSalt, PHC_ITERATIONS)`) plus a map lookup — never `verifyPhc` in a loop over the roster.
- **The server is authoritative.** The device's day-limit and dedup checks are best-effort UX; `POST /kiosk/orders` decides, and its `conflicts[]` are the truth.
- **CI gate** is `pnpm turbo lint typecheck test build` **plus** `pnpm format:check`. Format only files you touch: `pnpm exec prettier --write <paths>` — never `prettier --write .`, which descends into sibling git worktrees and dirties другой session's work.
- Test filtering: `pnpm --filter @markiro/kiosk exec vitest run <name>` (`test -- <name>` does NOT filter in this repo).

## Frozen contracts (Plan B-1, merged — do not change these)

From `apps/api/src/modules/pickup-orders/dto.ts`. They are **not** in a shared package; copy the shapes into the kiosk with a comment naming the source file, exactly as `apps/admin/src/pages/kiosks/api.ts` does.

```ts
// POST /kiosk/pair — unauthenticated; the device has no credential until it succeeds.
// Body: { code: string /* /^\d{8}$/ */ }
interface PairKioskResultDto {
  device: { kioskId: string; kioskName: string; place: string | null };
  token: string; // the x-kiosk-token for every later call
  nextDeviceSeq: number; // MAX(deviceSeq)+1 — reinstall collision guard
  bootstrap: KioskBootstrapDto;
}

// GET /kiosk/bootstrap — the offline dataset. Also the heartbeat: any
// authenticated call bumps kiosks.last_seen_at, so there is no separate one.
interface KioskBootstrapDto {
  generatedAt: string; // ISO 8601, SERVER time — the staleness gates depend on it
  config: { dayLimitPerEmployee: number; showPrices: boolean };
  badgeSalt: string; // base64; shared by every badgeHash below
  reasons: { id: string; name: string }[];
  products: {
    id: string;
    gtin14: string;
    name: string;
    unitPrice: string | null;
    egaisCode: string | null;
  }[];
  employees: { id: string; fullName: string; role: string | null; badgeHash: string | null }[];
  operators: {
    employeeId: string;
    name: string;
    login: string;
    role: string;
    pinHash: string;
    badgeHash: string | null;
    active: boolean;
  }[];
}

// POST /kiosk/orders
interface CreateOrderDto {
  deviceSeq: number; // idempotency key with (tenantId, kioskId)
  badgeCode: string; // the badge just presented — a transient credential, not stored
  reason: "buy" | "writeoff";
  writeoffReasonId?: string | null;
  items: { rawKm: string }[];
  createdAt?: string; // ISO — scan time, NOT sync time
}
interface CreateOrderResultDto {
  orderNo: string;
  status: "pending";
  itemCount: number;
  conflicts: OrderConflict[];
}
interface OrderConflict {
  rawKm: string;
  reason: "not_km" | "incomplete" | "unknown_product" | "not_allowed" | "duplicate" | "over_limit";
}
```

## Environment

No database and no API server are needed: every test runs in jsdom with `fetch` stubbed and `fake-indexeddb`. For manual smoke testing, `pnpm --filter @markiro/api dev` plus the Vite proxy.

## File Structure

```
apps/kiosk/
  package.json  vite.config.ts  tsconfig.json  vitest.config.ts  index.html
  public/                     icon-192.png icon-512.png icon-maskable-512.png
  src/
    main.tsx                  App.tsx            # App.tsx holds nextKioskView (pure)
    i18n/{index.ts,ru.json,en.json}
    api/{types.ts,client.ts}                     # frozen DTOs + device client (+ pair)
    store/{db.ts,cache.ts,queue.ts,journal.ts,config.ts}
    scanner/{source.ts,keyboard.ts,web-serial.ts}
    domain-guard/classify.ts                     # thin adapter over @markiro/domain
    credentials/{badge.ts,operator.ts}
    sync/worker.ts
    session/cart.ts                              # pure cart reducer
    ui/{KioskShell.tsx,StatusStrip.tsx}
    screens/{Pairing.tsx,ScannerSetup.tsx,Idle.tsx,Cart.tsx,Done.tsx,Blocked.tsx}
  test/setup.ts + one test file per module above
packages/ui/src/components/{PinPad.tsx,SignalOverlay.tsx}   # lifted from station
```

---

### Task 1: App scaffold, i18n, and the screen state machine

**Files:**

- Create: `apps/kiosk/{package.json,vite.config.ts,tsconfig.json,vitest.config.ts,index.html}`
- Create: `apps/kiosk/src/{main.tsx,App.tsx}`, `apps/kiosk/src/i18n/{index.ts,ru.json,en.json}`
- Create: `apps/kiosk/test/{setup.ts,i18n.test.tsx,app-view.test.ts}`

**Interfaces:**

- Consumes: nothing.
- Produces — every later task builds on these:

  ```ts
  export type KioskView =
    "loading" | "pairing" | "scanner-setup" | "blocked" | "idle" | "cart" | "done";
  export interface KioskViewInput {
    paired: boolean; // a device token exists in the local config
    cacheStale: boolean; // snapshot older than the block threshold
    scannerSetupRequested: boolean;
    employeeId: string | null; // set once a badge is recognised
    submitted: boolean; // the order was handed over; the Done screen is showing
    configLoaded: boolean;
  }
  export function nextKioskView(input: KioskViewInput): KioskView;
  ```

- [ ] **Step 1: Write the failing state-machine test** — `apps/kiosk/test/app-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextKioskView, type KioskViewInput } from "../src/App.js";

const base: KioskViewInput = {
  paired: true,
  cacheStale: false,
  scannerSetupRequested: false,
  employeeId: null,
  submitted: false,
  configLoaded: true,
};

describe("nextKioskView", () => {
  it("waits while the local config has not been read yet", () => {
    expect(nextKioskView({ ...base, configLoaded: false })).toBe("loading");
  });

  it("demands pairing before anything else when the device has no token", () => {
    expect(nextKioskView({ ...base, paired: false })).toBe("pairing");
  });

  it("lets scanner setup be reached from the pairing screen — the scanner is often needed to scan the pairing code itself", () => {
    expect(nextKioskView({ ...base, paired: false, scannerSetupRequested: true })).toBe(
      "scanner-setup",
    );
  });

  it("blocks work when the cached dataset is too old to trust", () => {
    expect(nextKioskView({ ...base, cacheStale: true })).toBe("blocked");
  });

  it("waits for a badge when idle", () => {
    expect(nextKioskView(base)).toBe("idle");
  });

  it("shows the cart once an employee is recognised", () => {
    expect(nextKioskView({ ...base, employeeId: "e1" })).toBe("cart");
  });

  it("shows the handover confirmation after submitting", () => {
    expect(nextKioskView({ ...base, employeeId: "e1", submitted: true })).toBe("done");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @markiro/kiosk exec vitest run app-view`
Expected: FAIL — the package does not exist yet.

- [ ] **Step 3: Create `apps/kiosk/package.json`**

```json
{
  "name": "@markiro/kiosk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource/ibm-plex-sans": "5.3.0",
    "@markiro/domain": "workspace:*",
    "@markiro/ui": "workspace:*",
    "i18next": "26.3.6",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "react-i18next": "17.0.10",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@testing-library/react": "16.3.2",
    "@types/node": "26.1.1",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.3",
    "jsdom": "29.1.1",
    "typescript": "6.0.3",
    "vite": "8.1.3",
    "vitest": "4.1.10"
  }
}
```

`fake-indexeddb` and `vite-plugin-pwa` are added by Tasks 4 and 15 respectively, with `pnpm --filter @markiro/kiosk add -D <pkg>` so `save-exact` pins them. Deliberately absent: `@markiro/db` (its runtime pulls drizzle/pg/better-auth; the kiosk needs none), `@tanstack/react-query` (there is no server cache to manage — the local snapshot is the source of truth), `react-router` (the pure state machine replaces routing).

- [ ] **Step 4: Create the config files**

`apps/kiosk/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5373, // admin is 5173, station 5273
    strictPort: true,
    proxy: {
      // Nest controllers are root-mounted with no global prefix
      // (@Controller("kiosk") -> /kiosk), so strip the /api prefix the client
      // uses. The kiosk has no Better Auth routes, so one catch-all suffices.
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: { target: "es2023", outDir: "dist" },
});
```

`apps/kiosk/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "vitest/globals"],
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

`apps/kiosk/vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
  },
});
```

`apps/kiosk/index.html`:

```html
<!doctype html>
<html lang="ru" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Маркиро — Киоск</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/kiosk/test/setup.ts`:

```ts
// Initializes the i18next singleton (RU resources; a missing key throws in
// test mode) before any test renders a component that calls useTranslation.
import "../src/i18n/index.js";
```

- [ ] **Step 5: Create the i18n singleton** — `apps/kiosk/src/i18n/index.ts`, copied from `apps/station/src/i18n/index.ts` verbatim except the doc wording:

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import ru from "./ru.json";

export const SUPPORTED_LANGUAGES = ["ru", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const isTestEnv = import.meta.env.MODE === "test";

// A missing dictionary key must fail tests loudly rather than silently render
// the raw key. Spread conditionally because i18next's `missingKeyHandler`
// option type does not include `undefined` and this repo's
// `exactOptionalPropertyTypes` rejects assigning `undefined` to it.
const missingKeyOptions = isTestEnv
  ? {
      saveMissing: true,
      missingKeyHandler: (languages: readonly string[], namespace: string, key: string) => {
        throw new Error(`Missing i18n key: ${namespace}:${key} (${languages.join(", ")})`);
      },
    }
  : {};

void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru }, en: { translation: en } },
  lng: "ru",
  fallbackLng: "ru",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  ...missingKeyOptions,
});

export default i18n;
```

Seed `ru.json` with the strings this task needs and `en.json` with the same keys:

```json
{
  "app": { "title": "Маркиро — Киоск", "booting": "Загрузка киоска…" }
}
```

EN: `{ "app": { "title": "Markiro — Kiosk", "booting": "Starting the kiosk…" } }`.

- [ ] **Step 6: Copy the i18n lockstep test** — `apps/kiosk/test/i18n.test.tsx`, verbatim from `apps/station/test/i18n.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";

function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object"
      ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe("i18n lockstep", () => {
  it("RU and EN have identical key sets", () => {
    expect(flatKeys(ru).sort()).toEqual(flatKeys(en).sort());
  });
});
```

- [ ] **Step 7: Implement `apps/kiosk/src/App.tsx`** — the pure function plus a placeholder render:

```tsx
import { useTranslation } from "react-i18next";

export type KioskView =
  "loading" | "pairing" | "scanner-setup" | "blocked" | "idle" | "cart" | "done";

export interface KioskViewInput {
  paired: boolean;
  cacheStale: boolean;
  scannerSetupRequested: boolean;
  employeeId: string | null;
  submitted: boolean;
  configLoaded: boolean;
}

/**
 * The whole screen-routing decision, extracted so it can be tested without a
 * DOM, IndexedDB or a scanner — the same discipline `nextStationView` follows
 * in apps/station. Ordering is deliberate: scanner setup outranks pairing
 * because the scanner is often what reads the pairing code, and the staleness
 * block outranks work but NOT pairing (a device that cannot pair cannot
 * refresh, so blocking it first would be a dead end).
 */
export function nextKioskView(input: KioskViewInput): KioskView {
  if (!input.configLoaded) return "loading";
  if (input.scannerSetupRequested) return "scanner-setup";
  if (!input.paired) return "pairing";
  if (input.cacheStale) return "blocked";
  if (!input.employeeId) return "idle";
  return input.submitted ? "done" : "cart";
}

export function App(): React.JSX.Element {
  const { t } = useTranslation();
  return <main>{t("app.booting")}</main>;
}
```

- [ ] **Step 8: Implement `apps/kiosk/src/main.tsx`**

```tsx
import "@markiro/ui/styles.css";
import "./i18n/index.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@markiro/ui";

import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
```

- [ ] **Step 9: Install and run**

```bash
pnpm install
pnpm --filter @markiro/kiosk exec vitest run
pnpm --filter @markiro/kiosk typecheck
pnpm --filter @markiro/kiosk lint
pnpm --filter @markiro/kiosk build
```

Expected: all 8 tests pass (7 state-machine + 1 lockstep); typecheck, lint and build clean. A build failure mentioning `@fontsource/…` means the two font packages are missing from `dependencies` — see Global Constraints.

- [ ] **Step 10: Commit**

```bash
git add apps/kiosk pnpm-lock.yaml
git commit -m "feat(kiosk): app scaffold, i18n and the screen state machine"
```

---

### Task 2: Lift `PinPad` and `SignalOverlay` into `packages/ui`

**Files:**

- Create: `packages/ui/src/components/{PinPad.tsx,SignalOverlay.tsx}`
- Modify: `packages/ui/src/components/index.ts`
- Delete: `apps/station/src/ui/{PinPad.tsx,SignalOverlay.tsx}`
- Modify: the station files importing them (find with `grep -rn "PinPad\|SignalOverlay" apps/station/src`)
- Test: `packages/ui/test/pin-pad.test.tsx`

**Interfaces:**

- Produces, exported from `@markiro/ui`:
  ```ts
  export function PinPad(props: {
    value: string;
    onChange: (next: string) => void;
    maxLength?: number;
  }): JSX.Element;
  export function SignalOverlay(props: {
    tone: "ok" | "error" | "duplicate";
    title: string;
    detail?: string;
  }): JSX.Element;
  ```
  `maxLength` is new: the kiosk's pairing code is exactly 8 digits, and the station's version appends without bound.

Do this now rather than later — deferring it means touching `apps/station` again after the kiosk already depends on a copy.

- [ ] **Step 1: Write the failing test** — `packages/ui/test/pin-pad.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinPad } from "../src/components/PinPad.js";

afterEach(cleanup);

describe("PinPad", () => {
  it("appends the pressed digit", () => {
    const onChange = vi.fn();
    render(<PinPad value="12" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(onChange).toHaveBeenCalledWith("123");
  });

  it("refuses to grow past maxLength — the pairing code is exactly eight digits", () => {
    const onChange = vi.fn();
    render(<PinPad value="12345678" onChange={onChange} maxLength={8} />);
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is unbounded when maxLength is omitted, as the station's PIN entry expects", () => {
    const onChange = vi.fn();
    render(<PinPad value="123456789012" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "0" }));
    expect(onChange).toHaveBeenCalledWith("1234567890120");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @markiro/ui exec vitest run pin-pad`
Expected: FAIL — module not found.

- [ ] **Step 3: Move both components** — copy `apps/station/src/ui/PinPad.tsx` and `SignalOverlay.tsx` into `packages/ui/src/components/`, then in `PinPad.tsx` add the optional bound:

```tsx
export interface PinPadProps {
  value: string;
  onChange: (next: string) => void;
  /** Caps the entry length; omitted means unbounded (the station's PIN entry). */
  maxLength?: number;
}
```

and guard the append:

```tsx
const press = (digit: string) => {
  if (props.maxLength !== undefined && props.value.length >= props.maxLength) return;
  props.onChange(props.value + digit);
};
```

Neither component may import from `apps/*`; `SignalOverlay` already has zero imports and `PinPad` only needs `Button` from this package.

- [ ] **Step 4: Export them** — append to `packages/ui/src/components/index.ts`, matching the file's existing value-then-type pairing:

```ts
export { PinPad } from "./PinPad.js";
export type { PinPadProps } from "./PinPad.js";
export { SignalOverlay } from "./SignalOverlay.js";
export type { SignalOverlayProps } from "./SignalOverlay.js";
```

- [ ] **Step 5: Repoint the station** — delete `apps/station/src/ui/{PinPad,SignalOverlay}.tsx` and change their importers to `from "@markiro/ui"`. Find every one:

```bash
grep -rn "ui/PinPad\|ui/SignalOverlay" apps/station/src apps/station/test
```

- [ ] **Step 6: Run everything that could be affected**

```bash
pnpm --filter @markiro/ui exec vitest run
pnpm --filter @markiro/station exec vitest run
pnpm --filter @markiro/ui typecheck && pnpm --filter @markiro/station typecheck
```

Expected: all green. The station's existing PinPad/SignalOverlay tests must pass unchanged — if one fails, the lift changed behaviour and that is a bug, not a test to edit.

- [ ] **Step 7: Format and commit**

```bash
pnpm exec prettier --write packages/ui/src packages/ui/test/pin-pad.test.tsx apps/station/src
git add packages/ui apps/station
git commit -m "refactor(ui): lift PinPad and SignalOverlay out of the station"
```

---

### Task 3: Device API client

**Files:**

- Create: `apps/kiosk/src/api/{types.ts,client.ts}`
- Test: `apps/kiosk/test/api-client.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export class KioskApiError extends Error {
    readonly status: number;
  }
  /** Unauthenticated — the device has no credential until this resolves. */
  export function pairKiosk(serverUrl: string, code: string): Promise<PairKioskResultDto>;
  export interface KioskClient {
    bootstrap(): Promise<KioskBootstrapDto>;
    submitOrder(body: CreateOrderDto): Promise<CreateOrderResultDto>;
  }
  export function createKioskClient(cfg: { token: string; serverUrl: string }): KioskClient;
  ```

  `types.ts` holds the frozen DTOs copied verbatim from the plan header, each with a comment naming `apps/api/src/modules/pickup-orders/dto.ts` as the source of truth.

- [ ] **Step 1: Write the failing test** — `apps/kiosk/test/api-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKioskClient, KioskApiError, pairKiosk } from "../src/api/client.js";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("pairKiosk", () => {
  it("posts the code without any credential header", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { token: "t", nextDeviceSeq: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await pairKiosk("http://srv/", "12345678");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://srv/kiosk/pair"); // trailing slash stripped
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ code: "12345678" });
    expect((init as RequestInit).headers).not.toHaveProperty("x-kiosk-token");
  });

  it("surfaces the server's message on rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })),
    );
    await expect(pairKiosk("http://srv", "00000000")).rejects.toBeInstanceOf(KioskApiError);
  });
});

describe("createKioskClient", () => {
  it("sends the device token on every authenticated call", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { generatedAt: "2026-07-28T00:00:00Z" }));
    vi.stubGlobal("fetch", fetchMock);

    await createKioskClient({ token: "tok", serverUrl: "http://srv" }).bootstrap();

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "x-kiosk-token": "tok" });
  });

  it("carries the scan time so a late sync is not recorded as happening now", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, { orderNo: "ORD-26-0001", conflicts: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createKioskClient({ token: "tok", serverUrl: "http://srv" }).submitOrder({
      deviceSeq: 3,
      badgeCode: "B-1",
      reason: "buy",
      items: [{ rawKm: "01..." }],
      createdAt: "2026-07-28T06:00:00.000Z",
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ deviceSeq: 3, createdAt: "2026-07-28T06:00:00.000Z" });
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `pnpm --filter @markiro/kiosk exec vitest run api-client` → FAIL, module not found.

- [ ] **Step 3: Implement `apps/kiosk/src/api/types.ts`** — the DTOs from this plan's "Frozen contracts" section, with this header:

```ts
/**
 * Hand-mirrored from apps/api/src/modules/pickup-orders/dto.ts. These types
 * are not published in a shared package, so they are duplicated here the same
 * way apps/admin duplicates its own slice. Plan B-1 froze these shapes
 * deliberately so this app could be built against them — if the server ever
 * changes one, this file must change with it in the same commit.
 */
```

- [ ] **Step 4: Implement `apps/kiosk/src/api/client.ts`**, modelled on `apps/station/src/lib/api-client.ts`:

```ts
import type {
  CreateOrderDto,
  CreateOrderResultDto,
  KioskBootstrapDto,
  PairKioskResultDto,
} from "./types.js";

export class KioskApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "KioskApiError";
    this.status = status;
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "message" in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // non-JSON body
  }
  return res.statusText || `HTTP ${res.status}`;
}

function baseOf(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

/**
 * Redeems a pairing code. Deliberately NOT a method on the token-bearing
 * client: the device has no token until this succeeds, mirroring the server,
 * where this is the one route outside `KioskDeviceGuard`.
 */
export async function pairKiosk(serverUrl: string, code: string): Promise<PairKioskResultDto> {
  const res = await fetch(`${baseOf(serverUrl)}/kiosk/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new KioskApiError(res.status, await readError(res));
  return (await res.json()) as PairKioskResultDto;
}

export interface KioskClient {
  bootstrap(): Promise<KioskBootstrapDto>;
  submitOrder(body: CreateOrderDto): Promise<CreateOrderResultDto>;
}

export function createKioskClient(cfg: { token: string; serverUrl: string }): KioskClient {
  const base = baseOf(cfg.serverUrl);

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-kiosk-token": cfg.token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new KioskApiError(res.status, await readError(res));
    return (await res.json()) as T;
  }

  return {
    // Every authenticated call bumps `kiosks.last_seen_at` server-side, so a
    // periodic bootstrap doubles as the heartbeat — there is no separate one.
    bootstrap: () => request<KioskBootstrapDto>("GET", "/kiosk/bootstrap"),
    submitOrder: (body) => request<CreateOrderResultDto>("POST", "/kiosk/orders", body),
  };
}
```

- [ ] **Step 5: Run → PASS.** `pnpm --filter @markiro/kiosk exec vitest run api-client`

- [ ] **Step 6: Typecheck, format, commit**

```bash
pnpm --filter @markiro/kiosk typecheck
pnpm exec prettier --write apps/kiosk/src/api apps/kiosk/test/api-client.test.ts
git add apps/kiosk
git commit -m "feat(kiosk): device API client and the frozen server contracts"
```

---

### Task 4: IndexedDB store — snapshot, queue, journal, config

**Files:**

- Create: `apps/kiosk/src/store/{db.ts,cache.ts,queue.ts,journal.ts,config.ts}`
- Modify: `apps/kiosk/test/setup.ts`, `apps/kiosk/package.json` (add `fake-indexeddb`)
- Test: `apps/kiosk/test/store.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // config.ts — device identity and settings
  export interface KioskConfig {
    serverUrl: string;
    token: string | null;
    kioskName: string;
    place: string | null;
    nextDeviceSeq: number;
  }
  export function readConfig(): Promise<KioskConfig | null>;
  export function writeConfig(cfg: KioskConfig): Promise<void>;

  // cache.ts — the bootstrap snapshot
  export interface CachedSnapshot {
    bootstrap: KioskBootstrapDto;
    fetchedAt: string;
  }
  export function readSnapshot(): Promise<CachedSnapshot | null>;
  export function replaceSnapshot(bootstrap: KioskBootstrapDto, fetchedAt: Date): Promise<void>;

  // queue.ts — orders awaiting sync, drained in deviceSeq order
  export interface QueuedOrder {
    deviceSeq: number;
    body: CreateOrderDto;
  }
  export function enqueueOrder(body: CreateOrderDto): Promise<void>;
  export function listQueue(): Promise<QueuedOrder[]>; // ascending deviceSeq
  export function dequeueOrder(deviceSeq: number): Promise<void>;

  // journal.ts — what the server said, for the service screen
  export interface JournalEntry {
    at: string;
    deviceSeq: number;
    orderNo: string;
    conflicts: OrderConflict[];
  }
  export function appendJournal(entry: JournalEntry): Promise<void>;
  export function readJournal(limit: number): Promise<JournalEntry[]>;
  ```

- [ ] **Step 1: Add the test dependency and wire the fake**

```bash
pnpm --filter @markiro/kiosk add -D fake-indexeddb
```

Prepend to `apps/kiosk/test/setup.ts` (order matters — it must run before any module touches `indexedDB`):

```ts
// jsdom ships no IndexedDB. Register the fake on globalThis first, before any
// store module opens a database at import time.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach } from "vitest";

// A fresh factory per test: `fake-indexeddb/auto` otherwise shares one
// instance across every test in a worker, so state leaks between them.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

import "../src/i18n/index.js";
```

- [ ] **Step 2: Write the failing test** — `apps/kiosk/test/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readSnapshot, replaceSnapshot } from "../src/store/cache.js";
import { dequeueOrder, enqueueOrder, listQueue } from "../src/store/queue.js";
import { readConfig, writeConfig } from "../src/store/config.js";
import type { KioskBootstrapDto } from "../src/api/types.js";

const snapshot = (employees: KioskBootstrapDto["employees"]): KioskBootstrapDto => ({
  generatedAt: "2026-07-28T06:00:00.000Z",
  config: { dayLimitPerEmployee: 5, showPrices: true },
  badgeSalt: "c2FsdA==",
  reasons: [],
  products: [],
  employees,
  operators: [],
});

describe("cache", () => {
  it("returns null before anything is stored", async () => {
    await expect(readSnapshot()).resolves.toBeNull();
  });

  it("replaces the snapshot wholesale — an employee removed on the server disappears locally", async () => {
    await replaceSnapshot(
      snapshot([
        { id: "e1", fullName: "A", role: null, badgeHash: null },
        { id: "e2", fullName: "B", role: null, badgeHash: null },
      ]),
      new Date("2026-07-28T06:00:00.000Z"),
    );
    await replaceSnapshot(
      snapshot([{ id: "e1", fullName: "A", role: null, badgeHash: null }]),
      new Date("2026-07-28T06:05:00.000Z"),
    );

    const stored = await readSnapshot();
    expect(stored!.bootstrap.employees.map((e) => e.id)).toEqual(["e1"]);
    expect(stored!.fetchedAt).toBe("2026-07-28T06:05:00.000Z");
  });
});

describe("queue", () => {
  it("drains in deviceSeq order regardless of insertion order", async () => {
    for (const deviceSeq of [3, 1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] });
    }
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1, 2, 3]);
  });

  it("removes only the acknowledged order", async () => {
    await enqueueOrder({ deviceSeq: 1, badgeCode: "B", reason: "buy", items: [] });
    await enqueueOrder({ deviceSeq: 2, badgeCode: "B", reason: "buy", items: [] });
    await dequeueOrder(1);
    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([2]);
  });
});

describe("config", () => {
  it("round-trips the device identity", async () => {
    await writeConfig({
      serverUrl: "http://srv",
      token: "tok",
      kioskName: "Киоск-1",
      place: "Проходная",
      nextDeviceSeq: 7,
    });
    expect(await readConfig()).toMatchObject({ token: "tok", nextDeviceSeq: 7 });
  });
});
```

- [ ] **Step 3: Run → FAIL** (`pnpm --filter @markiro/kiosk exec vitest run store`).

- [ ] **Step 4: Implement `apps/kiosk/src/store/db.ts`** — one database, one upgrade path, one helper that runs a transaction:

```ts
const DB_NAME = "markiro-kiosk";
const DB_VERSION = 1;

export const STORE_CONFIG = "config";
export const STORE_SNAPSHOT = "snapshot";
export const STORE_QUEUE = "queue";
export const STORE_JOURNAL = "journal";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Singleton stores: one row under a fixed key. Keeping them as object
      // stores (rather than one blob) lets a snapshot replacement and a queue
      // write proceed without contending on the same record.
      if (!db.objectStoreNames.contains(STORE_CONFIG)) db.createObjectStore(STORE_CONFIG);
      if (!db.objectStoreNames.contains(STORE_SNAPSHOT)) db.createObjectStore(STORE_SNAPSHOT);
      // `deviceSeq` is the queue's natural key, and IndexedDB iterates a key
      // range in ascending order — which is exactly the drain order the
      // server's idempotency contract requires.
      if (!db.objectStoreNames.contains(STORE_QUEUE))
        db.createObjectStore(STORE_QUEUE, { keyPath: "deviceSeq" });
      if (!db.objectStoreNames.contains(STORE_JOURNAL))
        db.createObjectStore(STORE_JOURNAL, { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await open();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    let result: T | undefined;
    const request = run(tx.objectStore(name));
    if (request) request.onsuccess = () => (result = request.result);
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
```

- [ ] **Step 5: Implement the four modules on top of it.** `cache.ts` is the one with a real invariant:

```ts
import type { KioskBootstrapDto } from "../api/types.js";
import { STORE_SNAPSHOT, withStore } from "./db.js";

const KEY = "current";

export interface CachedSnapshot {
  bootstrap: KioskBootstrapDto;
  fetchedAt: string;
}

export async function readSnapshot(): Promise<CachedSnapshot | null> {
  const found = await withStore<CachedSnapshot>(STORE_SNAPSHOT, "readonly", (s) => s.get(KEY));
  return found ?? null;
}

/**
 * Replaces the whole snapshot in ONE transaction. Two properties matter and
 * both come from it being a single `put` of a single record: a reader never
 * observes a half-written dataset, and an employee deleted on the server
 * disappears locally instead of lingering (the station's
 * `replaceOperatorsMirror` achieves the same with two slot tables and a
 * pointer flip; IndexedDB gives it to us for free).
 */
export async function replaceSnapshot(
  bootstrap: KioskBootstrapDto,
  fetchedAt: Date,
): Promise<void> {
  await withStore(STORE_SNAPSHOT, "readwrite", (s) =>
    s.put({ bootstrap, fetchedAt: fetchedAt.toISOString() }, KEY),
  );
}
```

`queue.ts` uses `getAll()` (ascending key order = ascending `deviceSeq`) for `listQueue`, `put` for `enqueueOrder`, `delete(deviceSeq)` for `dequeueOrder`. `config.ts` mirrors `cache.ts` with its own fixed key. `journal.ts` appends with `autoIncrement` and `readJournal` reads the last `limit` entries via a `prev` cursor.

- [ ] **Step 6: Run → PASS**, then typecheck, format, commit:

```bash
pnpm --filter @markiro/kiosk exec vitest run store
pnpm --filter @markiro/kiosk typecheck
pnpm exec prettier --write apps/kiosk/src/store apps/kiosk/test
git add apps/kiosk pnpm-lock.yaml
git commit -m "feat(kiosk): IndexedDB snapshot, queue, journal and config"
```

---

### Task 5: Scan sources — keyboard wedge and Web Serial

**Files:**

- Create: `apps/kiosk/src/scanner/{source.ts,keyboard.ts,web-serial.ts}`
- Test: `apps/kiosk/test/scanner.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export type ScanListener = (raw: string) => void;
  export interface ScanSource {
    /** Whether this transport can run here at all (e.g. navigator.serial exists). */
    isAvailable(): boolean;
    /** Begins delivering scans; returns the function that stops it. */
    start(listener: ScanListener): () => void;
  }
  export function createKeyboardWedgeSource(opts?: {
    target?: KeyTarget;
    silenceMs?: number;
    minCharsPerSecond?: number;
  }): ScanSource;
  export function createWebSerialSource(port: SerialPort): ScanSource;
  export function isWebSerialSupported(): boolean;
  ```

The station's `ScanSource` (`apps/station/src/lib/scan-source.ts`) has only `start()`: it flushes on Enter and has no availability concept. The kiosk needs both additions — Web Serial is absent on tablets (so the UI must not offer it), and a wedge scanner that drops the trailing Enter would otherwise never flush.

- [ ] **Step 1: Write the failing test** — `apps/kiosk/test/scanner.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyboardWedgeSource, isWebSerialSupported } from "../src/scanner/keyboard.js";

class FakeTarget {
  private handlers: ((e: Event) => void)[] = [];
  addEventListener(_: string, h: EventListenerOrEventListenerObject) {
    this.handlers.push(h as (e: Event) => void);
  }
  removeEventListener(_: string, h: EventListenerOrEventListenerObject) {
    this.handlers = this.handlers.filter((x) => x !== h);
  }
  type(text: string) {
    for (const ch of text) this.handlers.forEach((h) => h({ key: ch } as unknown as Event));
  }
  press(key: string) {
    this.handlers.forEach((h) => h({ key } as unknown as Event));
  }
  get listenerCount() {
    return this.handlers.length;
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("keyboard wedge", () => {
  it("flushes the payload on Enter", () => {
    const target = new FakeTarget();
    const seen: string[] = [];
    createKeyboardWedgeSource({ target }).start((raw) => seen.push(raw));
    target.type("0104600682000013");
    target.press("Enter");
    expect(seen).toEqual(["0104600682000013"]);
  });

  it("flushes on a silence timeout too — a scanner configured without a suffix would otherwise never deliver", () => {
    const target = new FakeTarget();
    const seen: string[] = [];
    createKeyboardWedgeSource({ target, silenceMs: 60 }).start((raw) => seen.push(raw));
    target.type("01046006820000132");
    vi.advanceTimersByTime(60);
    expect(seen).toEqual(["01046006820000132"]);
  });

  it("ignores modifier and navigation keys, whose names are multi-character", () => {
    const target = new FakeTarget();
    const seen: string[] = [];
    createKeyboardWedgeSource({ target }).start((raw) => seen.push(raw));
    target.press("Shift");
    target.type("AB");
    target.press("ArrowLeft");
    target.press("Enter");
    expect(seen).toEqual(["AB"]);
  });

  it("never emits an empty payload", () => {
    const target = new FakeTarget();
    const seen: string[] = [];
    createKeyboardWedgeSource({ target }).start((raw) => seen.push(raw));
    target.press("Enter");
    expect(seen).toEqual([]);
  });

  it("stops listening when the returned function is called", () => {
    const target = new FakeTarget();
    const stop = createKeyboardWedgeSource({ target }).start(() => {});
    expect(target.listenerCount).toBe(1);
    stop();
    expect(target.listenerCount).toBe(0);
  });
});

describe("web serial availability", () => {
  it("reports unsupported when the browser has no serial API — a tablet must not be offered it", () => {
    vi.stubGlobal("navigator", {});
    expect(isWebSerialSupported()).toBe(false);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `apps/kiosk/src/scanner/source.ts`** — the seam and its types (the `ScanSource`/`ScanListener`/`KeyTarget` declarations from the Interfaces block).

- [ ] **Step 4: Implement `apps/kiosk/src/scanner/keyboard.ts`**

```ts
import type { KeyTarget, ScanListener, ScanSource } from "./source.js";

const DEFAULT_SILENCE_MS = 60;

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/**
 * Most USB/Bluetooth barcode scanners present as HID keyboards: they "type"
 * the payload and usually finish with Enter. Two departures from the
 * station's version, both required here:
 *
 *  - a silence timeout, because a scanner configured without a suffix would
 *    otherwise hold its payload forever;
 *  - `isAvailable()`, so the setup screen can present transports honestly.
 */
export function createKeyboardWedgeSource(
  opts: { target?: KeyTarget; silenceMs?: number } = {},
): ScanSource {
  const target = opts.target ?? window;
  const silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;

  return {
    isAvailable: () => true,
    start(listener: ScanListener) {
      let payload = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (payload.length > 0) listener(payload);
        payload = "";
      };

      const onKeyDown = (event: Event) => {
        const { key } = event as KeyboardEvent;
        if (key === "Enter") {
          flush();
          return;
        }
        if (key.length !== 1) return; // modifier / navigation key
        payload += key;
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, silenceMs);
      };

      target.addEventListener("keydown", onKeyDown);
      return () => {
        if (timer) clearTimeout(timer);
        target.removeEventListener("keydown", onKeyDown);
      };
    },
  };
}
```

- [ ] **Step 5: Implement `apps/kiosk/src/scanner/web-serial.ts`** — reads the port's readable stream, splits on CR/LF, and mirrors `createHardwareScanSource`'s stop-before-subscribe guard (`apps/station/src/lib/hardware.ts`): a `stopped` flag checked after every await, so a `start()`/stop race cannot leak a reader. Decode with `TextDecoderStream` and cap the buffer (discard beyond 4096 bytes) exactly as the station's Rust reader does, so line noise cannot grow it without bound.

Web Serial is the preferred transport where it exists: it delivers raw bytes, so the **GS separator (0x1D) inside a Chestny ZNAK code survives** — a keyboard wedge frequently drops it, which is what the domain guard's `incomplete` verdict exists to catch.

- [ ] **Step 6: Run → PASS.** Typecheck, format, commit:

```bash
git commit -m "feat(kiosk): keyboard-wedge and Web Serial scan sources"
```

---

### Task 6: Scan guard adapter

**Files:**

- Create: `apps/kiosk/src/domain-guard/classify.ts`
- Test: `apps/kiosk/test/classify.test.ts`

**Interfaces:**

- Consumes `classifyScan`, `validatePickupKm`, `kmKey` from `@markiro/domain`.
- Produces:

  ```ts
  export type KioskScan =
    | { kind: "badge"; raw: string }
    | { kind: "km"; rawKm: string; gtin14: string; kmKey: string }
    | { kind: "incomplete"; raw: string } // GS dropped — ask for a re-scan
    | { kind: "unknown"; raw: string };
  export function classifyKioskScan(raw: string): KioskScan;
  ```

- [ ] **Step 1: Write the failing test** — `apps/kiosk/test/classify.test.ts`. Use a check-digit-VALID GTIN (`04600682000013`; the prototype's `04650075195923` has an invalid check digit and would be rejected as not-a-KM, testing the wrong branch) and a real GS byte:

```ts
import { describe, expect, it } from "vitest";
import { classifyKioskScan } from "../src/domain-guard/classify.js";

const GS = String.fromCharCode(0x1d);
const GTIN = "04600682000013";

describe("classifyKioskScan", () => {
  it("recognises a well-formed marking code and exposes its dedup key", () => {
    const scan = classifyKioskScan(`01${GTIN}21KYC9X7MQ${GS}93Abcd`);
    expect(scan).toMatchObject({ kind: "km", gtin14: GTIN });
    if (scan.kind === "km") expect(scan.kmKey).toBe(`01${GTIN}21KYC9X7MQ`);
  });

  it("reports a marking code whose GS separator was dropped as incomplete, not as a badge", () => {
    // A keyboard wedge that swallows the separator produces exactly this.
    expect(classifyKioskScan(`01${GTIN}21KYC9X7MQ93Abcd`).kind).toBe("incomplete");
  });

  it("treats a badge payload as a badge", () => {
    expect(classifyKioskScan("MARKIRO-BADGE-4412")).toMatchObject({ kind: "badge" });
  });

  it("never classifies an empty scan", () => {
    expect(classifyKioskScan("").kind).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — map `validatePickupKm`'s `ok`/`incomplete` statuses onto the union, and treat a `not_km` result that is a non-empty string as a badge candidate (the badge QR carries an opaque payload; the server is what actually resolves it). Document that ordering: **KM first, badge as the fallback**, so a marking code can never be mistaken for a badge.

- [ ] **Step 4: Run → PASS.** Typecheck, format, commit: `feat(kiosk): scan classification adapter`.

---

### Task 7: Credentials — badge lookup and operator sign-in

**Files:**

- Create: `apps/kiosk/src/credentials/{badge.ts,operator.ts}`
- Test: `apps/kiosk/test/credentials.test.ts`

**Interfaces:**

- Consumes `deriveDigestB64`, `verifyPhc`, `PHC_ITERATIONS` from `@markiro/domain`.
- Produces:

  ```ts
  export function buildBadgeIndex(bootstrap: KioskBootstrapDto): Map<string, string>; // digestB64 -> employeeId
  export function resolveBadge(
    raw: string,
    bootstrap: KioskBootstrapDto,
    index: Map<string, string>,
  ): Promise<string | null>;
  export function verifyOperatorPin(
    login: string,
    pin: string,
    bootstrap: KioskBootstrapDto,
  ): Promise<Operator | null>;
  export function verifyOperatorBadge(
    raw: string,
    bootstrap: KioskBootstrapDto,
  ): Promise<Operator | null>;
  ```

- [ ] **Step 1: Write the failing test** — `apps/kiosk/test/credentials.test.ts`. The load-bearing assertion is the derivation count:

```ts
import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import { buildBadgeIndex, resolveBadge } from "../src/credentials/badge.js";

const SALT = "fwGrIt01vwgBxxDlhqLVRQ==";

async function bootstrapWith(badges: Record<string, string>) {
  const employees = await Promise.all(
    Object.entries(badges).map(async ([id, code]) => ({
      id,
      fullName: id,
      role: null,
      badgeHash: formatPhc(PHC_ITERATIONS, SALT, await deriveDigestB64(code, SALT, PHC_ITERATIONS)),
    })),
  );
  return { badgeSalt: SALT, employees } as never;
}

describe("resolveBadge", () => {
  it("finds the employee behind a scanned badge", async () => {
    const bootstrap = await bootstrapWith({ e1: "BADGE-1", e2: "BADGE-2" });
    const index = buildBadgeIndex(bootstrap);
    await expect(resolveBadge("BADGE-2", bootstrap, index)).resolves.toBe("e2");
  });

  it("returns null for an unknown badge", async () => {
    const bootstrap = await bootstrapWith({ e1: "BADGE-1" });
    await expect(resolveBadge("NOPE", bootstrap, buildBadgeIndex(bootstrap))).resolves.toBeNull();
  });

  it("costs ONE derivation regardless of roster size — a per-employee loop would take seconds on a full staff", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i++) many[`e${i}`] = `BADGE-${i}`;
    const bootstrap = await bootstrapWith(many);
    const index = buildBadgeIndex(bootstrap);

    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    await resolveBadge("BADGE-49", bootstrap, index);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `badge.ts`**

```ts
import { deriveDigestB64, parsePhc, PHC_ITERATIONS } from "@markiro/domain";
import type { KioskBootstrapDto } from "../api/types.js";

/**
 * digestB64 -> employeeId. Every badge verifier in a tenant shares
 * `badgeSalt` precisely so this map can exist: one derivation of the scanned
 * value, then a lookup. Verifying per employee instead would run PBKDF2
 * (100000 iterations) once per row — seconds on a full staff roster, on a
 * screen where a scan must feel instant.
 */
export function buildBadgeIndex(bootstrap: KioskBootstrapDto): Map<string, string> {
  const index = new Map<string, string>();
  for (const employee of bootstrap.employees) {
    if (!employee.badgeHash) continue;
    const parsed = parsePhc(employee.badgeHash);
    if (parsed) index.set(parsed.digestB64, employee.id);
  }
  return index;
}

export async function resolveBadge(
  raw: string,
  bootstrap: KioskBootstrapDto,
  index: Map<string, string>,
): Promise<string | null> {
  if (!raw) return null;
  const digest = await deriveDigestB64(raw, bootstrap.badgeSalt, PHC_ITERATIONS);
  return index.get(digest) ?? null;
}
```

`operator.ts` guards the settings screens: `verifyOperatorPin` looks the operator up **by `login` first** and then runs exactly one `verifyPhc` (4-digit PINs collide across a roster, so a PIN-only match could sign in the wrong person — the station makes the same point in `apps/station/src/lib/auth.ts`); `verifyOperatorBadge` reuses the same one-derivation index built over `operators[].badgeHash`. Only `active` operators may pass.

- [ ] **Step 4: Run → PASS.** Typecheck, format, commit: `feat(kiosk): one-derivation badge lookup and operator sign-in`.

---

### Task 8: Cart reducer

**Files:**

- Create: `apps/kiosk/src/session/cart.ts`
- Test: `apps/kiosk/test/cart.test.ts`

**Interfaces:**

- Produces a pure reducer — no React, no storage:

  ```ts
  export interface CartItem {
    rawKm: string;
    kmKey: string;
    gtin14: string;
    productId: string | null;
    name: string;
    unitPrice: string | null;
  }
  export interface CartState {
    items: CartItem[];
    reason: "buy" | "writeoff";
    writeoffReasonId: string | null;
    notice: CartNotice | null;
  }
  // `not-a-code` was added during Task 8 review: `classifyKioskScan` returns
  // `unknown` for a bare GTIN/SSCC, so without it a worker who scans the plain
  // product barcode instead of the DataMatrix gets no notice at all.
  export type CartNotice =
    | { kind: "duplicate" }
    | { kind: "limit" }
    | { kind: "unknown-product" }
    | { kind: "incomplete" }
    | { kind: "not-a-code" };
  export type CartAction =
    | { type: "scan"; scan: KioskScan }
    | { type: "remove"; kmKey: string }
    | { type: "reason"; reason: "buy" | "writeoff" }
    | { type: "writeoffReason"; id: string }
    | { type: "dismissNotice" }
    | { type: "reset" };
  export function cartReducer(
    state: CartState,
    action: CartAction,
    ctx: { bootstrap: KioskBootstrapDto; alreadyTakenToday: number },
  ): CartState;
  export function canSubmit(state: CartState): boolean;
  ```

- [ ] **Step 1: Write the failing test** covering exactly the prototype's rules: a scanned KM whose GTIN is in `products` is added with its name and price; the **same `kmKey` twice** yields `notice: {kind:"duplicate"}` and does not grow the list; a GTIN absent from `products` yields `unknown-product`; scanning at `dayLimitPerEmployee` (counting `alreadyTakenToday`) yields `limit`; an `incomplete` scan yields `incomplete`; `canSubmit` is false with an empty list, false for `writeoff` without a sub-reason, and true otherwise.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Keep every decision in the reducer so the screen is a pure projection. Comment the local-vs-server split: these checks are UX only — the server re-decides on submit, and its `conflicts[]` win.

- [ ] **Step 4: Run → PASS.** Typecheck, format, commit: `feat(kiosk): cart reducer with duplicate, limit and unknown-product rules`.

---

### Task 9: Sync worker and staleness gates

**Files:**

- Create: `apps/kiosk/src/sync/worker.ts`
- Test: `apps/kiosk/test/sync.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export const REFRESH_INTERVAL_MS = 5 * 60_000;
  export const STALE_WARN_MS = 24 * 60 * 60_000;
  export const STALE_BLOCK_MS = 7 * 24 * 60 * 60_000;
  export type CacheAge = "fresh" | "warn" | "blocked";
  export function cacheAge(generatedAt: string, now: Date): CacheAge;
  export function flushQueue(client: KioskClient, now: () => Date): Promise<void>;
  export function refreshSnapshot(client: KioskClient, now: () => Date): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test** — `apps/kiosk/test/sync.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { cacheAge, flushQueue } from "../src/sync/worker.js";
import { enqueueOrder, listQueue } from "../src/store/queue.js";

describe("cacheAge", () => {
  const base = "2026-07-28T00:00:00.000Z";
  it("is fresh within a day", () => {
    expect(cacheAge(base, new Date("2026-07-28T10:00:00.000Z"))).toBe("fresh");
  });
  it("warns after a day", () => {
    expect(cacheAge(base, new Date("2026-07-29T01:00:00.000Z"))).toBe("warn");
  });
  it("blocks after a week", () => {
    expect(cacheAge(base, new Date("2026-08-05T00:00:00.000Z"))).toBe("blocked");
  });
});

describe("flushQueue", () => {
  it("submits in deviceSeq order and drops each order only after the server acknowledges it", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] });
    }
    const seen: number[] = [];
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async (body: { deviceSeq: number }) => {
        seen.push(body.deviceSeq);
        return {
          orderNo: `ORD-26-000${body.deviceSeq}`,
          status: "pending",
          itemCount: 0,
          conflicts: [],
        };
      }),
    };

    await flushQueue(client as never, () => new Date());

    expect(seen).toEqual([1, 2]);
    expect(await listQueue()).toEqual([]);
  });

  it("stops at the first failure and keeps the rest queued, so ordering is never broken", async () => {
    for (const deviceSeq of [1, 2]) {
      await enqueueOrder({ deviceSeq, badgeCode: "B", reason: "buy", items: [] });
    }
    const client = {
      bootstrap: vi.fn(),
      submitOrder: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await flushQueue(client as never, () => new Date());

    expect((await listQueue()).map((q) => q.deviceSeq)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `flushQueue` walks `listQueue()` in order, submits, appends the server's answer to the journal, then dequeues — **acknowledge-then-remove**, never the reverse, so a crash mid-flight replays rather than loses. A failure aborts the drain (later orders must not overtake an earlier one). `cacheAge` compares against `generatedAt` — the server's stamp, not the device's `fetchedAt`, because an unattended tablet's clock is the least trustworthy in the system.

- [ ] **Step 4: Run → PASS.** Typecheck, format, commit: `feat(kiosk): sync worker with ordered drain and staleness gates`.

---

### Task 10: Pairing screen

**Files:**

- Create: `apps/kiosk/src/screens/Pairing.tsx`
- Modify: `apps/kiosk/src/i18n/{ru,en}.json`
- Test: `apps/kiosk/test/pairing-screen.test.tsx`

- [ ] **Step 1: Write the failing test** — renders the screen with a stubbed `fetch`; asserts: entering eight digits on the `PinPad` enables the submit; a successful pair writes the token, `nextDeviceSeq` and the snapshot to the store (assert via `readConfig()`/`readSnapshot()`); a `401` shows «Неверный или просроченный код» and does not persist anything; a network failure shows the connection message with a retry; the «Настроить сканер» control is reachable **before** pairing.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Numeric entry via the lifted `PinPad` with `maxLength={8}`, a «Сканировать код» button that consumes the same `ScanSource`, and a collapsed server-address field (an on-prem deployment needs it; in a SaaS build the origin is baked in). On success: `writeConfig` + `replaceSnapshot` from the bundle's own `bootstrap`, so the device is immediately usable without a second round trip.

- [ ] **Step 4: Run → PASS.** Typecheck, i18n lockstep, format, commit: `feat(kiosk): pairing screen`.

---

### Task 11: Scanner setup screen

**Files:**

- Create: `apps/kiosk/src/screens/ScannerSetup.tsx`
- Modify: `apps/kiosk/src/i18n/{ru,en}.json`
- Test: `apps/kiosk/test/scanner-setup.test.tsx`

- [ ] **Step 1: Write the failing test** — asserts: with `navigator.serial` absent only the keyboard transport is offered (a tablet must not be shown a port picker it cannot use); a test scan echoes the recognised kind («бейдж» / «код маркировки» / «не распознано») using the Task 6 adapter; **after** pairing the screen demands operator credentials, and a wrong PIN keeps it closed; **before** pairing it opens without any credential.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Two-tier access is the point: unpaired devices need the scanner to read the pairing code itself, so gating it then would deadlock; once paired, it is a settings screen and takes operator credentials (badge scan, or login + PIN) via Task 7.

- [ ] **Step 4: Run → PASS.** Commit: `feat(kiosk): scanner setup with a test scan`.

---

### Task 12: Idle screen

**Files:**

- Create: `apps/kiosk/src/screens/Idle.tsx`
- Modify: `apps/kiosk/src/i18n/{ru,en}.json`
- Test: `apps/kiosk/test/idle-screen.test.tsx`

- [ ] **Step 1: Write the failing test** — `apps/kiosk/test/idle-screen.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Idle } from "../src/screens/Idle.js";

afterEach(cleanup);

const GS = String.fromCharCode(0x1d);
const GTIN = "04600682000013";

describe("Idle", () => {
  it("hands the recognised employee to its caller", async () => {
    const onEmployee = vi.fn();
    const resolveBadge = vi.fn(async () => "e1");
    render(
      <Idle onEmployee={onEmployee} resolveBadge={resolveBadge} onScan={(cb) => cb("BADGE-1")} />,
    );
    // Corrected during the Task 12 review: this read
    // `expect(await vi.waitFor(() => onEmployee.mock.calls.length)).toBe(1)`,
    // which can never pass — `vi.waitFor` resolves with the first non-throwing,
    // non-thenable value its callback returns, always 0 here, and never retries
    // (`vi.waitUntil` is the API that retries on a falsy value).
    await vi.waitFor(() => expect(onEmployee).toHaveBeenCalledTimes(1));
    expect(onEmployee).toHaveBeenCalledWith("e1");
  });

  it("tells the worker when the badge is not recognised, and lets no one in", async () => {
    const onEmployee = vi.fn();
    render(
      <Idle onEmployee={onEmployee} resolveBadge={async () => null} onScan={(cb) => cb("NOPE")} />,
    );
    expect(await screen.findByText(/Бейдж не распознан/)).toBeDefined();
    expect(onEmployee).not.toHaveBeenCalled();
  });

  it("ignores a marking code scanned at the idle screen instead of treating it as a badge", async () => {
    const resolveBadge = vi.fn();
    render(
      <Idle
        onEmployee={vi.fn()}
        resolveBadge={resolveBadge}
        onScan={(cb) => cb(`01${GTIN}21KYC9X7MQ${GS}93Abcd`)}
      />,
    );
    expect(resolveBadge).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `pnpm --filter @markiro/kiosk exec vitest run idle-screen` → FAIL, module not found.

- [ ] **Step 3: Implement `apps/kiosk/src/screens/Idle.tsx`** per the prototype: «Возьмите продукцию для себя», the sub-line «Оформление и оплата — на кассе у администратора», the scan-your-badge zone, and the note that the QR is on the back of the badge. Route every scan through `classifyKioskScan` (Task 6) first and act only on `kind: "badge"` — that is what makes the third test pass.

- [ ] **Step 4: Run → PASS.** Typecheck, i18n lockstep, format, commit: `feat(kiosk): idle screen`.

---

### Task 13: Cart screen

**Files:**

- Create: `apps/kiosk/src/screens/Cart.tsx`
- Modify: `apps/kiosk/src/i18n/{ru,en}.json`
- Test: `apps/kiosk/test/cart-screen.test.tsx`

This is the screen the worker actually uses; it is a projection of Task 8's reducer plus the two orientations.

- [ ] **Step 1: Write the failing test** — a scanned product appears with its name, code tail and price; a repeat scan shows the amber duplicate banner and the list does not grow; reaching the limit replaces the scan zone with the amber blocking panel; an unknown product opens the **red modal** «Товара нет в каталоге, обратитесь к администратору»; choosing «Списание» requires a sub-reason chip before submit enables; `showPrices: false` hides every price and the total; «Не я» resets to idle.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** per `docs/design-briefs/design_handoff_markiro/prototypes/pickup-kiosk.dc.html`: 76 px header (logo, ФИО + avatar, «Не я» 56 px), scan zone, «Вы берёте» list (photo placeholder 56 px — product images are deliberately out of scope, name + code tail identify the item), counter, limit with remaining, reason toggle + chips, and the 84 px «Готово — передать администратору». Both orientations (landscape 1180×800, portrait 800×1180) via flex direction, no media queries.

- [ ] **Step 4: Run → PASS.** Commit: `feat(kiosk): cart screen`.

---

### Task 14: Done and Blocked screens, and the shell

**Files:**

- Create: `apps/kiosk/src/screens/{Done.tsx,Blocked.tsx}`, `apps/kiosk/src/ui/{KioskShell.tsx,StatusStrip.tsx}`
- Modify: `apps/kiosk/src/App.tsx`, `apps/kiosk/src/i18n/{ru,en}.json`
- Test: `apps/kiosk/test/{done-screen.test.tsx,app.test.tsx}`

- [ ] **Step 1: Write the failing test** — online submit shows the real `ORD-…` number; **offline submit shows the handover confirmation without a number** («Заявка передана, номер появится после синхронизации») and leaves the order queued; the screen auto-resets after 10 s (fake timers); `Blocked` renders when `cacheAge` is `blocked` and states that the queue keeps draining; the status strip shows online/offline and a warning once the snapshot is older than a day.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**, and wire `App.tsx`: read config + snapshot on mount, subscribe to `online`/`offline`, start the refresh interval and the queue drain, and render `nextKioskView(...)`'s choice. Keep `App.tsx` thin — every decision already lives in a tested pure function.

- [ ] **Step 4: Run → PASS.** Commit: `feat(kiosk): done and blocked screens, kiosk shell`.

---

### Task 15: PWA — installable, offline shell

**Files:**

- Modify: `apps/kiosk/{package.json,vite.config.ts,index.html}`
- Create: `apps/kiosk/public/{icon-192.png,icon-512.png,icon-maskable-512.png}`
- Test: `apps/kiosk/test/pwa-config.test.ts`

- [ ] **Step 1: Add the plugin.** `pnpm --filter @markiro/kiosk add -D vite-plugin-pwa` (pinned exact by `save-exact`; ≥7 days old per `minimum-release-age`).

- [ ] **Step 2: Write the failing test** — import the Vite config and assert the manifest: `display: "fullscreen"`, `orientation: "any"` (both orientations are supported), `start_url: "/"`, dark `theme_color`/`background_color`, three icons including a maskable one, and that `/api/` is **not** runtime-cached. Asserting the config object keeps this meaningful in jsdom, which has no service-worker support.

- [ ] **Step 3: Configure `VitePWA`** with `registerType: "autoUpdate"` (an unattended kiosk is never manually updated) and a precache covering the built shell. Exclude `/api/*` from runtime caching entirely: `POST /kiosk/orders` carries its own idempotency and queue semantics, and a cache layer in front of it would either replay or mask submissions. The offline story is the IndexedDB snapshot, not HTTP caching.

- [ ] **Step 4: Run → PASS**, then verify a real build emits a service worker and manifest:

```bash
pnpm --filter @markiro/kiosk build
ls apps/kiosk/dist/sw.js apps/kiosk/dist/manifest.webmanifest
```

- [ ] **Step 5: Commit**

```bash
git add apps/kiosk pnpm-lock.yaml
git commit -m "feat(kiosk): installable PWA with an offline shell"
```

---

## Final Verification

- [ ] Full gate: `pnpm turbo lint typecheck test build` then `pnpm format:check`. Both clean. (If a cross-package flake appears, re-run with `--concurrency=1`: the dev Postgres is shared with other sessions, though this plan's tests do not use it.)
- [ ] Manual smoke against a running API (`pnpm --filter @markiro/api dev`, `pnpm --filter @markiro/kiosk dev`): issue a pairing code in the admin panel → enter it on the kiosk → confirm the device pairs and shows the idle screen → scan a badge → scan an allowlisted code → submit → see the order in «Для себя».
- [ ] Offline check: pair, then stop the API. Scan and submit — the confirmation must appear without a number and the order must stay queued. Restart the API and confirm the queue drains and the journal records the server's answer.

## Self-Review (completed while writing)

- **Spec coverage:** §5.2 pairing screen (Task 10) · §5.3 scanner setup with its two access tiers (Task 11) · §6 scan transports (Task 5) and the domain guard (Task 6) · §6.1–6.2 badge hashes and the one-derivation lookup (Task 7) · §7 cache/queue/sync and the authority split (Tasks 4, 9) · §7.2 `nextDeviceSeq` continuation (Tasks 3, 10) · §7.3 thresholds (Task 9) · §8 all three work screens plus Blocked (Tasks 12–14) · §9 module layout (the File Structure section). Deliberately out of scope: the Tauri shell (spec §2 decision 2) and product photos (§11.4).
- **Type consistency:** `ScanSource`/`ScanListener` (Task 5) feed `classifyKioskScan` (Task 6) feed `cartReducer` (Task 8); `KioskBootstrapDto` (Task 3) is consumed by Tasks 4, 7, 8, 9; `KioskClient` (Task 3) is consumed by Task 9; `nextKioskView` (Task 1) is wired in Task 14.
- **Assumptions carried from the spec:** thresholds are build constants, not server config (§7.3); no product images in v1 (§11.4); operator credentials rather than a service PIN guard the settings (§11.1); the DTOs are duplicated rather than extracted to a shared package, matching the admin panel's existing precedent.
