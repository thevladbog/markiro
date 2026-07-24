# Plan 05a: Station Foundation & Offline Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Markiro line-station app (Tauri + React floor mode) with its Rust core, a SQLite shift mirror, server device enrollment + station bundle download, and fully-offline operator PIN/badge login — the foundation the 05b scan/hardware pipeline builds on.

**Architecture:** A new `apps/station` Tauri 2.11 webview reuses `@markiro/ui` (floor tokens, dark theme) and `@markiro/domain` (GTIN normalization); the Rust core owns a `0600` secure config store, kiosk lockdown, and updater command skeletons. The station enrolls against the SaaS API for a Better Auth **api-key** (`referenceId = tenantId`), downloads a shift **bundle** into a `packages/db` SQLite mirror via `drizzle-orm/sqlite-proxy` + `tauri-plugin-sql`, and authenticates operators **locally** by PBKDF2 PHC verifier — the station never sends a PIN to the server.

**Tech Stack:** Tauri 2.11 (Rust: `serde`/`serde_json`/`uuid`/`url`, `tauri-plugin-sql`, `tauri-plugin-updater`, `tauri-plugin-single-instance`), React 19.2 + Vite 8.1, `@markiro/ui`/`@markiro/domain`, drizzle-orm SQLite schema, NestJS 11 + Better Auth `apiKey` plugin (server), WebCrypto PBKDF2-SHA256 (offline verify), vitest + `node:sqlite` (TS tests), `cargo test` (Rust tests).

### Decided architecture (pinned decisions for this plan and 05b)

1. **Hardware module is EMBEDDED in the Tauri Rust core** (not a standalone sidecar), exposed to the webview via Tauri IPC `#[tauri::command]`s whose operations mirror the idento-agent HTTP contract (scan-consume, print, discovery) so it can later be extracted to a standalone localhost-HTTP agent without touching the UI. **05a lays only the Rust command-module structure + config; the hardware commands themselves are 05b.** Reference patterns: `/Users/thevladbog/PRSOME/idento/desktop/src-tauri/src/commands.rs` (config/lockdown/updater/URL-hardening), `/Users/thevladbog/PRSOME/idento/agent/main.go` (config persisted to `~/.idento/agent_config.json` mode `0600`, stable UUIDv4 `machine_id`, bearer token).
2. **TSPL binary transport (05b) will carry bytes as base64 / raw byte body, NEVER a JSON string field** — idento's `{zpl:string}` corrupts latin1 binary via Go `[]byte(string)` UTF-8 re-encoding. Pinned for 05b; 05a does not print.
3. **Station→API auth:** device enrollment issues an **organization-owned** Better Auth api-key. This is the DOCUMENTED mechanism for a tenant-scoped key ([better-auth api-key advanced §Organization-Owned API Keys](https://better-auth.com/docs/plugins/api-key/advanced#organization-owned-api-keys)): configure the `apiKey` plugin with a named config `{ configId: "station", references: "organization" }`, then mint via `createApiKey({ body: { configId: "station", organizationId: tenantId, userId: <enrolling member id> } })`. For org-owned keys `ApiKey.referenceId` **is** the `organizationId` (= our `tenantId`), and `verifyApiKey` returns the key (minus its secret) including `referenceId`. `TenantGuard` is extended so that, absent a session, the `x-api-key` header is verified via `auth.api.verifyApiKey` and `req.tenantId` is set from `result.key.referenceId`. Two execution-time confirmations (flag in the task report): (a) a server-side `createApiKey` call has no session headers, so it needs a `userId` of an org member permitted to create keys — pass the enrolling user's id (the org owner always has permission); (b) verify that switching the plugin to a single named config does not require passing `configId` to `verifyApiKey` (docs say verify resolves the key's own config). **Alternative if org-owned keys prove awkward:** mint a plain user-owned key and resolve the tenant in the guard via a `station_devices` lookup keyed by the verified `key.id` (Task 6 already persists `apiKeyId`) — this avoids all org-permission/config nuances at the cost of a DB read in the guard. Operators authenticate OFFLINE and LOCALLY — the station never sends a PIN to the server.
4. **Credential-hash contract** (used by `operators_mirror` + offline verify; the parallel server operators workstream must match it in 05b — see "Operator credential hash contract" in `apps/station/README.md` for the same content): a PIN is all-digits (min 4). The stored verifier is a PHC-like string `pbkdf2$sha256$<iterations>$<saltBase64>$<hashBase64>` computed with WebCrypto `SubtleCrypto` PBKDF2-SHA256 (available in the Tauri webview — no native dep). A badge is the scanned barcode string, hashed identically into a separate `badge_hash`. The station util exposes pure `hashSecret(secret): Promise<string>`, `verifyPin(pin, phc): Promise<boolean>`, `verifyBadge(code, phc): Promise<boolean>`, unit-tested against a `node:crypto` known vector. The format string alone underspecifies interop, so these constraints are PINNED and enforced by the code (`apps/station/src/lib/crypto.ts`):
   - **Derived key length is EXACTLY 32 bytes** (`dkLen=32` / 256-bit) — `crypto.subtle.deriveBits` is called with `KEY_BITS = 256`.
   - **Base64 is STANDARD, WITH padding** (`btoa`/`atob`, RFC 4648 §4) — **NOT** the PHC-spec unpadded B64 (RFC 4648 §5 without `=`). A stock PHC encoder/decoder will silently mis-decode `hashBase64`/`saltBase64` if it strips or expects no padding; the server must byte-for-byte match `btoa`'s output, not re-derive it from a generic PHC library.
   - **Salt is 16 bytes**, generated with `crypto.getRandomValues(new Uint8Array(16))`.
   - **Iterations ≥ 100000 for newly minted hashes** (`hashSecret` always mints at `ITERATIONS = 100_000`); the verifier (`verifyPin`/`verifyBadge`) enforces a floor of `MIN_ITERATIONS = 10_000` and returns `false` for any PHC string below it (so a tampered/downgraded bundle can't force a trivial-cost hash), and the server must never mint below 100000 for a hash the station will consume.
   - **The executable spec is `apps/station/test/crypto.test.ts`'s known-vector test**, which cross-checks the station's PBKDF2 output byte-for-byte against Node's `pbkdf2Sync` for a fixed salt/PIN/iteration count. The 05b server team must reproduce that exact vector (same salt bytes, same PIN, same iteration count → same derived bytes → same base64 string) before considering their hasher interop-compatible; do not rely on the prose above alone.

## Global Constraints

Every task's requirements implicitly include this section.

- **Pinned versions (architecture §1).** Node 24 (`engines >=24`), pnpm 11.10.0, turbo 2.10.4, TypeScript 6.0.3, **Tauri (cli/api) 2.11**, React 19.2.7, react-dom 19.2.7, Vite 8.1.3, @vitejs/plugin-react 6.0.3, react-router 8.2.0, @tanstack/react-query 5.101.4, i18next 26.3.6, react-i18next 17.0.10, zod 4.4.3, drizzle-orm 0.45.2, drizzle-kit 0.31.10, better-auth 1.6.23, vitest 4.1.10, jsdom 29.1.1, @testing-library/react 16.3.2, @fontsource/ibm-plex-sans + @fontsource/ibm-plex-mono 5.3.0.
- **`.npmrc` is untouchable.** Root `.npmrc` stays (npmjs registry, `save-exact`, `engine-strict`, `minimum-release-age=10080` = 7-day quarantine). **Adding `minimumReleaseAgeExclude` to `.npmrc` = task failure.** If a version is quarantined, take the newest passing version and record it in the task report.
- **Rust versions are chosen at execution** (none pre-pinned): Tauri 2.11; use `serde`/`serde_json` for config, `uuid` (v4), `url` for URL validation, `cargo test` for tests. SQLite runtime access via `tauri-plugin-sql` + `drizzle-orm/sqlite-proxy`. For SQLite **unit tests in TS**, use Node 24's built-in `node:sqlite` (experimental, no new dep) — **do NOT add better-sqlite3.**
- **i18n RU (default) + EN in lockstep from day one.** A missing key must fail tests (mirror admin's `missingKeyHandler`). Dictionaries `ru.json`/`en.json` must have identical key sets (asserted by a test).
- **Floor mode dark theme default** (design briefs 02 + 04): min touch target **64px**, base font **18px+**, counters 48–96px, AAA status contrast, status = color + icon + text (never color alone), full-screen signal overlays (not toasts). Station webview reuses `@markiro/ui` tokens/components and `@markiro/domain`. **No CDN** — bundle fonts (IBM Plex, OFL) and (later) sounds.
- **Multi-tenant.** Every server table carries `tenant_id`; tenant scoping goes **in the SQL statement** (Plan 03 precedent), bodies are zod-validated, `handleWriteError` maps 23505→409 and 23503→400/409. Error copy is English. Conventional commits (English, **no co-author line** — subagents commit plainly). TDD (vitest for TS, `cargo test` for Rust).
- **e2e is EXECUTED** with env: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173`. The dev Postgres is started via `docker compose -f docker-compose.dev.yml up -d`. **Never `docker compose down`.**
- **Scope: 05a is FOUNDATION ONLY.** IN SCOPE: Tauri scaffold; Rust core (secure config store, kiosk lockdown, updater skeletons); `packages/db` SQLite mirror schema + drizzle sqlite-proxy wiring; server device enrollment + `TenantGuard` api-key path; server shift `open` endpoint + station `bundle` GET; station API client + enrollment UI; shift download → SQLite mirror; **offline** operator PIN/badge login against a local `operators_mirror`; shift selection + ad-hoc shift create (product from typed/keyboard-wedge GTIN input — **no serial scanner yet**); floor-mode shell (status bar, task switcher, i18n, dark theme, a `SignalOverlay` **skeleton** only).
  - **OUT OF SCOPE → 05b:** the validation scan pipeline (recording `codes`/`scan_events`), the signal-system behavior (flash/sound), the hardware module (serial scanner + ZPL/TSPL printing), the workstation-setup screen, the station `RasterizeTextFn`.
  - **OUT OF SCOPE → 06:** SSCC range allocation, aggregation/box/pallet, batch sync-up, conflict screens.
- **Operators are a PARALLEL workstream — do NOT build the server operators table.** A concurrent session owns the server-side operators entity. 05a builds only the **station-local** side: an `operators_mirror` SQLite table + offline PIN/badge verification, seeded in tests. The station bundle's `operators` field is DEFINED but returns `[]` (MOCKED) in 05a with a `// TODO(05b)` note — do NOT query a non-existent server table.
- **Migration-number race.** Existing Postgres migrations are `0000`–`0007`. The new `station_devices` migration is `0008`, generated against latest `main`. A parallel session may also add an operators migration claiming `0008`; note the risk that migration numbers must be regenerated/rebased at execution so the sequence stays contiguous.
- **Turbo wiring.** `apps/api/turbo.json` serializes `api#test` after `@markiro/db#test` (shared DB). `apps/station` and the new `packages/db` SQLite tests must wire `lint`/`typecheck`/`test`/`build` for turbo and respect this ordering.

---

### Task 1: `apps/station` scaffold (Tauri 2.11 + React 19.2 + Vite, floor dark theme, i18n, smoke tests)

**Files:**

- Create: `apps/station/package.json`
- Create: `apps/station/index.html`
- Create: `apps/station/vite.config.ts`
- Create: `apps/station/vitest.config.ts`
- Create: `apps/station/tsconfig.json`
- Create: `apps/station/turbo.json`
- Create: `apps/station/src/main.tsx`
- Create: `apps/station/src/App.tsx`
- Create: `apps/station/src/i18n/index.ts`
- Create: `apps/station/src/i18n/ru.json`
- Create: `apps/station/src/i18n/en.json`
- Create: `apps/station/src-tauri/Cargo.toml`
- Create: `apps/station/src-tauri/build.rs`
- Create: `apps/station/src-tauri/tauri.conf.json`
- Create: `apps/station/src-tauri/capabilities/default.json`
- Create: `apps/station/src-tauri/src/main.rs`
- Create: `apps/station/src-tauri/src/lib.rs`
- Create: `apps/station/src-tauri/src/commands.rs`
- Create: `apps/station/test/setup.ts`
- Test: `apps/station/test/App.test.tsx`

**Interfaces:**

- Consumes: `@markiro/ui` (`ThemeProvider`), the admin i18n init pattern (`apps/admin/src/i18n/index.ts`).
- Produces: Rust `#[tauri::command] fn hello(name: &str) -> String`; TS i18n singleton (default export) + `SUPPORTED_LANGUAGES`; `App` React component; a bootable `apps/station` workspace member with turbo `lint`/`typecheck`/`test`/`build`.

- [ ] **Step 1: Create the pnpm workspace member `package.json`**

`apps/station/package.json`:

```json
{
  "name": "@markiro/station",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource/ibm-plex-sans": "5.3.0",
    "@markiro/domain": "workspace:*",
    "@markiro/ui": "workspace:*",
    "@tanstack/react-query": "5.101.4",
    "@tauri-apps/api": "2.11.0",
    "@tauri-apps/plugin-sql": "2.3.0",
    "i18next": "26.3.6",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "react-i18next": "17.0.10",
    "react-router": "8.2.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@tauri-apps/cli": "2.11.0",
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

> Version note: `@tauri-apps/api`/`@tauri-apps/cli` `2.11.0` and `@tauri-apps/plugin-sql` `2.3.0` are the target majors/minors. If quarantined by `minimum-release-age`, take the newest passing `2.11.x` / `2.x` and record the exact version in the task report. Do NOT edit `.npmrc`.

- [ ] **Step 2: Create the Vite + TS + Tauri host config files**

`apps/station/index.html`:

```html
<!doctype html>
<html lang="ru" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Markiro Station</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/station/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves the built webview from `dist/`. `clearScreen: false` keeps the
// Rust compiler output visible during `tauri dev`. Port is fixed so the Rust
// `devUrl` in tauri.conf.json matches.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5273, strictPort: true },
  build: { target: "es2023", outDir: "dist" },
});
```

`apps/station/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node", "vitest/globals"],
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

`apps/station/vitest.config.ts`:

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

`apps/station/turbo.json`:

```json
{
  "$schema": "https://turborepo.com/schema.json",
  "extends": ["//"]
}
```

- [ ] **Step 3: Create the i18n singleton (RU default, EN mirror, missing-key-throws in tests)**

`apps/station/src/i18n/ru.json`:

```json
{
  "app": { "title": "Маркиро — Станция", "booting": "Загрузка станции…" }
}
```

`apps/station/src/i18n/en.json`:

```json
{
  "app": { "title": "Markiro — Station", "booting": "Loading station…" }
}
```

`apps/station/src/i18n/index.ts`:

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

- [ ] **Step 4: Create the React entrypoint + placeholder root screen**

`apps/station/src/App.tsx`:

```tsx
import { useTranslation } from "react-i18next";

export function App() {
  const { t } = useTranslation();
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <h1 style={{ fontSize: "2.5rem" }}>{t("app.title")}</h1>
    </main>
  );
}
```

`apps/station/src/main.tsx`:

```tsx
import "@markiro/ui/styles.css";
import "./i18n/index.js";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@markiro/ui";

import { App } from "./App.js";

const queryClient = new QueryClient();

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

// Floor mode: dark theme is the default (design brief 02/04).
createRoot(container).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
```

- [ ] **Step 5: Create the test setup file and write the failing smoke test**

`apps/station/test/setup.ts`:

```ts
// Initializes the i18next singleton (RU resources, missing-key-throws in test
// mode) before any test renders a component that calls useTranslation.
import "../src/i18n/index.js";
```

`apps/station/test/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";

describe("App", () => {
  it("renders the RU app title by default", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Маркиро — Станция" })).toBeDefined();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station test`
Expected: FAIL — `Cannot find module '../src/App.js'` (or a resolution error) until the source files above are installed and the workspace is linked.

- [ ] **Step 7: Install and link the new workspace member**

Run: `pnpm install`
Expected: adds `@markiro/station` to the workspace; no `.npmrc` edits. If any pinned version is quarantined, bump to the newest passing version and note it.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @markiro/station test`
Expected: PASS (1 test).

- [ ] **Step 9: Create the Rust crate with a `hello` command + cargo smoke test**

`apps/station/src-tauri/Cargo.toml`:

```toml
[package]
name = "markiro-station"
version = "0.1.0"
description = "Markiro line station"
edition = "2021"
license = "Apache-2.0 OR MIT"

[lib]
name = "markiro_station_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2.11", features = [] }
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-updater = "2"
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
url = "2"

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

`apps/station/src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build();
}
```

`apps/station/src-tauri/src/commands.rs`:

```rust
/// Minimal IPC smoke command; proves the webview<->Rust bridge is wired.
#[tauri::command]
pub fn hello(name: &str) -> String {
    format!("Hello, {name}, from the Markiro station core")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_greets_by_name() {
        assert_eq!(
            hello("Line 1"),
            "Hello, Line 1, from the Markiro station core"
        );
    }
}
```

`apps/station/src-tauri/src/lib.rs`:

```rust
mod commands;

/// Builds and runs the Tauri application. Plugins mirror the idento kiosk
/// baseline: single-instance (one station per machine), sql (SQLite mirror),
/// updater (release-channel updates). Hardware/config/lockdown commands are
/// added in later 05a tasks.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![commands::hello])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro station");
}
```

`apps/station/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    markiro_station_lib::run();
}
```

- [ ] **Step 10: Create the Tauri host config + capabilities**

`apps/station/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Markiro Station",
  "version": "0.1.0",
  "identifier": "app.markiro.station",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5273",
    "beforeDevCommand": "pnpm --filter @markiro/station dev",
    "beforeBuildCommand": "pnpm --filter @markiro/station build"
  },
  "app": {
    "windows": [
      {
        "title": "Markiro Station",
        "width": 1280,
        "height": 800,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": { "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'" }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.ico"]
  }
}
```

`apps/station/src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Station webview capabilities",
  "windows": ["main"],
  "permissions": ["core:default", "sql:default", "updater:default"]
}
```

> Note: no `icons/icon.ico` exists yet; generate a placeholder at execution with `pnpm --filter @markiro/station tauri icon` (or drop a 1024px PNG). The macOS dev host uses `nsis` only for the Windows bundle — a `tauri build` on macOS is not required in 05a (Windows installer is produced in CI, Task 13).

- [ ] **Step 11: Run the cargo smoke test**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`
Expected: PASS — `hello_greets_by_name` green. (First run compiles Tauri; allow several minutes.)

- [ ] **Step 12: Verify turbo picks up the new package and it typechecks/lints/builds**

Run: `pnpm turbo lint typecheck test build --filter=@markiro/station`
Expected: all four tasks PASS for `@markiro/station`.

- [ ] **Step 13: Commit**

```bash
git add apps/station pnpm-lock.yaml
git commit -m "feat(station): scaffold Tauri + React floor-mode app with i18n and smoke tests"
```

---

### Task 2: Rust core — secure config store (`station.json`, mode 0600, stable machineId)

**Files:**

- Create: `apps/station/src-tauri/src/config.rs`
- Modify: `apps/station/src-tauri/src/lib.rs` (register `config` module + `read_config`/`write_config` commands)
- Modify: `apps/station/src-tauri/src/commands.rs` (add the two Tauri command wrappers)

**Interfaces:**

- Consumes: `commands::hello` (Task 1); `tauri::Manager` (for `app_config_dir`).
- Produces:
  - `pub struct StationConfig { machine_id: String, tenant_id: Option<String>, device_id: Option<String>, api_key: Option<String>, server_url: Option<String> }` (serde).
  - `pub fn read_config(dir: &Path) -> Result<StationConfig, String>` (creates + persists a stable v4 `machine_id` on first read).
  - `pub fn write_config(dir: &Path, cfg: &StationConfig) -> Result<(), String>` (writes `station.json` at mode `0600` on unix).
  - `pub fn validate_http_url(url: &str) -> Result<(), String>` (http/https only, no userinfo — reused by Task 3).
  - Tauri commands `read_config`/`write_config` in `commands.rs`.

- [ ] **Step 1: Write `config.rs` with the struct, helpers, and failing unit tests**

`apps/station/src-tauri/src/config.rs`:

```rust
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Persisted station identity/enrollment state. Mirrors idento's
/// `agent_config.json` discipline: a stable machine id, plus enrollment
/// fields filled in once the device is enrolled (Task 8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StationConfig {
    pub machine_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
}

impl StationConfig {
    fn new_with_machine_id() -> Self {
        StationConfig {
            machine_id: Uuid::new_v4().to_string(),
            tenant_id: None,
            device_id: None,
            api_key: None,
            server_url: None,
        }
    }
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join("station.json")
}

/// Reads `station.json` from `dir`, minting + persisting a stable v4
/// `machine_id` on first run (so `machine_id` is never empty once assigned).
pub fn read_config(dir: &Path) -> Result<StationConfig, String> {
    let path = config_path(dir);
    if !path.exists() {
        let cfg = StationConfig::new_with_machine_id();
        write_config(dir, &cfg)?;
        return Ok(cfg);
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("Invalid station.json: {e}"))
}

/// Writes `station.json` atomically-ish (create dir, write, tighten perms).
/// On unix the file is forced to mode 0600 (owner read/write only); on
/// Windows the app-config dir is already per-user, so ACLs govern access.
pub fn write_config(dir: &Path, cfg: &StationConfig) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = config_path(dir);
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    set_owner_only(&path)?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Validates an operator-entered http(s) URL. Mirrors idento's
/// `build_agent_url` hardening: only http/https, and never any embedded
/// userinfo (a `user:pass@host` URL is a token-leak / SSRF vector).
pub fn validate_http_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("Invalid URL scheme: {}", parsed.scheme()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Invalid URL: userinfo not allowed".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("markiro-station-{}", Uuid::new_v4()))
    }

    #[test]
    fn read_config_mints_stable_machine_id_and_round_trips() {
        let dir = temp_dir();
        let first = read_config(&dir).expect("first read");
        assert!(!first.machine_id.is_empty());

        // Second read returns the SAME machine id (persisted, not regenerated).
        let second = read_config(&dir).expect("second read");
        assert_eq!(first.machine_id, second.machine_id);
    }

    #[test]
    fn write_then_read_preserves_enrollment_fields() {
        let dir = temp_dir();
        let mut cfg = read_config(&dir).unwrap();
        cfg.tenant_id = Some("org_1".into());
        cfg.device_id = Some("dev_1".into());
        cfg.api_key = Some("mk_secret".into());
        cfg.server_url = Some("https://api.markiro.app".into());
        write_config(&dir, &cfg).unwrap();

        let reloaded = read_config(&dir).unwrap();
        assert_eq!(reloaded, cfg);
    }

    #[cfg(unix)]
    #[test]
    fn written_config_is_owner_only_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let cfg = read_config(&dir).unwrap();
        write_config(&dir, &cfg).unwrap();
        let mode = fs::metadata(config_path(&dir)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn validate_http_url_accepts_https_and_rejects_scheme_and_userinfo() {
        assert!(validate_http_url("https://api.markiro.app/").is_ok());
        assert!(validate_http_url("http://127.0.0.1:3000/").is_ok());
        assert!(validate_http_url("ftp://api.markiro.app/").is_err());
        assert!(validate_http_url("https://user:pass@evil.example.com/").is_err());
        assert!(validate_http_url("not a url").is_err());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml config::`
Expected: FAIL — `config` module not declared in the crate (`lib.rs` does not yet `mod config;`).

- [ ] **Step 3: Register the module and add the Tauri command wrappers**

In `apps/station/src-tauri/src/lib.rs`, add `mod config;` under `mod commands;`, and register the new commands in `generate_handler!`:

```rust
mod commands;
mod config;
```

```rust
        .invoke_handler(tauri::generate_handler![
            commands::hello,
            commands::read_config,
            commands::write_config
        ])
```

Append to `apps/station/src-tauri/src/commands.rs` (above the `#[cfg(test)]` block):

```rust
use tauri::{AppHandle, Manager};

use crate::config::{self, StationConfig};

/// Reads the on-disk station config from the OS app-config dir, minting a
/// stable machine id on first run.
#[tauri::command]
pub fn read_config(app: AppHandle) -> Result<StationConfig, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    config::read_config(&dir)
}

/// Persists the station config (mode 0600 on unix). `server_url`, when set,
/// is validated as http(s) with no userinfo before the write is attempted.
#[tauri::command]
pub fn write_config(app: AppHandle, cfg: StationConfig) -> Result<(), String> {
    if let Some(url) = &cfg.server_url {
        config::validate_http_url(url)?;
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    config::write_config(&dir, &cfg)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml config::`
Expected: PASS — 4 tests on unix (3 on non-unix).

- [ ] **Step 5: Commit**

```bash
git add apps/station/src-tauri
git commit -m "feat(station): secure Rust config store with stable machineId and 0600 perms"
```

---

### Task 3: Rust core — kiosk lockdown + updater endpoint skeletons

**Files:**

- Modify: `apps/station/src-tauri/src/commands.rs` (add lockdown + updater-URL commands)
- Modify: `apps/station/src-tauri/src/lib.rs` (manage `LockdownState`, register commands, block close while locked)

**Interfaces:**

- Consumes: `config::validate_http_url` (Task 2).
- Produces:
  - `pub struct LockdownState(pub Mutex<bool>)`.
  - Tauri commands `enter_lockdown`, `exit_lockdown` (fullscreen / undecorated / always-on-top / skip-taskbar; close blocked at the OS-event level).
  - `pub fn validate_endpoint_url(url: &str) -> Result<(), String>` + Tauri command `set_update_endpoint` wrapping it (updater skeleton — no network in 05a).

- [ ] **Step 1: Write the failing unit test for the updater-URL validator**

Append to `apps/station/src-tauri/src/commands.rs` `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn validate_endpoint_url_enforces_http_scheme_and_no_userinfo() {
        assert!(validate_endpoint_url("https://releases.markiro.app/station/{{target}}").is_err());
        assert!(validate_endpoint_url("https://releases.markiro.app/station/latest.json").is_ok());
        assert!(validate_endpoint_url("ftp://releases.markiro.app/x").is_err());
        assert!(validate_endpoint_url("https://user:pass@evil.example.com/x").is_err());
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml validate_endpoint_url`
Expected: FAIL — `validate_endpoint_url` not defined.

- [ ] **Step 3: Implement lockdown state, commands, and the updater-URL validator**

Append to `apps/station/src-tauri/src/commands.rs` (above the test module):

```rust
use std::sync::Mutex;

use tauri::State;

/// Whether the main window is in kiosk lockdown. Read by the window-close
/// guard in `lib.rs` to decide whether to `prevent_close()`.
#[derive(Default)]
pub struct LockdownState(pub Mutex<bool>);

/// Engages kiosk lockdown on the main window: fullscreen, no decorations,
/// always-on-top, hidden from the taskbar/dock. Idempotent. Mirrors idento's
/// `enter_lockdown`. Window close is additionally blocked at the OS-event
/// level (see `lib.rs`), not just via `set_closable` (which has a documented
/// Linux caveat).
#[tauri::command]
pub fn enter_lockdown(app: AppHandle, state: State<'_, LockdownState>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No main window".to_string())?;
    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    window.set_decorations(false).map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window.set_skip_taskbar(true).map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}

/// Reverses `enter_lockdown`. Attempts all restorations regardless of any
/// individual failure (a `?`-chain would leave the window half-locked) and
/// clears the flag unconditionally so an operator can never be trapped;
/// per-property errors are still surfaced for diagnostics.
#[tauri::command]
pub fn exit_lockdown(app: AppHandle, state: State<'_, LockdownState>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No main window".to_string())?;
    let mut errors = Vec::new();
    if let Err(e) = window.set_skip_taskbar(false) {
        errors.push(e.to_string());
    }
    if let Err(e) = window.set_always_on_top(false) {
        errors.push(e.to_string());
    }
    if let Err(e) = window.set_decorations(true) {
        errors.push(e.to_string());
    }
    if let Err(e) = window.set_fullscreen(false) {
        errors.push(e.to_string());
    }
    *state.0.lock().map_err(|e| e.to_string())? = false;
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Validates an operator-entered updater endpoint URL before it is handed to
/// the Tauri updater (05b wires the actual check/install). Same discipline as
/// the config `server_url`: http/https only, no userinfo.
pub fn validate_endpoint_url(url: &str) -> Result<(), String> {
    crate::config::validate_http_url(url)
}

/// Updater skeleton: validates + records the endpoint override in memory.
/// The real check/download/install lands in 05b's updater task.
#[tauri::command]
pub fn set_update_endpoint(url: String) -> Result<(), String> {
    validate_endpoint_url(&url)
}
```

- [ ] **Step 4: Manage `LockdownState` and block close while locked in `lib.rs`**

Modify `apps/station/src-tauri/src/lib.rs`'s `run()` to add `.manage(...)`, an `on_window_event` close guard, and register the new commands:

```rust
    tauri::Builder::default()
        .manage(commands::LockdownState::default())
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let locked = window
                    .state::<commands::LockdownState>()
                    .0
                    .lock()
                    .map(|g| *g)
                    .unwrap_or(false);
                if locked {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::hello,
            commands::read_config,
            commands::write_config,
            commands::enter_lockdown,
            commands::exit_lockdown,
            commands::set_update_endpoint
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro station");
```

(`use tauri::Manager;` is needed for `window.state::<...>()` — add it near the top of `lib.rs`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`
Expected: PASS — all `commands`/`config` tests green. (Window effects are not unit-tested; only the pure URL validator is.)

- [ ] **Step 6: Commit**

```bash
git add apps/station/src-tauri
git commit -m "feat(station): kiosk lockdown commands and updater endpoint validator skeleton"
```

---

### Task 4: `packages/db` — SQLite mirror schema + `STATION_MIGRATIONS`

**Files:**

- Create: `packages/db/src/sqlite/schema.ts` (drizzle sqlite-core tables + `OperatorMirrorRecord` type)
- Create: `packages/db/src/sqlite/migrations.ts` (`STATION_MIGRATIONS: string[]`)
- Create: `packages/db/drizzle.sqlite.config.ts` (sqlite generate config, for regeneration parity)
- Modify: `packages/db/src/index.ts` (re-export the sqlite module)
- Modify: `packages/db/package.json` (add `db:generate:sqlite` script)
- Modify: `packages/db/vitest.config.ts` (pass `--experimental-sqlite` to test forks)
- Test: `packages/db/test/sqlite-schema.test.ts`

**Interfaces:**

- Consumes: nothing (leaf schema module).
- Produces:
  - drizzle sqlite tables `stationMeta`, `operatorsMirror`, `shiftMirror`, `productMirror`, `codesMirror`, `scanEventsMirror` (exported from `@markiro/db` under `sqliteSchema`).
  - `export interface OperatorMirrorRecord { operatorId: string; name: string; role: string; pinHash: string; badgeHash: string | null; active: boolean }`.
  - `export const STATION_MIGRATIONS: string[]` — ordered raw DDL strings the Tauri app applies at startup (Task 9).

- [ ] **Step 1: Write the sqlite schema module**

`packages/db/src/sqlite/schema.ts`:

```ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Station-local key/value metadata (e.g. current terminal id, last sync). */
export const stationMeta = sqliteTable("station_meta", {
  key: text("key").primaryKey(),
  value: text("value"),
});

/**
 * Local mirror of operators for OFFLINE PIN/badge login. Seeded from the
 * shift bundle (Task 9); the credential columns hold PBKDF2 PHC verifiers
 * (see the credential-hash contract). The server operators table is a
 * PARALLEL workstream (05b) — 05a only ever reads/writes this local mirror.
 */
export const operatorsMirror = sqliteTable("operators_mirror", {
  operatorId: text("operator_id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  pinHash: text("pin_hash").notNull(),
  badgeHash: text("badge_hash"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

/** Local mirror of the downloaded shift, incl. the label template spec json. */
export const shiftMirror = sqliteTable("shift_mirror", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  mode: text("mode").notNull(),
  productId: text("product_id").notNull(),
  productName: text("product_name"),
  lineId: text("line_id"),
  lineName: text("line_name"),
  counterpartyId: text("counterparty_id"),
  counterpartyName: text("counterparty_name"),
  counterpartyGln: text("counterparty_gln"),
  labelTemplateId: text("label_template_id"),
  labelTemplateName: text("label_template_name"),
  labelTemplateSpec: text("label_template_spec"),
  plannedQty: integer("planned_qty"),
  plannedDate: text("planned_date"),
  boxCapacity: integer("box_capacity"),
  palletCapacity: integer("pallet_capacity"),
  palletsEnabled: integer("pallets_enabled", { mode: "boolean" }).notNull().default(false),
  openedAt: text("opened_at"),
});

/** Local mirror of the shift's product (for ad-hoc GTIN resolution offline). */
export const productMirror = sqliteTable("product_mirror", {
  id: text("id").primaryKey(),
  gtin14: text("gtin14").notNull(),
  name: text("name").notNull(),
  productGroup: text("product_group"),
  boxCapacity: integer("box_capacity"),
  palletCapacity: integer("pallet_capacity"),
  status: text("status").notNull(),
  defaultCounterpartyId: text("default_counterparty_id"),
  defaultLabelTemplateId: text("default_label_template_id"),
});

/**
 * Local journal mirror of server `codes` (05b writes here; 05a only defines
 * the schema). Columns mirror packages/db/src/schema/codes.ts.
 */
export const codesMirror = sqliteTable("codes_mirror", {
  codeHash: text("code_hash").primaryKey(),
  shiftId: text("shift_id").notNull(),
  gtin14: text("gtin14").notNull(),
  serial: text("serial").notNull(),
  scannedAt: text("scanned_at").notNull(),
});

/** Local journal mirror of server `scan_events` (05b writes here). */
export const scanEventsMirror = sqliteTable("scan_events_mirror", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shiftId: text("shift_id").notNull(),
  terminalId: text("terminal_id"),
  raw: text("raw").notNull(),
  verdict: text("verdict").notNull(),
  scannedAt: text("scanned_at").notNull(),
});

/**
 * A local operator record after offline hydration. `pinHash`/`badgeHash` are
 * PBKDF2 PHC verifiers (see the credential-hash contract). This is the exact
 * shape the server station-bundle `operators` field will carry in 05b — in
 * 05a that field is MOCKED as `[]`.
 */
export interface OperatorMirrorRecord {
  operatorId: string;
  name: string;
  role: string;
  pinHash: string;
  badgeHash: string | null;
  active: boolean;
}
```

- [ ] **Step 2: Write `STATION_MIGRATIONS` (authoritative raw DDL)**

`packages/db/src/sqlite/migrations.ts`:

```ts
/**
 * Ordered SQLite DDL applied by the station at startup (Task 9) via
 * tauri-plugin-sql. This array is the source of truth for the on-device
 * schema and MUST stay in sync with ./schema.ts; the sqlite-schema test
 * (test/sqlite-schema.test.ts) applies these and round-trips a row to catch
 * drift. `drizzle.sqlite.config.ts` exists for regeneration parity only.
 */
export const STATION_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS station_meta (
     key TEXT PRIMARY KEY,
     value TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS operators_mirror (
     operator_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     role TEXT NOT NULL,
     pin_hash TEXT NOT NULL,
     badge_hash TEXT,
     active INTEGER NOT NULL DEFAULT 1
   );`,
  `CREATE TABLE IF NOT EXISTS shift_mirror (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     mode TEXT NOT NULL,
     product_id TEXT NOT NULL,
     product_name TEXT,
     line_id TEXT,
     line_name TEXT,
     counterparty_id TEXT,
     counterparty_name TEXT,
     counterparty_gln TEXT,
     label_template_id TEXT,
     label_template_name TEXT,
     label_template_spec TEXT,
     planned_qty INTEGER,
     planned_date TEXT,
     box_capacity INTEGER,
     pallet_capacity INTEGER,
     pallets_enabled INTEGER NOT NULL DEFAULT 0,
     opened_at TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS product_mirror (
     id TEXT PRIMARY KEY,
     gtin14 TEXT NOT NULL,
     name TEXT NOT NULL,
     product_group TEXT,
     box_capacity INTEGER,
     pallet_capacity INTEGER,
     status TEXT NOT NULL,
     default_counterparty_id TEXT,
     default_label_template_id TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS codes_mirror (
     code_hash TEXT PRIMARY KEY,
     shift_id TEXT NOT NULL,
     gtin14 TEXT NOT NULL,
     serial TEXT NOT NULL,
     scanned_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS scan_events_mirror (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     shift_id TEXT NOT NULL,
     terminal_id TEXT,
     raw TEXT NOT NULL,
     verdict TEXT NOT NULL,
     scanned_at TEXT NOT NULL
   );`,
];
```

- [ ] **Step 3: Add the drizzle-kit sqlite config + re-exports + scripts**

`packages/db/drizzle.sqlite.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

// Regeneration parity only: STATION_MIGRATIONS (src/sqlite/migrations.ts) is
// the authoritative on-device DDL. Run `pnpm --filter @markiro/db
// db:generate:sqlite` to diff the schema against generated SQL when changing
// src/sqlite/schema.ts.
export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/sqlite/schema.ts"],
  out: "./migrations-sqlite",
});
```

Modify `packages/db/src/index.ts` — append:

```ts
export * as sqliteSchema from "./sqlite/schema.js";
export { STATION_MIGRATIONS } from "./sqlite/migrations.js";
export type { OperatorMirrorRecord } from "./sqlite/schema.js";
```

Modify `packages/db/package.json` `scripts` — add:

```json
    "db:generate:sqlite": "drizzle-kit generate --config drizzle.sqlite.config.ts",
```

- [ ] **Step 4: Allow `node:sqlite` in vitest forks**

Modify `packages/db/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Node 24 ships `node:sqlite` as an experimental built-in; the flag marks
    // it usable in the test worker forks (no better-sqlite3 dependency).
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
});
```

- [ ] **Step 5: Write the failing `node:sqlite` schema test**

`packages/db/test/sqlite-schema.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const stmt of STATION_MIGRATIONS) db.exec(stmt);
  return db;
}

describe("STATION_MIGRATIONS", () => {
  it("creates all six mirror tables", () => {
    const db = migratedDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain("station_meta");
    expect(names).toContain("operators_mirror");
    expect(names).toContain("shift_mirror");
    expect(names).toContain("product_mirror");
    expect(names).toContain("codes_mirror");
    expect(names).toContain("scan_events_mirror");
  });

  it("round-trips an operators_mirror row with a nullable badge_hash", () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO operators_mirror (operator_id, name, role, pin_hash, badge_hash, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("op_1", "Ivan", "operator", "pbkdf2$sha256$100000$c2FsdA==$aGFzaA==", null, 1);

    const row = db
      .prepare(
        "SELECT operator_id, name, badge_hash, active FROM operators_mirror WHERE operator_id = ?",
      )
      .get("op_1") as {
      operator_id: string;
      name: string;
      badge_hash: string | null;
      active: number;
    };

    expect(row).toEqual({ operator_id: "op_1", name: "Ivan", badge_hash: null, active: 1 });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @markiro/db test -- sqlite-schema`
Expected: FAIL — `Cannot find module '../src/sqlite/migrations.js'` until the module is built/resolved, OR the schema assertions fail if run before Step 1–2 land.

- [ ] **Step 7: Run the full db test suite to verify it passes**

Run: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db test`
Expected: PASS — the new sqlite-schema test green alongside the existing Postgres tests. (Ensure `docker compose -f docker-compose.dev.yml up -d` has been run; never `down`.)

- [ ] **Step 8: Typecheck the db package**

Run: `pnpm --filter @markiro/db typecheck`
Expected: PASS — new sqlite modules compile.

- [ ] **Step 9: Commit**

```bash
git add packages/db
git commit -m "feat(db): SQLite station mirror schema and STATION_MIGRATIONS with node:sqlite tests"
```

---

### Task 5: Server — extend `TenantGuard` to accept station api-key auth

**Files:**

- Modify: `packages/db/src/auth-config.ts` (add `verifyApiKey`/`createApiKey` to the `Auth` companion type)
- Modify: `apps/api/src/tenancy/tenant.guard.ts` (api-key fallback path)
- Modify: `apps/api/test/tenant.guard.test.ts` (unit tests for the api-key path)
- Test: `apps/api/test/station-auth.e2e.test.ts`

**Interfaces:**

- Consumes: `Auth` (`@markiro/db`), existing `TenantGuard` session path.
- Produces:
  - `Auth["api"].verifyApiKey({ body: { key } })` and `Auth["api"].createApiKey({ body: { configId?, name?, userId?, organizationId?, metadata? } })` typed on the companion `Auth` type.
  - `TenantGuard` resolves `req.tenantId` from a verified `x-api-key` when no session is present (Tasks 6–8 rely on this).

- [ ] **Step 1: Extend the `Auth` companion type with the api-key methods**

Modify `packages/db/src/auth-config.ts` — replace the `Auth` type block with:

```ts
/** Result of an api-key verification (apiKey plugin). */
export interface VerifyApiKeyResult {
  valid: boolean;
  error: { message: string; code: string } | null;
  key: { id: string; referenceId: string; enabled: boolean | null } | null;
}

/** Minimal created-api-key shape (apiKey plugin) used by device enrollment. */
export interface CreatedApiKey {
  id: string;
  key: string;
  referenceId: string;
}

export type Auth = Omit<AuthBase, "api"> & {
  api: Omit<AuthBase["api"], "getSession"> & {
    getSession(input: { headers: Headers }): Promise<SessionWithActiveOrg | null>;
    verifyApiKey(input: { body: { key: string } }): Promise<VerifyApiKeyResult>;
    createApiKey(input: {
      body: {
        configId?: string;
        name?: string;
        userId?: string;
        organizationId?: string;
        metadata?: Record<string, unknown>;
      };
    }): Promise<CreatedApiKey>;
  };
};
```

Then reconfigure the `apiKey` plugin in `packages/db/src/auth-config.ts` for organization-owned station keys — change `plugins: [organization(), apiKey()]` to:

```ts
plugins: [
  organization(),
  apiKey([{ configId: "station", defaultPrefix: "mk_", references: "organization" }]),
],
```

This is additive (nothing issues api-keys before 05a) and does not alter the `apikey` table columns (`reference_id` already exists); the org config only changes what `reference_id` points at. Note in the task report if the plugin's array form needs a global-options second argument for this repo's schema.

- [ ] **Step 2: Add failing unit tests for the api-key path**

Append to `apps/api/test/tenant.guard.test.ts`. Extend `fakeAuth` and add cases:

```ts
function fakeAuthWithApiKey(
  getSession: Auth["api"]["getSession"],
  verifyApiKey: Auth["api"]["verifyApiKey"],
): Auth {
  return { api: { getSession, verifyApiKey } } as unknown as Auth;
}

describe("TenantGuard api-key path", () => {
  it("resolves tenantId from a valid x-api-key when there is no session", async () => {
    const guard = new TenantGuard(
      fakeAuthWithApiKey(
        async () => null,
        async () => ({
          valid: true,
          error: null,
          key: { id: "key_1", referenceId: "org_9", enabled: true },
        }),
      ),
    );
    const req: FakeRequest = { headers: { "x-api-key": "mk_valid" } };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.tenantId).toBe("org_9");
  });

  it("throws Unauthorized for an invalid x-api-key and no session", async () => {
    const guard = new TenantGuard(
      fakeAuthWithApiKey(
        async () => null,
        async () => ({ valid: false, error: { message: "bad", code: "INVALID" }, key: null }),
      ),
    );
    const req: FakeRequest = { headers: { "x-api-key": "mk_bad" } };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/api test -- tenant.guard`
Expected: FAIL — guard ignores `x-api-key` (`req.tenantId` stays undefined / throws Unauthorized on the valid-key case).

- [ ] **Step 4: Implement the api-key fallback in the guard**

Replace the body of `TenantGuard.canActivate` in `apps/api/src/tenancy/tenant.guard.ts`:

```ts
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithTenant>();

    // Primary path: an admin/manager Better Auth session with an active org.
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (session) {
      const tenantId = session.session.activeOrganizationId;
      if (!tenantId) throw new ForbiddenException("No active organization");
      req.tenantId = tenantId;
      // Enrollment (Task 6) mints an org-owned key server-side and needs the
      // acting member's id as the key's `userId`; expose it on the request.
      req.userId = session.user.id;
      return true;
    }

    // Station path: no session, but a device-enrolled api-key. The key's
    // referenceId carries the tenantId (set at enrollment, Task 6).
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.length > 0) {
      const result = await this.auth.api.verifyApiKey({ body: { key: apiKey } });
      if (result.valid && result.key) {
        req.tenantId = result.key.referenceId;
        return true;
      }
    }

    throw new UnauthorizedException();
  }
```

Also add `userId?: string;` to the `RequestWithTenant` interface in the same file (alongside the existing `tenantId?`), so `req.userId = session.user.id` typechecks and Task 6's enrollment controller can read it.

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `pnpm --filter @markiro/api test -- tenant.guard`
Expected: PASS — session path unchanged, api-key path resolves/rejects correctly.

- [ ] **Step 6: Write the e2e test proving api-key auth end-to-end**

`apps/api/test/station-auth.e2e.test.ts` (mirror the `beforeAll`/`signUpAndActivate` boilerplate from `shifts.e2e.test.ts`):

```ts
import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station api-key auth e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpAndActivate(
    agent: ReturnType<typeof request.agent>,
  ): Promise<{ orgId: string; userId: string }> {
    const email = `t-${randomUUID()}@example.com`;
    const signUp = await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "Passw0rd!123", name: "T" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Plant", slug: `plant-${randomUUID()}`, keepCurrentActiveOrganization: true })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    // The sign-up user is the org owner (always permitted to create org keys).
    // Better Auth's sign-up/email returns the created user; if the body shape
    // differs, read it from GET /api/auth/get-session instead.
    return { orgId: org.body.id as string, userId: signUp.body.user.id as string };
  }

  it("an org-owned station api-key (referenceId = tenantId) resolves the tenant with no session", async () => {
    const { orgId, userId } = await signUpAndActivate(request.agent(app!.getHttpServer()));
    // Mint an ORG-owned key (referenceId = orgId) exactly as Task 6 enrollment does.
    const created = await setup.auth.api.createApiKey({
      body: { configId: "station", organizationId: orgId, userId, name: "station" },
    });

    // A fresh (session-less) client authenticates purely by x-api-key.
    await request(app!.getHttpServer()).get("/shifts").set("x-api-key", created.key).expect(200);
  });

  it("a bad api-key and no session -> 401", async () => {
    await request(app!.getHttpServer()).get("/shifts").set("x-api-key", "mk_not_real").expect(401);
  });

  it("no auth at all -> 401", async () => {
    await request(app!.getHttpServer()).get("/shifts").expect(401);
  });
});
```

- [ ] **Step 7: Run the e2e test to verify it passes**

Run: `docker compose -f docker-compose.dev.yml up -d && DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/db db:migrate && DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/api test -- station-auth`
Expected: PASS — the org-owned key's `referenceId` equals the org id, so the guard resolves the tenant. If `createApiKey`/`verifyApiKey` behave differently than documented (e.g. `configId` is required on verify, or the org member lacks `apiKey:create` permission), switch to the documented alternative in decision #3 (plain user-owned key + `station_devices` lookup by `key.id` in the guard) — record the chosen path in the task report.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/auth-config.ts apps/api/src/tenancy/tenant.guard.ts apps/api/test/tenant.guard.test.ts apps/api/test/station-auth.e2e.test.ts
git commit -m "feat(api): accept station x-api-key auth in TenantGuard via referenceId tenant scoping"
```

---

### Task 6: Server — `station_devices` table + enrollment endpoints

**Files:**

- Modify: `packages/db/src/schema/platform.ts` (add `stationDevices` table)
- Create: `packages/db/migrations/0008_station_devices.sql` (generated)
- Create: `apps/api/src/modules/station-devices/dto.ts`
- Create: `apps/api/src/modules/station-devices/station-devices.service.ts`
- Create: `apps/api/src/modules/station-devices/station-devices.controller.ts`
- Create: `apps/api/src/modules/station-devices/station-devices.module.ts`
- Modify: `apps/api/src/app.module.ts` (register `StationDevicesModule`)
- Test: `apps/api/test/station-devices.e2e.test.ts`

**Interfaces:**

- Consumes: `TenantGuard` (Task 5); `Auth.createApiKey` (Task 5); `schema.stationDevices`, `schema.apikey`.
- Produces:
  - `stationDevices` table `(id, tenantId, name, apiKeyId, enrolledAt, lastSeenAt)` with `(tenant_id, id)` unique.
  - `POST /station-devices` → `{ deviceId, name, apiKey, serverUrl }` (plaintext key returned once).
  - `GET /station-devices` → `{ items: StationDeviceDto[] }`.
  - `DELETE /station-devices/:id` → 204 (deletes the device row and the underlying apikey row).

- [ ] **Step 1: Add the `stationDevices` table to the schema**

Append to `packages/db/src/schema/platform.ts` (after `shifts`):

```ts
export const stationDevices = pgTable(
  "station_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    // References better-auth's apikey.id (text). Not a composite tenant FK:
    // apikey is a Better Auth-managed table without a (tenant_id, id) unique.
    apiKeyId: text("api_key_id").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [unique("station_devices_tenant_id_uq").on(t.tenantId, t.id)],
);
```

- [ ] **Step 2: Generate the migration**

Run: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db db:generate`
Expected: creates `packages/db/migrations/0008_station_devices.sql` with `CREATE TABLE "station_devices" ...` and the unique constraint. **If a parallel operators migration already claimed `0008`, re-run generate so the new file gets the next contiguous number and note the rebase in the task report.**

- [ ] **Step 3: Write the DTOs**

`apps/api/src/modules/station-devices/dto.ts`:

```ts
import { z } from "zod";

/** POST /station-devices body. */
export const createStationDeviceSchema = z.object({
  name: z.string().min(1).max(200),
});
export type CreateStationDeviceDto = z.infer<typeof createStationDeviceSchema>;

/** A station device summary (never carries the plaintext key). */
export interface StationDeviceDto {
  id: string;
  name: string;
  enrolledAt: Date;
  lastSeenAt: Date | null;
}

/** POST /station-devices response — the plaintext apiKey is returned ONCE. */
export interface EnrollStationDeviceResponseDto {
  deviceId: string;
  name: string;
  apiKey: string;
  serverUrl: string;
}

/** GET /station-devices response. */
export interface ListStationDevicesResponseDto {
  items: StationDeviceDto[];
}
```

- [ ] **Step 4: Write the service**

`apps/api/src/modules/station-devices/station-devices.service.ts`:

```ts
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Auth, type Db } from "@markiro/db";
import { AUTH, DB } from "../../auth/auth.module";
import type {
  EnrollStationDeviceResponseDto,
  ListStationDevicesResponseDto,
  StationDeviceDto,
} from "./dto";

@Injectable()
export class StationDevicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  /**
   * Enroll a device: mint a Better Auth api-key whose referenceId is the
   * tenantId (so TenantGuard resolves the tenant from the key), then persist
   * a station_devices row pointing at that key. The plaintext key is returned
   * exactly once; it is never stored.
   */
  async enroll(
    tenantId: string,
    ownerUserId: string,
    name: string,
    serverUrl: string,
  ): Promise<EnrollStationDeviceResponseDto> {
    // Organization-owned key: referenceId = tenantId (plan decision #3). The
    // call is server-side with no session headers, so `userId` (the enrolling
    // member, e.g. the org owner) is required; the org config makes the key
    // owned by the tenant, not that user.
    const key = await this.auth.api.createApiKey({
      body: {
        configId: "station",
        organizationId: tenantId,
        userId: ownerUserId,
        name,
        metadata: { kind: "station" },
      },
    });

    const [row] = await this.db
      .insert(schema.stationDevices)
      .values({ tenantId, name, apiKeyId: key.id })
      .returning();
    if (!row) throw new InternalServerErrorException("Failed to enroll device");

    return { deviceId: row.id, name: row.name, apiKey: key.key, serverUrl };
  }

  async list(tenantId: string): Promise<ListStationDevicesResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.tenantId, tenantId))
      .orderBy(desc(schema.stationDevices.enrolledAt));
    return { items: rows.map((r) => this.rowToDto(r)) };
  }

  /** Revoke: delete the device row AND the underlying apikey row. */
  async revoke(tenantId: string, id: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(schema.stationDevices)
      .where(and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)));
    if (!row) throw new NotFoundException();

    await this.db
      .delete(schema.stationDevices)
      .where(and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)));
    await this.db.delete(schema.apikey).where(eq(schema.apikey.id, row.apiKeyId));
  }

  private rowToDto(row: typeof schema.stationDevices.$inferSelect): StationDeviceDto {
    return { id: row.id, name: row.name, enrolledAt: row.enrolledAt, lastSeenAt: row.lastSeenAt };
  }
}
```

- [ ] **Step 5: Write the controller + module**

`apps/api/src/modules/station-devices/station-devices.controller.ts`:

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { loadEnv } from "../../env";
import {
  createStationDeviceSchema,
  type CreateStationDeviceDto,
  type EnrollStationDeviceResponseDto,
  type ListStationDevicesResponseDto,
} from "./dto";
import { StationDevicesService } from "./station-devices.service";

@ApiTags("station-devices")
@Controller("station-devices")
@UseGuards(TenantGuard)
export class StationDevicesController {
  constructor(private readonly service: StationDevicesService) {}

  @Get()
  async list(@Req() req: RequestWithTenant): Promise<ListStationDevicesResponseDto> {
    return this.service.list(req.tenantId!);
  }

  @Post()
  async enroll(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createStationDeviceSchema)) body: CreateStationDeviceDto,
  ): Promise<EnrollStationDeviceResponseDto> {
    // The station will call back at this same origin; BETTER_AUTH_URL is the
    // canonical public API base handed to the device to persist as serverUrl.
    // req.userId (the enrolling member) owns the minted org-scoped key.
    return this.service.enroll(req.tenantId!, req.userId!, body.name, loadEnv().BETTER_AUTH_URL);
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.service.revoke(req.tenantId!, id);
  }
}
```

`apps/api/src/modules/station-devices/station-devices.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { StationDevicesController } from "./station-devices.controller";
import { StationDevicesService } from "./station-devices.service";

@Module({
  controllers: [StationDevicesController],
  providers: [StationDevicesService],
})
export class StationDevicesModule {}
```

Register in `apps/api/src/app.module.ts` — import and add `StationDevicesModule` to the `imports` array.

- [ ] **Step 6: Write the failing e2e test**

`apps/api/test/station-devices.e2e.test.ts` (reuse the `beforeAll`/`signUpAndActivate` harness from Task 5's e2e):

```ts
it("enroll -> list -> delete, cross-tenant isolation", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);

  const enroll = await agent.post("/station-devices").send({ name: "Terminal 1" }).expect(201);
  expect(enroll.body).toMatchObject({ name: "Terminal 1" });
  expect(typeof enroll.body.apiKey).toBe("string");
  expect(enroll.body.serverUrl).toBe("http://localhost:3000");
  const deviceId = enroll.body.deviceId as string;

  // The freshly issued key authenticates a session-less station request.
  await request(app!.getHttpServer())
    .get("/shifts")
    .set("x-api-key", enroll.body.apiKey)
    .expect(200);

  const list = await agent.get("/station-devices").expect(200);
  expect(list.body.items.map((d: { id: string }) => d.id)).toContain(deviceId);
  expect(list.body.items[0]).not.toHaveProperty("apiKey");

  // Another tenant cannot delete this device.
  const other = request.agent(app!.getHttpServer());
  await signUpAndActivate(other);
  await other.delete(`/station-devices/${deviceId}`).expect(404);

  // Owner deletes it; the key stops working afterward.
  await agent.delete(`/station-devices/${deviceId}`).expect(204);
  await request(app!.getHttpServer())
    .get("/shifts")
    .set("x-api-key", enroll.body.apiKey)
    .expect(401);
});
```

- [ ] **Step 7: Migrate + run the e2e to verify pass**

Run: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/db db:migrate && DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/api test -- station-devices`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/platform.ts packages/db/migrations/0008_station_devices.sql packages/db/migrations/meta apps/api/src/modules/station-devices apps/api/src/app.module.ts apps/api/test/station-devices.e2e.test.ts
git commit -m "feat(api): station device enrollment endpoints issuing tenant-scoped api-keys"
```

---

### Task 7: Server — shift `open` endpoint + station `bundle` GET

**Files:**

- Modify: `apps/api/src/modules/shifts/dto.ts` (add `ShiftBundleDto`, `OperatorMirrorRecord`)
- Modify: `apps/api/src/modules/shifts/shifts.service.ts` (add `openShift`, `getBundle`)
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts` (add `POST /:id/open`, `GET /:id/bundle`)
- Test: `apps/api/test/shifts-bundle.e2e.test.ts`

**Interfaces:**

- Consumes: `TenantGuard` (station key OR session); `ShiftDto`, `ProductDto` (`../products/dto`); `LabelTemplateSpec` (`@markiro/domain`); `schema.products`, `schema.counterparties`, `schema.labelTemplates`.
- Produces:
  - `POST /shifts/:id/open` → `ShiftDto` (planned→active, sets `openedAt`; 409 if not planned; 404 cross-tenant).
  - `GET /shifts/:id/bundle` → `ShiftBundleDto { shift, product, labelTemplate|null, counterpartyGln|null, operators: OperatorMirrorRecord[] }` (`operators` is `[]` in 05a).

- [ ] **Step 1: Add the bundle DTO types**

Append to `apps/api/src/modules/shifts/dto.ts`:

```ts
import type { LabelTemplateSpec } from "@markiro/domain";
import type { ProductDto } from "../products/dto";

/**
 * A station-local operator record. In 05a the bundle returns `[]` for
 * `operators` (the server operators table is a PARALLEL 05b workstream); this
 * type pins the shape the station will hydrate into `operators_mirror`.
 */
export interface OperatorMirrorRecord {
  operatorId: string;
  name: string;
  role: string;
  pinHash: string;
  badgeHash: string | null;
  active: boolean;
}

/** GET /shifts/:id/bundle response — everything the station downloads offline. */
export interface ShiftBundleDto {
  shift: ShiftDto;
  product: ProductDto;
  labelTemplate: { id: string; name: string; spec: LabelTemplateSpec } | null;
  counterpartyGln: string | null;
  operators: OperatorMirrorRecord[];
}
```

- [ ] **Step 2: Add failing e2e coverage for `open` + `bundle`**

`apps/api/test/shifts-bundle.e2e.test.ts` (reuse the harness + `seedProduct`/`seedLabelTemplate`/`seedCounterparty` helpers from `shifts.e2e.test.ts`):

```ts
it("POST /shifts/:id/open flips planned->active and sets openedAt; 409 if not planned", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpAndActivate(agent);
  const productId = await seedProduct(orgId, {
    status: "active",
    productGroup: "Beverages",
    boxCapacity: 12,
    palletCapacity: 48,
  });
  const created = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
  const id = created.body.id as string;

  const opened = await agent.post(`/shifts/${id}/open`).expect(200);
  expect(opened.body).toMatchObject({ id, status: "active" });
  expect(opened.body.openedAt).toBeDefined();

  // Re-open once active -> 409.
  await agent.post(`/shifts/${id}/open`).expect(409);
});

it("GET /shifts/:id/bundle returns shift+product+labelTemplate+counterpartyGln and operators=[]", async () => {
  const agent = request.agent(app!.getHttpServer());
  const orgId = await signUpAndActivate(agent);
  const counterpartyId = await seedCounterparty(orgId, "Buyer");
  const templateId = await seedLabelTemplate(orgId, "Bundle Template");
  const productId = await seedProduct(orgId, {
    status: "active",
    productGroup: "Beverages",
    boxCapacity: 12,
    palletCapacity: 48,
    defaultCounterpartyId: counterpartyId,
    defaultLabelTemplateId: templateId,
  });
  const created = await agent.post("/shifts").send({ productId, mode: "aggregation" }).expect(201);
  const id = created.body.id as string;

  const bundle = await agent.get(`/shifts/${id}/bundle`).expect(200);
  expect(bundle.body.shift).toMatchObject({ id, productId });
  expect(bundle.body.product).toMatchObject({ id: productId, gtin14: expect.any(String) });
  expect(bundle.body.labelTemplate).toMatchObject({ id: templateId, name: "Bundle Template" });
  expect(bundle.body.labelTemplate.spec).toMatchObject({ language: "zpl" });
  expect(bundle.body.counterpartyGln).toBe("6291041500213");
  expect(bundle.body.operators).toEqual([]);
});

it("GET /shifts/:id/bundle is 404 for another tenant's shift", async () => {
  const a1 = request.agent(app!.getHttpServer());
  const org1 = await signUpAndActivate(a1);
  const productId = await seedProduct(org1, {
    status: "active",
    productGroup: "Beverages",
    boxCapacity: 12,
    palletCapacity: 48,
  });
  const created = await a1.post("/shifts").send({ productId, mode: "validation" }).expect(201);
  const a2 = request.agent(app!.getHttpServer());
  await signUpAndActivate(a2);
  await a2.get(`/shifts/${created.body.id}/bundle`).expect(404);
});
```

- [ ] **Step 3: Run the e2e to verify it fails**

Run: `DATABASE_URL=... BETTER_AUTH_SECRET=... BETTER_AUTH_URL=... ADMIN_ORIGIN=... pnpm --filter @markiro/api test -- shifts-bundle`
Expected: FAIL — 404 on `/open` and `/bundle` (routes not defined).

- [ ] **Step 4: Implement `openShift` and `getBundle` in the service**

Append to `ShiftsService` in `apps/api/src/modules/shifts/shifts.service.ts` (add imports for `LabelTemplateSpec` and the bundle/product DTO types):

```ts
  /** Open a planned shift: planned -> active, stamps openedAt. 409 otherwise. */
  async openShift(tenantId: string, id: string): Promise<ShiftDto> {
    const current = await this.findRow(tenantId, id);
    if (!current) throw new NotFoundException();
    if (current.status !== "planned") {
      throw new ConflictException("Shift can only be opened while planned");
    }
    const [row] = await this.db
      .update(schema.shifts)
      .set({ status: "active", openedAt: new Date() })
      .where(
        and(
          eq(schema.shifts.tenantId, tenantId),
          eq(schema.shifts.id, id),
          eq(schema.shifts.status, "planned"),
        ),
      )
      .returning();
    if (!row) throw new ConflictException("Shift can only be opened while planned");
    return this.getShift(tenantId, row.id);
  }

  /**
   * Everything the station downloads for a shift. `operators` is `[]` in 05a
   * (the server operators table is a PARALLEL 05b workstream — do NOT query a
   * non-existent table).
   */
  async getBundle(tenantId: string, id: string): Promise<ShiftBundleDto> {
    const shift = await this.getShift(tenantId, id); // 404 if cross-tenant/missing

    const productRow = await this.findProductRow(tenantId, shift.productId);
    if (!productRow) throw new NotFoundException("Shift product missing");
    const product: ProductDto = {
      id: productRow.id,
      gtin14: productRow.gtin14,
      name: productRow.name,
      productGroup: productRow.productGroup,
      boxCapacity: productRow.boxCapacity,
      palletCapacity: productRow.palletCapacity,
      status: productRow.status,
      defaultCounterpartyId: productRow.defaultCounterpartyId,
      defaultLabelTemplateId: productRow.defaultLabelTemplateId,
      createdAt: productRow.createdAt,
    };

    let labelTemplate: ShiftBundleDto["labelTemplate"] = null;
    if (shift.labelTemplateId) {
      const [lt] = await this.db
        .select()
        .from(schema.labelTemplates)
        .where(
          and(
            eq(schema.labelTemplates.tenantId, tenantId),
            eq(schema.labelTemplates.id, shift.labelTemplateId),
          ),
        );
      if (lt) labelTemplate = { id: lt.id, name: lt.name, spec: lt.spec as LabelTemplateSpec };
    }

    let counterpartyGln: string | null = null;
    if (shift.counterpartyId) {
      const [cp] = await this.db
        .select()
        .from(schema.counterparties)
        .where(
          and(
            eq(schema.counterparties.tenantId, tenantId),
            eq(schema.counterparties.id, shift.counterpartyId),
          ),
        );
      counterpartyGln = cp ? cp.gln : null;
    }

    // TODO(05b): populate from the server operators table (parallel workstream).
    const operators: OperatorMirrorRecord[] = [];

    return { shift, product, labelTemplate, counterpartyGln, operators };
  }
```

Add to the type imports at the top of the file:

```ts
import type { LabelTemplateSpec } from "@markiro/domain";
import type { ProductDto } from "../products/dto";
```

and extend the `./dto` import to include `ShiftBundleDto` and `OperatorMirrorRecord`.

- [ ] **Step 5: Add the controller routes**

Append to `ShiftsController` in `apps/api/src/modules/shifts/shifts.controller.ts` (import `ShiftBundleDto`):

```ts
  @Post(":id/open")
  @HttpCode(200)
  async openShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftDto> {
    return this.shiftsService.openShift(req.tenantId!, id);
  }

  @Get(":id/bundle")
  async getBundle(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftBundleDto> {
    return this.shiftsService.getBundle(req.tenantId!, id);
  }
```

- [ ] **Step 6: Run the e2e to verify it passes**

Run: `DATABASE_URL=... BETTER_AUTH_SECRET=... BETTER_AUTH_URL=... ADMIN_ORIGIN=... pnpm --filter @markiro/api test -- shifts-bundle`
Expected: PASS — open happy/409 + bundle shape + cross-tenant 404. (Full env values per Global Constraints.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shifts apps/api/test/shifts-bundle.e2e.test.ts
git commit -m "feat(api): shift open endpoint and station bundle GET (operators mocked for 05b)"
```

---

### Task 8: Station — API client + config bridge + enrollment UI

**Files:**

- Create: `apps/station/src/lib/config.ts` (Tauri `invoke` bridge to `read_config`/`write_config`)
- Create: `apps/station/src/lib/api-client.ts` (`createStationClient`)
- Create: `apps/station/src/pages/Enrollment.tsx`
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json` (enrollment keys)
- Test: `apps/station/test/api-client.test.tsx`
- Test: `apps/station/test/enrollment.test.tsx`

**Interfaces:**

- Consumes: Rust `read_config`/`write_config` (Task 2); `@markiro/ui` (`Button`, `Field`, `Input`, `Card`, `Alert`).
- Produces:
  - `export interface StationConfig { machineId: string; tenantId?: string; deviceId?: string; apiKey?: string; serverUrl?: string }` (camelCase mirror of the Rust struct — the Tauri IPC boundary serializes the Rust snake_case fields; see the field-name note).
  - `export async function readConfig(): Promise<StationConfig>` / `writeConfig(cfg): Promise<void>`.
  - `export function createStationClient(cfg): { get<T>(path): Promise<T>; post<T>(path, body?): Promise<T>; whoami(): Promise<{ ok: true }> }`.
  - `Enrollment` React component.

- [ ] **Step 1: Write the config bridge**

`apps/station/src/lib/config.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

/**
 * Webview view of the Rust StationConfig. The Rust struct uses snake_case
 * (machine_id, tenant_id, ...); serde serializes those field names across
 * the IPC boundary, so this bridge maps to/from camelCase explicitly rather
 * than assuming a rename attribute exists on the Rust side.
 */
export interface StationConfig {
  machineId: string;
  tenantId?: string;
  deviceId?: string;
  apiKey?: string;
  serverUrl?: string;
}

interface RustConfig {
  machine_id: string;
  tenant_id?: string;
  device_id?: string;
  api_key?: string;
  server_url?: string;
}

function fromRust(c: RustConfig): StationConfig {
  return {
    machineId: c.machine_id,
    tenantId: c.tenant_id,
    deviceId: c.device_id,
    apiKey: c.api_key,
    serverUrl: c.server_url,
  };
}

function toRust(c: StationConfig): RustConfig {
  return {
    machine_id: c.machineId,
    tenant_id: c.tenantId,
    device_id: c.deviceId,
    api_key: c.apiKey,
    server_url: c.serverUrl,
  };
}

export async function readConfig(): Promise<StationConfig> {
  return fromRust(await invoke<RustConfig>("read_config"));
}

export async function writeConfig(cfg: StationConfig): Promise<void> {
  await invoke("write_config", { cfg: toRust(cfg) });
}

/** True once the device is enrolled (has a tenant, key, and server URL). */
export function isEnrolled(cfg: StationConfig): boolean {
  return Boolean(cfg.tenantId && cfg.apiKey && cfg.serverUrl);
}
```

- [ ] **Step 2: Write the failing api-client test**

`apps/station/test/api-client.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStationClient } from "../src/lib/api-client.js";

afterEach(() => vi.restoreAllMocks());

describe("createStationClient", () => {
  it("sends the x-api-key header and base-URLs from config", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = createStationClient({
      machineId: "m1",
      tenantId: "org_1",
      apiKey: "mk_key",
      serverUrl: "http://localhost:3000",
    });

    await client.get("/shifts");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:3000/shifts");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("mk_key");
  });

  it("throws with the server message on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "nope" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = createStationClient({
      machineId: "m1",
      apiKey: "bad",
      serverUrl: "http://localhost:3000",
    });
    await expect(client.get("/shifts")).rejects.toThrow("nope");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station test -- api-client`
Expected: FAIL — `createStationClient` not defined.

- [ ] **Step 4: Implement the api client**

`apps/station/src/lib/api-client.ts`:

```ts
import type { StationConfig } from "./config.js";

export class StationApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StationApiError";
    this.status = status;
  }
}

export interface StationClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  whoami(): Promise<{ ok: true }>;
}

/**
 * Fetch client for the SaaS API. Sends the device api-key as `x-api-key`
 * (matching the TenantGuard station path) and prefixes every path with the
 * enrolled `serverUrl`. There is no session cookie — the station is stateless
 * against the server.
 */
export function createStationClient(
  cfg: Pick<StationConfig, "apiKey" | "serverUrl"> & { machineId?: string },
): StationClient {
  const base = (cfg.serverUrl ?? "").replace(/\/+$/, "");

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new StationApiError(res.status, await readError(res));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    // A cheap reachability + auth probe used by enrollment; GET /shifts is
    // TenantGuard-protected, so a 200 proves the key resolves a tenant.
    whoami: async () => {
      await request("GET", "/shifts");
      return { ok: true };
    },
  };
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @markiro/station test -- api-client`
Expected: PASS (2 tests).

- [ ] **Step 6: Add enrollment i18n keys and the failing enrollment test**

Add to `apps/station/src/i18n/ru.json` (and matching `en.json` with the same keys):

```json
  "enroll": {
    "title": "Подключение станции",
    "serverUrl": "Адрес сервера",
    "apiKey": "Ключ устройства",
    "submit": "Подключить",
    "invalid": "Не удалось подключиться. Проверьте адрес и ключ.",
    "success": "Станция подключена"
  }
```

`en.json`:

```json
  "enroll": {
    "title": "Connect station",
    "serverUrl": "Server URL",
    "apiKey": "Device key",
    "submit": "Connect",
    "invalid": "Could not connect. Check the URL and key.",
    "success": "Station connected"
  }
```

`apps/station/test/enrollment.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import i18n from "../src/i18n/index.js";
import { Enrollment } from "../src/pages/Enrollment.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  invokeMock.mockReset();
});

describe("Enrollment", () => {
  it("validates, persists config, and calls onEnrolled on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    invokeMock.mockResolvedValue(undefined); // write_config
    const onEnrolled = vi.fn();

    render(<Enrollment machineId="m1" onEnrolled={onEnrolled} />);
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://localhost:3000" },
    });
    fireEvent.change(screen.getByLabelText("Device key"), { target: { value: "mk_key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onEnrolled).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("write_config", expect.anything());
  });

  it("shows an error and does not persist on a failed probe", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    const onEnrolled = vi.fn();

    render(<Enrollment machineId="m1" onEnrolled={onEnrolled} />);
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://localhost:3000" },
    });
    fireEvent.change(screen.getByLabelText("Device key"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(screen.getByText("Could not connect. Check the URL and key.")).toBeDefined(),
    );
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("write_config", expect.anything());
  });
});
```

The enrollment test renders in EN; set `i18n.changeLanguage("en")` in a `beforeAll` (import the singleton) so the labels match the assertions.

- [ ] **Step 7: Run the enrollment test to verify it fails**

Run: `pnpm --filter @markiro/station test -- enrollment`
Expected: FAIL — `../src/pages/Enrollment.js` does not exist.

- [ ] **Step 8: Implement the enrollment screen**

`apps/station/src/pages/Enrollment.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Field, Input } from "@markiro/ui";
import { writeConfig } from "../lib/config.js";
import { createStationClient } from "../lib/api-client.js";

export interface EnrollmentProps {
  machineId: string;
  onEnrolled: () => void;
}

export function Enrollment({ machineId, onEnrolled }: EnrollmentProps) {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const client = createStationClient({ machineId, apiKey, serverUrl });
      await client.whoami(); // 200 proves the key resolves a tenant
      await writeConfig({ machineId, apiKey, serverUrl });
      onEnrolled();
    } catch {
      setError(t("enroll.invalid"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <Card style={{ minWidth: 480, padding: 32 }}>
        <h1 style={{ fontSize: "2rem", marginBottom: 24 }}>{t("enroll.title")}</h1>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field label={t("enroll.serverUrl")}>
          <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
        </Field>
        <Field label={t("enroll.apiKey")}>
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </Field>
        <Button onClick={submit} disabled={busy || !serverUrl || !apiKey}>
          {t("enroll.submit")}
        </Button>
      </Card>
    </main>
  );
}
```

> If `@markiro/ui`'s `Field` associates its label to the child input differently than `getByLabelText` expects, wire an explicit `htmlFor`/`id` in the component so the test's `getByLabelText("Server URL")` resolves — verify against `packages/ui/src/components/Field.tsx` at execution.

- [ ] **Step 9: Run both station tests to verify they pass**

Run: `pnpm --filter @markiro/station test -- api-client enrollment`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/station/src/lib apps/station/src/pages/Enrollment.tsx apps/station/src/i18n apps/station/test/api-client.test.tsx apps/station/test/enrollment.test.tsx
git commit -m "feat(station): API client, config bridge, and device enrollment screen"
```

---

### Task 9: Station — shift bundle download → SQLite mirror

**Files:**

- Create: `apps/station/src/lib/mirror.ts` (`SqlExecutor`, `applyMigrations`, `upsertBundle`, offline read helpers)
- Create: `apps/station/src/lib/sqlite.ts` (Tauri `tauri-plugin-sql` executor implementing `SqlExecutor`)
- Test: `apps/station/test/mirror.test.ts` (node:sqlite executor)

**Interfaces:**

- Consumes: `STATION_MIGRATIONS`, `OperatorMirrorRecord` (`@markiro/db`); `ShiftBundleDto` shape (Task 7) as a local type; `createStationClient` (Task 8).
- Produces:
  - `export interface SqlExecutor { run(sql, params?): Promise<void>; all<T>(sql, params?): Promise<T[]> }`.
  - `export async function applyMigrations(exec): Promise<void>`.
  - `export async function upsertBundle(exec, bundle): Promise<void>` (writes `shift_mirror`, `product_mirror`, `operators_mirror`).
  - `export async function readShiftMirror(exec, id): Promise<ShiftMirrorRow | null>`; `readOperatorsMirror(exec): Promise<OperatorMirrorRecord[]>`.
  - `export interface StationBundle { shift; product; labelTemplate; counterpartyGln; operators }` (station-side mirror of `ShiftBundleDto`).

- [ ] **Step 1: Enable `node:sqlite` in the station vitest forks**

Modify `apps/station/vitest.config.ts` `test` block — add:

```ts
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
```

- [ ] **Step 2: Write the failing mirror test (node:sqlite executor)**

`apps/station/test/mirror.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  upsertBundle,
  readShiftMirror,
  readOperatorsMirror,
  type SqlExecutor,
  type StationBundle,
} from "../src/lib/mirror.js";

function nodeExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

const bundle: StationBundle = {
  shift: {
    id: "s1",
    status: "active",
    mode: "validation",
    productId: "p1",
    productName: "Cola",
    lineId: null,
    lineName: null,
    counterpartyId: "c1",
    counterpartyName: "Buyer",
    labelTemplateId: "lt1",
    labelTemplateName: "T",
    plannedQty: 100,
    plannedDate: "2026-07-23",
    boxCapacity: 12,
    palletCapacity: 48,
    palletsEnabled: false,
    openedAt: "2026-07-23T08:00:00Z",
  },
  product: {
    id: "p1",
    gtin14: "04600000000017",
    name: "Cola",
    productGroup: "Beverages",
    boxCapacity: 12,
    palletCapacity: 48,
    status: "active",
    defaultCounterpartyId: "c1",
    defaultLabelTemplateId: "lt1",
  },
  labelTemplate: {
    id: "lt1",
    name: "T",
    spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
  },
  counterpartyGln: "6291041500213",
  operators: [
    {
      operatorId: "op1",
      name: "Ivan",
      role: "operator",
      pinHash: "pbkdf2$sha256$1$c2FsdA==$aA==",
      badgeHash: null,
      active: true,
    },
  ],
};

describe("mirror", () => {
  it("applies migrations then upserts a bundle and reads it back offline", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);

    const shift = await readShiftMirror(exec, "s1");
    expect(shift).toMatchObject({ id: "s1", status: "active", counterpartyGln: "6291041500213" });
    expect(JSON.parse(shift!.labelTemplateSpec!)).toMatchObject({ language: "zpl" });

    const ops = await readOperatorsMirror(exec);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operatorId: "op1", active: true });
  });

  it("upserting the same shift twice does not duplicate rows", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);
    await upsertBundle(exec, bundle);
    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM shift_mirror");
    expect(rows[0]!.n).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station test -- mirror`
Expected: FAIL — `../src/lib/mirror.js` does not exist.

- [ ] **Step 4: Implement `mirror.ts`**

`apps/station/src/lib/mirror.ts`:

```ts
import { STATION_MIGRATIONS, type OperatorMirrorRecord } from "@markiro/db";

/** Backend-agnostic SQL surface so mirror logic is testable with node:sqlite. */
export interface SqlExecutor {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Station-side mirror of the server ShiftBundleDto (Task 7). */
export interface StationBundle {
  shift: {
    id: string;
    status: string;
    mode: string;
    productId: string;
    productName: string | null;
    lineId: string | null;
    lineName: string | null;
    counterpartyId: string | null;
    counterpartyName: string | null;
    labelTemplateId: string | null;
    labelTemplateName: string | null;
    plannedQty: number | null;
    plannedDate: string | null;
    boxCapacity: number | null;
    palletCapacity: number | null;
    palletsEnabled: boolean;
    openedAt: string | null;
  };
  product: {
    id: string;
    gtin14: string;
    name: string;
    productGroup: string | null;
    boxCapacity: number | null;
    palletCapacity: number | null;
    status: string;
    defaultCounterpartyId: string | null;
    defaultLabelTemplateId: string | null;
  };
  labelTemplate: { id: string; name: string; spec: unknown } | null;
  counterpartyGln: string | null;
  operators: OperatorMirrorRecord[];
}

export interface ShiftMirrorRow {
  id: string;
  status: string;
  mode: string;
  counterpartyGln: string | null;
  labelTemplateSpec: string | null;
}

export async function applyMigrations(exec: SqlExecutor): Promise<void> {
  for (const stmt of STATION_MIGRATIONS) await exec.run(stmt);
}

const b = (v: boolean) => (v ? 1 : 0);

/** Idempotent upsert of a downloaded bundle into the local mirror tables. */
export async function upsertBundle(exec: SqlExecutor, bundle: StationBundle): Promise<void> {
  const s = bundle.shift;
  await exec.run(
    `INSERT INTO shift_mirror (
       id, status, mode, product_id, product_name, line_id, line_name,
       counterparty_id, counterparty_name, counterparty_gln,
       label_template_id, label_template_name, label_template_spec,
       planned_qty, planned_date, box_capacity, pallet_capacity, pallets_enabled, opened_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, mode=excluded.mode, product_name=excluded.product_name,
       line_id=excluded.line_id, line_name=excluded.line_name,
       counterparty_id=excluded.counterparty_id, counterparty_name=excluded.counterparty_name,
       counterparty_gln=excluded.counterparty_gln, label_template_id=excluded.label_template_id,
       label_template_name=excluded.label_template_name, label_template_spec=excluded.label_template_spec,
       planned_qty=excluded.planned_qty, planned_date=excluded.planned_date,
       box_capacity=excluded.box_capacity, pallet_capacity=excluded.pallet_capacity,
       pallets_enabled=excluded.pallets_enabled, opened_at=excluded.opened_at`,
    [
      s.id,
      s.status,
      s.mode,
      s.productId,
      s.productName,
      s.lineId,
      s.lineName,
      s.counterpartyId,
      s.counterpartyName,
      bundle.counterpartyGln,
      s.labelTemplateId,
      s.labelTemplateName,
      bundle.labelTemplate ? JSON.stringify(bundle.labelTemplate.spec) : null,
      s.plannedQty,
      s.plannedDate,
      s.boxCapacity,
      s.palletCapacity,
      b(s.palletsEnabled),
      s.openedAt,
    ],
  );

  const p = bundle.product;
  await exec.run(
    `INSERT INTO product_mirror (
       id, gtin14, name, product_group, box_capacity, pallet_capacity, status,
       default_counterparty_id, default_label_template_id
     ) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       gtin14=excluded.gtin14, name=excluded.name, product_group=excluded.product_group,
       box_capacity=excluded.box_capacity, pallet_capacity=excluded.pallet_capacity,
       status=excluded.status, default_counterparty_id=excluded.default_counterparty_id,
       default_label_template_id=excluded.default_label_template_id`,
    [
      p.id,
      p.gtin14,
      p.name,
      p.productGroup,
      p.boxCapacity,
      p.palletCapacity,
      p.status,
      p.defaultCounterpartyId,
      p.defaultLabelTemplateId,
    ],
  );

  for (const op of bundle.operators) {
    await exec.run(
      `INSERT INTO operators_mirror (operator_id, name, role, pin_hash, badge_hash, active)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(operator_id) DO UPDATE SET
         name=excluded.name, role=excluded.role, pin_hash=excluded.pin_hash,
         badge_hash=excluded.badge_hash, active=excluded.active`,
      [op.operatorId, op.name, op.role, op.pinHash, op.badgeHash, b(op.active)],
    );
  }
}

export async function readShiftMirror(
  exec: SqlExecutor,
  id: string,
): Promise<ShiftMirrorRow | null> {
  const rows = await exec.all<{
    id: string;
    status: string;
    mode: string;
    counterparty_gln: string | null;
    label_template_spec: string | null;
  }>(
    "SELECT id, status, mode, counterparty_gln, label_template_spec FROM shift_mirror WHERE id = ?",
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    mode: r.mode,
    counterpartyGln: r.counterparty_gln,
    labelTemplateSpec: r.label_template_spec,
  };
}

export async function readOperatorsMirror(exec: SqlExecutor): Promise<OperatorMirrorRecord[]> {
  const rows = await exec.all<{
    operator_id: string;
    name: string;
    role: string;
    pin_hash: string;
    badge_hash: string | null;
    active: number;
  }>("SELECT operator_id, name, role, pin_hash, badge_hash, active FROM operators_mirror");
  return rows.map((r) => ({
    operatorId: r.operator_id,
    name: r.name,
    role: r.role,
    pinHash: r.pin_hash,
    badgeHash: r.badge_hash,
    active: r.active === 1,
  }));
}
```

- [ ] **Step 5: Implement the Tauri sql executor (runtime wiring, not unit-tested)**

`apps/station/src/lib/sqlite.ts`:

```ts
import Database from "@tauri-apps/plugin-sql";
import type { SqlExecutor } from "./mirror.js";

let dbPromise: Promise<Database> | null = null;

/** Opens (once) the on-device SQLite mirror DB via tauri-plugin-sql. */
function db(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:station-mirror.db");
  return dbPromise;
}

/**
 * SqlExecutor backed by tauri-plugin-sql. drizzle-orm/sqlite-proxy can be
 * layered on top later for typed queries; the mirror layer only needs
 * run/all, kept identical to the node:sqlite test executor.
 */
export const tauriExecutor: SqlExecutor = {
  async run(sql, params = []) {
    await (await db()).execute(sql, params as unknown[]);
  },
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await db()).select<T[]>(sql, params);
  },
};
```

- [ ] **Step 6: Run the mirror test to verify it passes**

Run: `pnpm --filter @markiro/station test -- mirror`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck the station package**

Run: `pnpm --filter @markiro/station typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/station/src/lib/mirror.ts apps/station/src/lib/sqlite.ts apps/station/vitest.config.ts apps/station/test/mirror.test.ts
git commit -m "feat(station): bundle download to SQLite mirror with offline read helpers"
```

---

### Task 10: Station — offline operator PIN/badge auth (PBKDF2 PHC)

**Files:**

- Create: `apps/station/src/lib/crypto.ts` (`hashSecret`, `verifyPin`, `verifyBadge`)
- Create: `apps/station/src/lib/auth.ts` (`verifyOperatorPin`, `verifyOperatorBadge` against the mirror)
- Create: `apps/station/src/ui/PinPad.tsx`
- Create: `apps/station/src/pages/OperatorLogin.tsx`
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json` (login keys)
- Test: `apps/station/test/crypto.test.ts`
- Test: `apps/station/test/operator-login.test.tsx`

**Interfaces:**

- Consumes: `SqlExecutor`, `readOperatorsMirror` (Task 9); `OperatorMirrorRecord` (`@markiro/db`); `@markiro/ui` (`Button`, `Alert`).
- Produces:
  - `export async function hashSecret(secret: string): Promise<string>` (PHC `pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`).
  - `export async function verifyPin(pin: string, phc: string): Promise<boolean>`; `verifyBadge(code, phc): Promise<boolean>`.
  - `export async function verifyOperatorPin(exec, pin): Promise<OperatorMirrorRecord | null>`; `verifyOperatorBadge(exec, code): Promise<OperatorMirrorRecord | null>`.
  - `PinPad` (64px keys, digits only) + `OperatorLogin` component.

- [ ] **Step 1: Write the failing crypto known-vector test**

`apps/station/test/crypto.test.ts`:

```ts
import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSecret, verifyPin, verifyBadge } from "../src/lib/crypto.js";

describe("crypto (PBKDF2 PHC)", () => {
  it("verifies a known vector cross-checked against node:crypto", async () => {
    const salt = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", Buffer.from(salt), 100000, 32, "sha256");
    const phc = `pbkdf2$sha256$100000$${Buffer.from(salt).toString("base64")}$${derived.toString("base64")}`;
    expect(await verifyPin("1234", phc)).toBe(true);
    expect(await verifyPin("0000", phc)).toBe(false);
  });

  it("round-trips a freshly hashed secret", async () => {
    const phc = await hashSecret("735519");
    expect(phc.startsWith("pbkdf2$sha256$")).toBe(true);
    expect(await verifyBadge("735519", phc)).toBe(true);
    expect(await verifyBadge("000000", phc)).toBe(false);
  });

  it("rejects malformed PHC strings without throwing", async () => {
    expect(await verifyPin("1234", "not-a-phc")).toBe(false);
    expect(await verifyPin("1234", "argon2$x$y$z$w")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station test -- crypto`
Expected: FAIL — `../src/lib/crypto.js` does not exist.

- [ ] **Step 3: Implement `crypto.ts`**

`apps/station/src/lib/crypto.ts`:

```ts
// Offline credential verifier. PHC format: pbkdf2$sha256$<iter>$<saltB64>$<hashB64>.
// Uses WebCrypto SubtleCrypto (present in the Tauri webview and in Node 24 as
// globalThis.crypto) — no native dependency.
const ITERATIONS = 100_000;
const KEY_BITS = 256;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBits(
  secret: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Computes a PHC verifier for a PIN or badge string, with a random 16-byte salt. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveBits(secret, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${toB64(salt)}$${toB64(derived)}`;
}

async function verifySecret(secret: string, phc: string): Promise<boolean> {
  const parts = phc.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromB64(parts[3]!);
    expected = fromB64(parts[4]!);
  } catch {
    return false;
  }
  const actual = await deriveBits(secret, salt, iterations);
  return timingSafeEqual(actual, expected);
}

export async function verifyPin(pin: string, phc: string): Promise<boolean> {
  return verifySecret(pin, phc);
}

export async function verifyBadge(code: string, phc: string): Promise<boolean> {
  return verifySecret(code, phc);
}
```

- [ ] **Step 4: Run the crypto test to verify it passes**

Run: `pnpm --filter @markiro/station test -- crypto`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the mirror-backed auth helper**

`apps/station/src/lib/auth.ts`:

```ts
import type { OperatorMirrorRecord } from "@markiro/db";
import { readOperatorsMirror, type SqlExecutor } from "./mirror.js";
import { verifyBadge, verifyPin } from "./crypto.js";

/** Returns the matching active operator for a PIN, or null. PINs are all-digits, min 4. */
export async function verifyOperatorPin(
  exec: SqlExecutor,
  pin: string,
): Promise<OperatorMirrorRecord | null> {
  if (!/^\d{4,}$/.test(pin)) return null;
  for (const op of await readOperatorsMirror(exec)) {
    if (op.active && (await verifyPin(pin, op.pinHash))) return op;
  }
  return null;
}

/** Returns the matching active operator for a scanned badge string, or null. */
export async function verifyOperatorBadge(
  exec: SqlExecutor,
  code: string,
): Promise<OperatorMirrorRecord | null> {
  if (code.length === 0) return null;
  for (const op of await readOperatorsMirror(exec)) {
    if (op.active && op.badgeHash && (await verifyBadge(code, op.badgeHash))) return op;
  }
  return null;
}
```

- [ ] **Step 6: Add login i18n keys + PinPad, and write the failing login test**

Add to `ru.json` (and identical keys in `en.json`):

```json
  "login": {
    "title": "Вход оператора",
    "pinPrompt": "Введите PIN",
    "badgePrompt": "Или отсканируйте бейдж",
    "clear": "Сброс",
    "submit": "Войти",
    "wrong": "Неверный PIN"
  }
```

`en.json`:

```json
  "login": {
    "title": "Operator sign-in",
    "pinPrompt": "Enter PIN",
    "badgePrompt": "Or scan your badge",
    "clear": "Clear",
    "submit": "Sign in",
    "wrong": "Wrong PIN"
  }
```

`apps/station/test/operator-login.test.tsx`:

```tsx
import { DatabaseSync } from "node:sqlite";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { hashSecret } from "../src/lib/crypto.js";
import { OperatorLogin } from "../src/pages/OperatorLogin.js";

function nodeExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

async function seedOperator(exec: SqlExecutor, pin: string): Promise<void> {
  await exec.run(
    `INSERT INTO operators_mirror (operator_id, name, role, pin_hash, badge_hash, active) VALUES (?,?,?,?,?,?)`,
    ["op1", "Ivan", "operator", await hashSecret(pin), null, 1],
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("OperatorLogin", () => {
  it("accepts a correct PIN against the seeded mirror and calls onAuthed", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await seedOperator(exec, "4321");

    const onAuthed = vi.fn();
    render(<OperatorLogin exec={exec} onAuthed={onAuthed} />);
    for (const d of "4321") fireEvent.click(screen.getByRole("button", { name: d }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(onAuthed).toHaveBeenCalledWith(expect.objectContaining({ operatorId: "op1" })),
    );
  });

  it("shows a floor error on a wrong PIN and does not authenticate", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await seedOperator(exec, "4321");
    const onAuthed = vi.fn();
    render(<OperatorLogin exec={exec} onAuthed={onAuthed} />);
    for (const d of "0000") fireEvent.click(screen.getByRole("button", { name: d }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Wrong PIN")).toBeDefined());
    expect(onAuthed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run the login test to verify it fails**

Run: `pnpm --filter @markiro/station test -- operator-login`
Expected: FAIL — `PinPad`/`OperatorLogin` do not exist.

- [ ] **Step 8: Implement `PinPad` and `OperatorLogin`**

`apps/station/src/ui/PinPad.tsx`:

```tsx
import { Button } from "@markiro/ui";

export interface PinPadProps {
  value: string;
  onChange: (next: string) => void;
}

// Floor-mode digit pad: 64px+ keys, digits only (design brief 04).
export function PinPad({ value, onChange }: PinPadProps) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 96px)", gap: 12 }}>
      {keys.map((k) => (
        <Button
          key={k}
          style={{ minWidth: 96, minHeight: 96, fontSize: "2rem" }}
          onClick={() => onChange(value + k)}
        >
          {k}
        </Button>
      ))}
    </div>
  );
}
```

`apps/station/src/pages/OperatorLogin.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import type { OperatorMirrorRecord } from "@markiro/db";
import type { SqlExecutor } from "../lib/mirror.js";
import { verifyOperatorPin } from "../lib/auth.js";
import { PinPad } from "../ui/PinPad.js";

export interface OperatorLoginProps {
  exec: SqlExecutor;
  onAuthed: (operator: OperatorMirrorRecord) => void;
}

export function OperatorLogin({ exec, onAuthed }: OperatorLoginProps) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const operator = await verifyOperatorPin(exec, pin);
    if (operator) {
      onAuthed(operator);
    } else {
      setError(t("login.wrong"));
      setPin("");
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 24 }}>
      <h1 style={{ fontSize: "2.25rem" }}>{t("login.title")}</h1>
      <p style={{ fontSize: "1.25rem" }}>{t("login.pinPrompt")}</p>
      <div aria-label="pin" style={{ fontSize: "3rem", letterSpacing: "0.5rem" }}>
        {"•".repeat(pin.length)}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <PinPad value={pin} onChange={setPin} />
      <div style={{ display: "flex", gap: 12 }}>
        <Button variant="secondary" style={{ minHeight: 64 }} onClick={() => setPin("")}>
          {t("login.clear")}
        </Button>
        <Button style={{ minHeight: 64 }} onClick={submit}>
          {t("login.submit")}
        </Button>
      </div>
    </main>
  );
}
```

> `Button`'s `variant` values come from `@markiro/ui` (`ButtonVariant`); use `"secondary"` if present, otherwise drop the prop — verify against `packages/ui/src/components/Button.tsx`.

- [ ] **Step 9: Run the login test to verify it passes**

Run: `pnpm --filter @markiro/station test -- operator-login`
Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
git add apps/station/src/lib/crypto.ts apps/station/src/lib/auth.ts apps/station/src/ui/PinPad.tsx apps/station/src/pages/OperatorLogin.tsx apps/station/src/i18n apps/station/test/crypto.test.ts apps/station/test/operator-login.test.tsx
git commit -m "feat(station): offline operator PIN/badge auth with PBKDF2 PHC verifier"
```

---

### Task 11: Station — shift selection + ad-hoc shift create

**Files:**

- Create: `apps/station/src/pages/ShiftSelection.tsx`
- Create: `apps/station/src/pages/NewShift.tsx`
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json` (shift keys)
- Test: `apps/station/test/shift-selection.test.tsx`
- Test: `apps/station/test/new-shift.test.tsx`

**Interfaces:**

- Consumes: `createStationClient` (Task 8); `normalizeToGtin14`, `DomainError` (`@markiro/domain`); `ShiftDto`/`ProductDto` shapes; `@markiro/ui` (`Card`, `Button`, `Input`, `Alert`).
- Produces:
  - `ShiftSelection` (planned "open" → `POST /shifts/:id/open`; active "rejoin").
  - `NewShift` (typed/keyboard-wedge GTIN → `normalizeToGtin14` → `POST /products/gtin-check` → found: mode choice + `POST /shifts` `+` open; not-found: blocking "not in catalog" screen).

- [ ] **Step 1: Add shift-flow i18n keys**

Add to `ru.json` (identical keys in `en.json`):

```json
  "shifts": {
    "title": "Смены",
    "open": "Открыть",
    "rejoin": "Присоединиться",
    "new": "Новая смена",
    "gtinPrompt": "Введите или отсканируйте GTIN",
    "gtinInvalid": "Неверный GTIN",
    "notInCatalog": "Товар не найден в каталоге",
    "notInCatalogHint": "Попросите администратора добавить товар в админ-панели.",
    "scanAgain": "Сканировать снова",
    "back": "Назад",
    "modeValidation": "Проверка",
    "modeAggregation": "Агрегация",
    "start": "Начать"
  }
```

`en.json`:

```json
  "shifts": {
    "title": "Shifts",
    "open": "Open",
    "rejoin": "Rejoin",
    "new": "New shift",
    "gtinPrompt": "Type or scan a GTIN",
    "gtinInvalid": "Invalid GTIN",
    "notInCatalog": "Product is not in the catalog",
    "notInCatalogHint": "Ask an administrator to add it in the admin panel.",
    "scanAgain": "Scan again",
    "back": "Back",
    "modeValidation": "Validation",
    "modeAggregation": "Aggregation",
    "start": "Start"
  }
```

- [ ] **Step 2: Write the failing shift-selection test**

`apps/station/test/shift-selection.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import { ShiftSelection } from "../src/pages/ShiftSelection.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => vi.restoreAllMocks());

const client = createStationClient({
  machineId: "m1",
  apiKey: "k",
  serverUrl: "http://localhost:3000",
});

describe("ShiftSelection", () => {
  it("opens a planned shift and calls onSelected with the opened shift", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "s1",
                status: "planned",
                mode: "validation",
                productName: "Cola",
                plannedQty: 100,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s1", status: "active", mode: "validation" }), {
          status: 200,
        }),
      );

    const onSelected = vi.fn();
    render(<ShiftSelection client={client} onSelected={onSelected} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(onSelected).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1", status: "active" }),
      ),
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @markiro/station test -- shift-selection`
Expected: FAIL — `ShiftSelection` does not exist.

- [ ] **Step 4: Implement `ShiftSelection`**

`apps/station/src/pages/ShiftSelection.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card } from "@markiro/ui";
import type { StationClient } from "../lib/api-client.js";

interface ShiftListItem {
  id: string;
  status: "planned" | "active" | "closed";
  mode: "validation" | "aggregation";
  productName: string | null;
  plannedQty: number | null;
  counterpartyName?: string | null;
}

export interface ShiftSelectionProps {
  client: StationClient;
  onSelected: (shift: { id: string; status: string; mode: string }) => void;
  onNew: () => void;
}

export function ShiftSelection({ client, onSelected, onNew }: ShiftSelectionProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ShiftListItem[]>([]);

  useEffect(() => {
    void client.get<{ items: ShiftListItem[] }>("/shifts").then((r) => setItems(r.items));
  }, [client]);

  async function open(shift: ShiftListItem) {
    const opened = await client.post<{ id: string; status: string; mode: string }>(
      `/shifts/${shift.id}/open`,
    );
    onSelected(opened);
  }

  return (
    <main style={{ minHeight: "100vh", padding: 32 }}>
      <h1 style={{ fontSize: "2.25rem", marginBottom: 24 }}>{t("shifts.title")}</h1>
      <div style={{ display: "grid", gap: 16 }}>
        {items
          .filter((s) => s.status !== "closed")
          .map((s) => (
            <Card key={s.id} style={{ padding: 24 }}>
              <div style={{ fontSize: "1.5rem" }}>{s.productName}</div>
              {s.counterpartyName ? <div>для: {s.counterpartyName}</div> : null}
              <Button
                style={{ minHeight: 64, marginTop: 12 }}
                onClick={() => (s.status === "active" ? onSelected(s) : void open(s))}
              >
                {s.status === "active" ? t("shifts.rejoin") : t("shifts.open")}
              </Button>
            </Card>
          ))}
        <Button style={{ minHeight: 64 }} onClick={onNew}>
          {t("shifts.new")}
        </Button>
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Run the shift-selection test to verify it passes**

Run: `pnpm --filter @markiro/station test -- shift-selection`
Expected: PASS.

- [ ] **Step 6: Write the failing NewShift test (found + not-found)**

`apps/station/test/new-shift.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { createStationClient } from "../src/lib/api-client.js";
import { NewShift } from "../src/pages/NewShift.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => vi.restoreAllMocks());

const client = createStationClient({
  machineId: "m1",
  apiKey: "k",
  serverUrl: "http://localhost:3000",
});

describe("NewShift", () => {
  it("resolves a known GTIN, creates + opens a validation shift", async () => {
    vi.spyOn(globalThis, "fetch")
      // POST /products/gtin-check
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000017", owner: "own" }), { status: 200 }),
      )
      // GET /products?search=... (resolve productId)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ id: "p1", gtin14: "04600000000017", name: "Cola", status: "active" }],
          }),
          { status: 200 },
        ),
      )
      // POST /shifts
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "planned", mode: "validation" }), {
          status: 201,
        }),
      )
      // POST /shifts/s9/open
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "s9", status: "active", mode: "validation" }), {
          status: 200,
        }),
      );

    const onStarted = vi.fn();
    render(<NewShift client={client} onStarted={onStarted} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000017" },
    });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);

    await waitFor(() => expect(screen.getByText("Cola")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Validation" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s9", status: "active" }),
      ),
    );
  });

  it("shows the blocking not-in-catalog screen for an unknown GTIN", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ gtin14: "04600000000017", owner: "unknown" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));

    render(<NewShift client={client} onStarted={vi.fn()} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), {
      target: { value: "4600000000017" },
    });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);

    await waitFor(() => expect(screen.getByText("Product is not in the catalog")).toBeDefined());
  });

  it("rejects an invalid GTIN inline", async () => {
    render(<NewShift client={client} onStarted={vi.fn()} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Type or scan a GTIN"), { target: { value: "123" } });
    fireEvent.submit(screen.getByLabelText("Type or scan a GTIN").closest("form")!);
    await waitFor(() => expect(screen.getByText("Invalid GTIN")).toBeDefined());
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @markiro/station test -- new-shift`
Expected: FAIL — `NewShift` does not exist.

- [ ] **Step 8: Implement `NewShift`**

`apps/station/src/pages/NewShift.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Input } from "@markiro/ui";
import { DomainError, normalizeToGtin14 } from "@markiro/domain";
import type { StationClient } from "../lib/api-client.js";

interface ResolvedProduct {
  id: string;
  gtin14: string;
  name: string;
  boxCapacity: number | null;
}

export interface NewShiftProps {
  client: StationClient;
  onStarted: (shift: { id: string; status: string; mode: string }) => void;
  onBack: () => void;
}

type View = "input" | "found" | "notFound";

export function NewShift({ client, onStarted, onBack }: NewShiftProps) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState("");
  const [view, setView] = useState<View>("input");
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState<ResolvedProduct | null>(null);
  const [mode, setMode] = useState<"validation" | "aggregation">("validation");
  const [unknownGtin, setUnknownGtin] = useState<string>("");

  async function resolve(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let gtin14: string;
    try {
      gtin14 = normalizeToGtin14(raw);
    } catch (err) {
      setError(err instanceof DomainError ? t("shifts.gtinInvalid") : String(err));
      return;
    }
    // Owner hint (also validates against the catalog indirectly).
    await client.post<{ gtin14: string; owner: string }>("/products/gtin-check", { gtin: gtin14 });
    const list = await client.get<{ items: ResolvedProduct[] }>(`/products?search=${gtin14}`);
    const match = list.items.find((p) => p.gtin14 === gtin14) ?? null;
    if (!match) {
      setUnknownGtin(gtin14);
      setView("notFound");
      return;
    }
    setProduct(match);
    setView("found");
  }

  async function start() {
    if (!product) return;
    const created = await client.post<{ id: string }>("/shifts", { productId: product.id, mode });
    const opened = await client.post<{ id: string; status: string; mode: string }>(
      `/shifts/${created.id}/open`,
    );
    onStarted(opened);
  }

  if (view === "notFound") {
    return (
      <main
        style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 16, padding: 32 }}
      >
        <h1 style={{ fontSize: "2rem" }}>{t("shifts.notInCatalog")}</h1>
        <p style={{ fontSize: "1.25rem" }}>GTIN: {unknownGtin}</p>
        <p>{t("shifts.notInCatalogHint")}</p>
        <div style={{ display: "flex", gap: 12 }}>
          <Button
            style={{ minHeight: 64 }}
            onClick={() => {
              setRaw("");
              setView("input");
            }}
          >
            {t("shifts.scanAgain")}
          </Button>
          <Button variant="secondary" style={{ minHeight: 64 }} onClick={onBack}>
            {t("shifts.back")}
          </Button>
        </div>
      </main>
    );
  }

  if (view === "found" && product) {
    return (
      <main
        style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 16, padding: 32 }}
      >
        <Card style={{ padding: 24, minWidth: 480 }}>
          <div style={{ fontSize: "1.75rem" }}>{product.name}</div>
          <div>{product.gtin14}</div>
        </Card>
        <div style={{ display: "flex", gap: 12 }}>
          <Button
            variant={mode === "validation" ? "primary" : "secondary"}
            style={{ minHeight: 64 }}
            onClick={() => setMode("validation")}
          >
            {t("shifts.modeValidation")}
          </Button>
          <Button
            variant={mode === "aggregation" ? "primary" : "secondary"}
            style={{ minHeight: 64 }}
            onClick={() => setMode("aggregation")}
          >
            {t("shifts.modeAggregation")}
          </Button>
        </div>
        <Button style={{ minHeight: 64 }} onClick={start}>
          {t("shifts.start")}
        </Button>
      </main>
    );
  }

  return (
    <main
      style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 16, padding: 32 }}
    >
      <form onSubmit={resolve} style={{ display: "grid", gap: 16, minWidth: 480 }}>
        <label htmlFor="gtin" style={{ fontSize: "1.25rem" }}>
          {t("shifts.gtinPrompt")}
        </label>
        <Input id="gtin" autoFocus value={raw} onChange={(e) => setRaw(e.target.value)} />
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" style={{ minHeight: 64 }}>
          {t("shifts.open")}
        </Button>
      </form>
    </main>
  );
}
```

> The test targets the input via `getByLabelText("Type or scan a GTIN")`; the explicit `htmlFor="gtin"`/`id="gtin"` above wire that association. Adjust `Button`'s `variant`/`type` props to `@markiro/ui`'s actual `ButtonProps` at execution.

- [ ] **Step 9: Run the NewShift test to verify it passes**

Run: `pnpm --filter @markiro/station test -- new-shift`
Expected: PASS (3 tests).

- [ ] **Step 10: Commit**

```bash
git add apps/station/src/pages/ShiftSelection.tsx apps/station/src/pages/NewShift.tsx apps/station/src/i18n apps/station/test/shift-selection.test.tsx apps/station/test/new-shift.test.tsx
git commit -m "feat(station): shift selection and ad-hoc GTIN-driven shift creation"
```

---

### Task 12: Station — floor-mode shell (status bar, task switcher, SignalOverlay skeleton, i18n lockstep)

**Files:**

- Create: `apps/station/src/ui/StatusBar.tsx`
- Create: `apps/station/src/ui/SignalOverlay.tsx`
- Create: `apps/station/src/ui/FloorShell.tsx`
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json` (shell/signal keys)
- Test: `apps/station/test/status-bar.test.tsx`
- Test: `apps/station/test/signal-overlay.test.tsx`
- Test: `apps/station/test/i18n.test.tsx`

**Interfaces:**

- Consumes: `@markiro/ui` (`StatusChip`), i18n singleton, `SUPPORTED_LANGUAGES`.
- Produces:
  - `StatusBar` (network online/offline, sync placeholder, agent/scanner/printer "not configured", teammates placeholder).
  - `SignalOverlay` skeleton — `{ tone: "ok" | "error" | "duplicate"; title: string }` full-screen colored state (behavior/sound wired in 05b).
  - `FloorShell` (persistent status bar + top task switcher wrapping children).

- [ ] **Step 1: Add shell/signal i18n keys**

Add to `ru.json` (identical keys in `en.json`):

```json
  "shell": {
    "online": "В сети",
    "offline": "Не в сети",
    "sync": "Синхронизация",
    "agent": "Агент",
    "scanner": "Сканер",
    "printer": "Принтер",
    "notConfigured": "Не настроено",
    "teammates": "Терминалы",
    "tasks": "Задачи"
  }
```

`en.json`:

```json
  "shell": {
    "online": "Online",
    "offline": "Offline",
    "sync": "Sync",
    "agent": "Agent",
    "scanner": "Scanner",
    "printer": "Printer",
    "notConfigured": "Not configured",
    "teammates": "Terminals",
    "tasks": "Tasks"
  }
```

- [ ] **Step 2: Write the failing status-bar + signal-overlay + i18n-lockstep tests**

`apps/station/test/status-bar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../src/i18n/index.js";
import { StatusBar } from "../src/ui/StatusBar.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("StatusBar", () => {
  it("shows the online state", () => {
    render(<StatusBar online />);
    expect(screen.getByText("Online")).toBeDefined();
  });
  it("shows the offline state and 'not configured' hardware placeholders", () => {
    render(<StatusBar online={false} />);
    expect(screen.getByText("Offline")).toBeDefined();
    expect(screen.getAllByText("Not configured").length).toBeGreaterThanOrEqual(3);
  });
});
```

`apps/station/test/signal-overlay.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SignalOverlay } from "../src/ui/SignalOverlay.js";

describe("SignalOverlay", () => {
  it("renders a full-screen tone with its title and role=alert", () => {
    render(<SignalOverlay tone="error" title="ЧУЖОЙ ГТИН" />);
    const overlay = screen.getByRole("alert");
    expect(overlay.textContent).toContain("ЧУЖОЙ ГТИН");
    expect(overlay.getAttribute("data-tone")).toBe("error");
  });
});
```

`apps/station/test/i18n.test.tsx`:

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

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station test -- status-bar signal-overlay i18n`
Expected: FAIL — `StatusBar`/`SignalOverlay` do not exist (and i18n lockstep fails if any key set drifted).

- [ ] **Step 4: Implement `StatusBar`, `SignalOverlay`, `FloorShell`**

`apps/station/src/ui/StatusBar.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { StatusChip } from "@markiro/ui";

export interface StatusBarProps {
  online: boolean;
}

// Persistent floor status bar. Hardware indicators are "not configured"
// placeholders in 05a — the hardware module + workstation setup land in 05b.
export function StatusBar({ online }: StatusBarProps) {
  const { t } = useTranslation();
  const notConfigured = t("shell.notConfigured");
  return (
    <header
      role="contentinfo"
      style={{
        display: "flex",
        gap: 16,
        alignItems: "center",
        padding: "8px 16px",
        fontSize: "1rem",
      }}
    >
      <StatusChip status={online ? "ok" : "warn"}>
        {online ? t("shell.online") : t("shell.offline")}
      </StatusChip>
      <span>{t("shell.sync")}: 0</span>
      <span>
        {t("shell.agent")}: {notConfigured}
      </span>
      <span>
        {t("shell.scanner")}: {notConfigured}
      </span>
      <span>
        {t("shell.printer")}: {notConfigured}
      </span>
      <span>{t("shell.teammates")}: +0</span>
    </header>
  );
}
```

> `StatusChip`'s `status` union is `StatusChipStatus = "ok" | "error" | "warn" | "info" | "neutral"` (verified in `packages/ui/src/components/StatusChip.tsx:16`) — `"ok"` = online, `"warn"` = offline. `"success"`/`"warning"` are NOT valid values.

`apps/station/src/ui/SignalOverlay.tsx`:

```tsx
export type SignalTone = "ok" | "error" | "duplicate";

export interface SignalOverlayProps {
  tone: SignalTone;
  title: string;
}

// Skeleton only: renders a full-screen colored state given a tone + title.
// The flash timing and sound are wired in 05b's signal system. Color is
// paired with the title text (color + text; icons added in 05b) per the
// color-blind-safety rule.
// Uses the same status token family as @markiro/ui (--ok-solid / --err-solid /
// --warn-solid, per Input/StatusChip) with literal hex fallbacks so the
// skeleton renders even if a token is absent.
const TONE_BG: Record<SignalTone, string> = {
  ok: "var(--ok-solid, #1f8a4c)",
  error: "var(--err-solid, #b3261e)",
  duplicate: "var(--warn-solid, #a66500)",
};

export function SignalOverlay({ tone, title }: SignalOverlayProps) {
  return (
    <div
      role="alert"
      data-tone={tone}
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: TONE_BG[tone],
        color: "#fff",
        fontSize: "4rem",
        fontWeight: 800,
        textAlign: "center",
      }}
    >
      {title}
    </div>
  );
}
```

`apps/station/src/ui/FloorShell.tsx`:

```tsx
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StatusBar } from "./StatusBar.js";

export interface FloorShellProps {
  online: boolean;
  tasks: Array<{ id: string; label: string }>;
  activeTaskId: string;
  onSelectTask: (id: string) => void;
  children: ReactNode;
}

export function FloorShell({
  online,
  tasks,
  activeTaskId,
  onSelectTask,
  children,
}: FloorShellProps) {
  const { t } = useTranslation();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <StatusBar online={online} />
      <nav aria-label={t("shell.tasks")} style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            aria-pressed={task.id === activeTaskId}
            style={{ minHeight: 64, minWidth: 120, fontSize: "1.1rem" }}
            onClick={() => onSelectTask(task.id)}
          >
            {task.label}
          </button>
        ))}
      </nav>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/station test -- status-bar signal-overlay i18n`
Expected: PASS.

- [ ] **Step 6: Run the full station suite + typecheck**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/station typecheck`
Expected: PASS across all station tests; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src/ui apps/station/src/i18n apps/station/test/status-bar.test.tsx apps/station/test/signal-overlay.test.tsx apps/station/test/i18n.test.tsx
git commit -m "feat(station): floor-mode shell with status bar, task switcher, and SignalOverlay skeleton"
```

---

### Task 13: Docs + CI (cargo + Tauri Windows matrix) + final verification

**Files:**

- Create: `apps/station/README.md`
- Modify: `.github/workflows/ci.yml` (add a `cargo` step + a Windows Tauri-build matrix note/job)
- Modify: `docs/architecture.md` (station cross-ref note only — do NOT rewrite §2)

**Interfaces:**

- Consumes: everything from Tasks 1–12.
- Produces: station README (dev run, offline model, enrollment steps), CI coverage for Rust + the Windows installer build, and a full green verification run.

- [ ] **Step 1: Write the station README**

`apps/station/README.md`:

````markdown
# @markiro/station

Markiro line station — a Tauri 2.11 + React 19 floor-mode app. Reuses
`@markiro/ui` (dark floor theme) and `@markiro/domain` (GTIN normalization).

## Offline model

The station is offline-first. At enrollment it stores a device api-key + server
URL in a `0600` `station.json` (OS app-config dir). A shift is downloaded in
full via `GET /shifts/:id/bundle` into a local SQLite mirror
(`tauri-plugin-sql`, schema from `@markiro/db` `STATION_MIGRATIONS`). Operators
sign in **offline** by PIN/badge, verified locally against `operators_mirror`
(PBKDF2 PHC verifiers) — a PIN is never sent to the server.

## Dev run (macOS)

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d   # API + Postgres for enrollment
pnpm --filter @markiro/api dev                    # http://localhost:3000
pnpm --filter @markiro/station tauri dev          # launches the desktop webview
```
````

The Windows installer is produced in CI (see `.github/workflows/ci.yml`); a
`tauri build` is not required on macOS for development.

## Enrollment

1. In the admin panel, create a station device (`POST /station-devices`) and
   copy the one-time api-key.
2. Launch the station, enter the server URL + api-key on the enrollment screen.
3. The station probes `GET /shifts` (200 = the key resolves a tenant), persists
   the config, and routes to shift selection.

## Tests

```bash
pnpm --filter @markiro/station test    # vitest (jsdom); uses node:sqlite
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

````

- [ ] **Step 2: Add the cargo + Windows-build CI coverage**

Append a `station-rust` job and a Windows Tauri-build matrix job to `.github/workflows/ci.yml` (do NOT remove the existing `verify` job):

```yaml
  station-rust:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - name: Install Linux webkit deps
        run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev
      - uses: dtolnay/rust-toolchain@stable
      - name: cargo build + test (station core)
        run: |
          cargo build --manifest-path apps/station/src-tauri/Cargo.toml
          cargo test  --manifest-path apps/station/src-tauri/Cargo.toml

  station-windows-build:
    runs-on: windows-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24
          cache: pnpm
      - uses: dtolnay/rust-toolchain@stable
      - run: pnpm install --frozen-lockfile
      - name: Build the Windows installer (NSIS)
        run: pnpm --filter @markiro/station tauri build
````

> Note: pin `dtolnay/rust-toolchain@stable` to a commit SHA at execution to match the repo's SHA-pinning convention for third-party actions.

- [ ] **Step 3: Add the architecture cross-ref note (read-only otherwise)**

In `docs/architecture.md` §2 ("Line station (Tauri all-in-one)"), append one line under the existing bullets — do NOT rewrite the section:

```markdown
- Foundation delivered in Plan 05a (`docs/superpowers/plans/2026-07-23-05a-station-foundation.md`):
  Tauri scaffold, Rust config/lockdown/updater skeletons, SQLite mirror, device
  enrollment (api-key), shift bundle download, and offline operator auth.
  The scan pipeline, hardware module, and signal behavior land in 05b.
```

- [ ] **Step 4: Format-check and fix any formatting**

Run: `pnpm format:check`
Expected: PASS. If it reports files, run `pnpm format` and re-check (the new station/db/api files must be Prettier-clean).

- [ ] **Step 5: Full workspace verification (TS)**

Run: `docker compose -f docker-compose.dev.yml up -d && DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/db db:migrate && DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm turbo lint typecheck test build`
Expected: PASS for every package including `@markiro/station`, `@markiro/db`, `@markiro/api`. Record the passing counts. **Never `docker compose down`.**

- [ ] **Step 6: Full Rust verification**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`
Expected: PASS — config + commands tests green. Record the count.

- [ ] **Step 7: Commit**

```bash
git add apps/station/README.md .github/workflows/ci.yml docs/architecture.md
git commit -m "docs(station): README, CI cargo + Windows build matrix, architecture cross-ref"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-05a-station-foundation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
