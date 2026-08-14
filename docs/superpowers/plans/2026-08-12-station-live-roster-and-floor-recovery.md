# Station Live Roster and Floor Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a continuously running Windows station discover newly added operators, reach every production station API route, present clear scan/recovery states, avoid header overlap, and switch operators without closing the active shift or losing attribution.

**Architecture:** Keep authentication local-first: refresh the tenant-scoped hashed roster only after a local credential miss, then repeat the same local verification once. Align the production edge and release preflight with the API's exact station CORS surface, report server reachability separately from browser connectivity, and keep floor actions in normal CSS grid flow. Operator switching retires the ordered local scan queue before replacing the in-memory operator while retaining the active shift and device-owned outbox.

**Tech Stack:** React 19, TypeScript, Vitest and Testing Library, Tauri 2, SQLite mirror, Node test runner, Caddy, pnpm 11.

## Global Constraints

- Raw badge values and PINs never leave the station and never appear in logs.
- Cached operators authenticate without a network request.
- Roster replacement remains atomic and credential-generation guarded.
- Station controls remain at least 64px touch targets.
- The Station UI remains fixed and non-scrolling at 1280×800, 1024×768, and 1280×720.
- Fonts, SVG, icons, and runtime assets remain bundled; add no CDN or runtime asset dependency.
- The update mechanism remains manual; this work does not download or install updates automatically.
- Existing stored `https://admin.markiro.app` station URLs remain valid; no migration is introduced.
- Automated browser, host Cargo, and contract checks do not count as Windows/WebView2 or physical scanner acceptance.

## File structure

- `deploy/production/Caddyfile`: exact production reverse-proxy matchers for root station routes.
- `deploy/production/test/edge-contract.test.mjs`: rejects missing or over-broad station root proxy routes.
- `tools/station-release/verify-api-cors.mjs`: declarative inventory of production Station preflights.
- `tools/station-release/test/verify-api-cors.test.mjs`: verifier request and fail-closed contracts.
- `tools/station-release/test/workflow.test.mjs`: release workflow continues to invoke the expanded gate before build.
- `apps/station/src/lib/api-client.ts`: request-level server reachability reporting.
- `apps/station/src/lib/roster-sync.ts`: result-bearing, single-flight roster refresh.
- `apps/station/src/pages/OperatorLogin.tsx`: local miss → one refresh → one local retry; cached-first name search.
- `apps/station/src/ui/BadgeScanIllustration.tsx`: bundled inline SVG for badge scanning.
- `apps/station/src/pages/ShiftSelection.tsx`: transport-specific shift recovery copy.
- `apps/station/src/ui/StatusBar.tsx`: honest server status and normal-flow action rail.
- `apps/station/src/ui/FloorShell.tsx`: one authenticated floor header rather than a separate chrome row.
- `apps/station/src/ui/OperatorSwitchControl.tsx`: confirmation and failure UI for changing operators.
- `apps/station/src/lib/credential-recovery.ts`: bounded retirement of registered floor work.
- `apps/station/src/App.tsx`: composition, reachability state, roster refresher, and operator-switch state boundary.
- `apps/station/src/i18n/{ru,en}.json`: all new visible copy.
- `apps/station/src/station.css`: fixed viewport scan, header, actions, and recovery layout.
- `docs/hardware-acceptance-checklist.md`: explicit Windows checks for the new flow.

---

### Task 1: Route and preflight the complete production Station API surface

**Files:**

- Modify: `deploy/production/Caddyfile:45-72`
- Modify: `deploy/production/test/edge-contract.test.mjs:510-565`
- Modify: `tools/station-release/verify-api-cors.mjs:1-55`
- Modify: `tools/station-release/test/verify-api-cors.test.mjs:1-115`
- Modify: `tools/station-release/test/workflow.test.mjs:35-125`

**Interfaces:**

- Produces: `STATION_PREFLIGHTS: readonly StationPreflight[]` and `verifyStationCors({ apiUrl, fetchImpl }): Promise<void>`.
- `StationPreflight` is `{ path: string; method: "GET" | "POST"; headers: string }`.
- Preserves: the CLI error text remains secret-free and the workflow command remains `node tools/station-release/verify-api-cors.mjs https://admin.markiro.app`.

- [ ] **Step 1: Write failing edge-route contract tests**

Add this local parser beside `caddyPathMatches`, then require the exact matches:

```js
function stationDevicePathMatches(caddy, path) {
  const devicePatterns =
    caddy
      .match(/^\s*@device path (.+)$/m)?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  const rootPatterns =
    caddy
      .match(/@stationRoot \{[\s\S]*?^\s*path (.+)$/m)?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  const shiftPattern = caddy.match(
    /@stationShift \{[\s\S]*?^\s*path_regexp stationShift (.+)$/m,
  )?.[1];
  return (
    [...devicePatterns, ...rootPatterns].some((pattern) => caddyPathMatches(pattern, path)) ||
    (shiftPattern !== undefined && new RegExp(shiftPattern).test(path))
  );
}

assert.match(caddy, /@stationRoot \{[\s\S]*?path \/shifts \/products \/products\/gtin-check/);
assert.match(
  caddy,
  /@stationShift \{[\s\S]*?path_regexp stationShift \^\/shifts\/\[\^\/\]\+\/\(open\|bundle\)\$/,
);
for (const forbidden of ["/shifts/id/close", "/shifts/id", "/products/id"]) {
  assert.equal(stationDevicePathMatches(caddy, forbidden), false, `${forbidden} must not proxy`);
}
```

The helper must recognize the existing `@device path` list, the exact root
matcher path list, and only `^/shifts/[^/]+/(open|bundle)$` for the shift-action
regexp. The route contract must also distinguish authenticated requests from
ordinary admin SPA navigation and cover the parallel OPTIONS matchers.

- [ ] **Step 2: Run the edge contract and confirm RED**

Run:

```bash
node --test --test-name-pattern="device proxy matcher" deploy/production/test/edge-contract.test.mjs
```

Expected: FAIL because `/shifts`, `/products`, and the shift action regexp are absent.

- [ ] **Step 3: Write failing verifier inventory tests**

Replace the one-call assertion with an exact ordered inventory:

```js
const expected = [
  ["/station/pair", "POST", "content-type,x-station-capabilities"],
  ["/station/identity", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/station/operators", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/station/scans", "POST", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts", "POST", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts/cors-probe/open", "POST", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts/cors-probe/bundle", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/products", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/products/gtin-check", "POST", "content-type,x-api-key,x-station-capabilities"],
];
assert.deepEqual(
  calls.map(({ url, init }) => [
    new URL(url).pathname,
    init.headers["Access-Control-Request-Method"],
    init.headers["Access-Control-Request-Headers"],
  ]),
  expected,
);
```

Add a table test which returns wrong ACAO or status for each index and expects the same `Station CORS verification failed` error without response-body disclosure. Rename the old pairing-only failure constant in tests and implementation to that exact text.

- [ ] **Step 4: Run verifier tests and confirm RED**

Run:

```bash
node --test tools/station-release/test/verify-api-cors.test.mjs tools/station-release/test/workflow.test.mjs
```

Expected: FAIL because the verifier omits routes from the complete Station API
inventory and uses the pairing-only error.

- [ ] **Step 5: Implement exact Caddy matchers**

Keep the infrastructure matcher unchanged and add separately handled
authenticated and OPTIONS matchers for root and shift-action routes before the
SPA handler:

```caddyfile
@stationRoot {
	path /shifts /products /products/gtin-check
	header X-Api-Key *
}
handle @stationRoot {
	reverse_proxy api:3000 {
		import standard_api_transport
	}
}

@stationRootPreflight {
	path /shifts /products /products/gtin-check
	method OPTIONS
}
handle @stationRootPreflight {
	reverse_proxy api:3000 {
		import standard_api_transport
	}
}

@stationShift {
	path_regexp stationShift ^/shifts/[^/]+/(open|bundle)$
	header X-Api-Key *
}
handle @stationShift {
	reverse_proxy api:3000 {
		import standard_api_transport
	}
}

@stationShiftPreflight {
	path_regexp stationShiftPreflight ^/shifts/[^/]+/(open|bundle)$
	method OPTIONS
}
handle @stationShiftPreflight {
	reverse_proxy api:3000 {
		import standard_api_transport
	}
}
```

Update `edge-contract.test.mjs` to expect nine total API proxies and eight
`standard_api_transport` imports (plus the one CommerceML transport). The
adapted-Caddy expected admin transport list must contain the corresponding eight
standard transports. Do not proxy `/shifts/*` or `/products/*` broadly.

- [ ] **Step 6: Implement the declarative preflight loop**

Use this public inventory and fail on the first non-204/wrong-origin response:

```js
export const STATION_PREFLIGHTS = Object.freeze([
  { path: "/station/pair", method: "POST", headers: "content-type,x-station-capabilities" },
  {
    path: "/station/identity",
    method: "GET",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  {
    path: "/station/operators",
    method: "GET",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  {
    path: "/station/scans",
    method: "POST",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  { path: "/shifts", method: "GET", headers: "content-type,x-api-key,x-station-capabilities" },
  { path: "/shifts", method: "POST", headers: "content-type,x-api-key,x-station-capabilities" },
  {
    path: "/shifts/cors-probe/open",
    method: "POST",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  {
    path: "/shifts/cors-probe/bundle",
    method: "GET",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  { path: "/products", method: "GET", headers: "content-type,x-api-key,x-station-capabilities" },
  {
    path: "/products/gtin-check",
    method: "POST",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
]);
```

Construct every OPTIONS request from this array and preserve `redirect: "error"` and the canonical HTTPS-origin validation.

- [ ] **Step 7: Run focused contracts and confirm GREEN**

Run:

```bash
node --test tools/station-release/test/verify-api-cors.test.mjs tools/station-release/test/workflow.test.mjs
node --test --test-name-pattern="device proxy matcher|finite route-appropriate|isolates the admin" deploy/production/test/edge-contract.test.mjs
```

Expected: PASS; if adapted-Caddy tests cannot access their container runtime, record that separately and keep the source matcher test green.

- [ ] **Step 8: Commit the production boundary**

```bash
git add deploy/production/Caddyfile deploy/production/test/edge-contract.test.mjs tools/station-release/verify-api-cors.mjs tools/station-release/test/verify-api-cors.test.mjs tools/station-release/test/workflow.test.mjs
git commit -m "fix(station): route production floor API"
```

---

### Task 2: Report server reachability honestly

**Files:**

- Modify: `apps/station/src/lib/api-client.ts:12-180`
- Modify: `apps/station/test/api-client.test.tsx:1-175`
- Modify: `apps/station/src/App.tsx:180-575`
- Modify: `apps/station/src/ui/StatusBar.tsx:1-125`
- Modify: `apps/station/src/ui/FloorShell.tsx:1-75`
- Modify: `apps/station/test/status-bar.test.tsx:1-150`
- Modify: `apps/station/test/floor-shell.test.tsx:35-145`
- Modify: `apps/station/src/i18n/ru.json:130-165`
- Modify: `apps/station/src/i18n/en.json:130-165`

**Interfaces:**

- Produces: `ServerReachability = "checking" | "reachable" | "unreachable"`.
- Extends: `StationClientOptions` with `onReachabilityChange?: (state: Exclude<ServerReachability, "checking">) => void`.
- Changes: `StatusBarProps.online` to `StatusBarProps.serverReachability`.
- Preserves: `navigator.onLine` as a hint for roster fallback and immediate offline transition, not as proof of server availability.

- [ ] **Step 1: Write failing API-client reachability tests**

Add these cases to `api-client.test.tsx`:

```ts
it("reports an HTTP error as reachable before throwing the API error", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));
  const onReachabilityChange = vi.fn();
  const client = createStationClient(
    { apiKey: "key", serverUrl: "https://station.example" },
    { onReachabilityChange },
  );
  await expect(client.get("/shifts")).rejects.toBeInstanceOf(StationApiError);
  expect(onReachabilityChange).toHaveBeenLastCalledWith("reachable");
});

it("reports fetch and timeout rejection as unreachable", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
  const onReachabilityChange = vi.fn();
  const client = createStationClient(
    { apiKey: "key", serverUrl: "https://station.example" },
    { onReachabilityChange },
  );
  await expect(client.get("/shifts")).rejects.toBeDefined();
  expect(onReachabilityChange).toHaveBeenLastCalledWith("unreachable");
});
```

Also assert a successful response emits `reachable` once.

- [ ] **Step 2: Run the focused client test and confirm RED**

```bash
pnpm --filter @markiro/station exec vitest run test/api-client.test.tsx
```

Expected: FAIL because the option and type do not exist.

- [ ] **Step 3: Implement response-aware reporting**

In `request`, report reachability immediately after `fetch` resolves and only report unreachable when no response was obtained:

```ts
let receivedResponse = false;
try {
  const res = await fetch(url, init);
  receivedResponse = true;
  options.onReachabilityChange?.("reachable");
  if (!res.ok) throw new StationApiError(res.status, await readError(res));
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
} catch (error) {
  if (!receivedResponse) options.onReachabilityChange?.("unreachable");
  // keep the existing credential-rejection boundary here
  throw error;
}
```

Do not classify JSON decoding after an HTTP response as a network outage.

- [ ] **Step 4: Write failing App and StatusBar tests**

Assert `StatusBar` renders `Checking`, `Available`, and `No connection` from the three enum values. In `App.test.tsx`, resolve a `/station/operators` response and expect `Available`; then make `/shifts` reject and expect `No connection`; dispatch browser `offline` and expect the same state immediately.

- [ ] **Step 5: Wire the state into App and StatusBar**

Use stable callbacks so the client does not recreate on every status change:

```ts
const [serverReachability, setServerReachability] = useState<ServerReachability>("checking");
const reportServerReachability = useCallback(
  (state: Exclude<ServerReachability, "checking">) => setServerReachability(state),
  [],
);
```

Pass the callback only to authenticated station clients. The browser `offline` listener sets both `browserOnline=false` and `serverReachability="unreachable"`; the browser `online` listener sets only `browserOnline=true` until a request proves reachability.

Add i18n keys `shell.server`, `shell.serverChecking`, `shell.serverAvailable`, and `shell.serverUnavailable` in Russian and English.
Rename the `online` prop threaded through `FloorShell` to `serverReachability` and update every fixture in `floor-shell.test.tsx` so TypeScript cannot retain the old browser-connectivity meaning.

- [ ] **Step 6: Run focused tests and confirm GREEN**

```bash
pnpm --filter @markiro/station exec vitest run test/api-client.test.tsx test/status-bar.test.tsx test/floor-shell.test.tsx test/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit reachability reporting**

```bash
git add apps/station/src/lib/api-client.ts apps/station/src/App.tsx apps/station/src/ui/StatusBar.tsx apps/station/src/ui/FloorShell.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/api-client.test.tsx apps/station/test/status-bar.test.tsx apps/station/test/floor-shell.test.tsx apps/station/test/App.test.tsx
git commit -m "fix(station): report server reachability"
```

---

### Task 3: Refresh the operator roster after a local miss

**Files:**

- Modify: `apps/station/src/lib/roster-sync.ts:1-45`
- Modify: `apps/station/test/roster-sync.test.ts:1-145`
- Modify: `apps/station/src/pages/OperatorLogin.tsx:1-340`
- Modify: `apps/station/test/operator-login.test.tsx:1-520`
- Modify: `apps/station/src/App.tsx:665-910`
- Modify: `apps/station/src/i18n/ru.json:75-105`
- Modify: `apps/station/src/i18n/en.json:75-105`

**Interfaces:**

- Produces: `OperatorRosterSyncResult = "updated" | "unavailable"`.
- Produces: `createOperatorRosterRefresher(client, exec, generation): () => Promise<OperatorRosterSyncResult>`.
- Extends: `OperatorLoginProps` with `online: boolean` and `refreshRoster?: () => Promise<OperatorRosterSyncResult>`.
- Consumes: the current credential-bound `StationClient`, SQLite `SqlExecutor`, and `CredentialGeneration` from App.

- [ ] **Step 1: Change roster-sync tests to require an outcome and single flight**

Update the offline assertion to expect `"unavailable"`, successful assertions to expect `"updated"`, and add:

```ts
it("coalesces concurrent refresh callers onto one request", async () => {
  const exec = makeExec();
  await applyMigrations(exec);
  let resolve!: (value: { items: (typeof OPERATOR)[] }) => void;
  const get = vi.fn(
    () =>
      new Promise<{ items: (typeof OPERATOR)[] }>((done) => {
        resolve = done;
      }),
  );
  const refresh = createOperatorRosterRefresher({ get }, exec, createCredentialGeneration());
  const first = refresh();
  const second = refresh();
  expect(get).toHaveBeenCalledTimes(1);
  resolve({ items: [OPERATOR] });
  await expect(Promise.all([first, second])).resolves.toEqual(["updated", "updated"]);
});
```

- [ ] **Step 2: Run roster-sync tests and confirm RED**

```bash
pnpm --filter @markiro/station exec vitest run test/roster-sync.test.ts
```

Expected: FAIL because the result and factory are absent.

- [ ] **Step 3: Implement result-bearing single-flight refresh**

Use one promise slot and clear it in `finally`:

```ts
export type OperatorRosterSyncResult = "updated" | "unavailable";

export function createOperatorRosterRefresher(
  client: Pick<StationClient, "get">,
  exec: SqlExecutor,
  generation?: CredentialGeneration,
): () => Promise<OperatorRosterSyncResult> {
  let inFlight: Promise<OperatorRosterSyncResult> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = syncOperatorRoster(client, exec, generation).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
```

Return `updated` only after atomic publication; catch sanitized errors and return `unavailable` while preserving the old mirror.

- [ ] **Step 4: Write failing OperatorLogin behavior tests**

Cover all branches with real SQLite mirrors:

```ts
it("refreshes once after a badge miss and retries only the local badge check", async () => {
  const exec = makeExec();
  await applyMigrations(exec);
  const scanner = manualSource();
  const refreshRoster = vi.fn(async () => {
    await replaceOperatorsMirror(exec, [{
      operatorId: "op-new",
      name: "New Operator",
      login: "1002",
      role: "operator",
      pinHash: await hashSecret("4821"),
      badgeHash: await hashSecret("NEW-BADGE"),
      active: true,
    }]);
    return "updated" as const;
  });
  const onAuthed = vi.fn();
  render(<OperatorLogin exec={exec} source={scanner.source} online refreshRoster={refreshRoster} onAuthed={onAuthed} />);
  act(() => scanner.scan("NEW-BADGE"));
  expect(await screen.findByText("Refreshing operator list…")).toBeDefined();
  await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  expect(refreshRoster).toHaveBeenCalledTimes(1);
});
```

Add independent tests for: offline badge miss with zero refresh calls; refresh failure showing the safe message; PIN miss followed by refresh and local success; cached name results appearing before a pending background refresh; refreshed name results replacing the list; retained scanner callback cannot authenticate after unmount.
Update every existing `OperatorLogin` render in this test file with an explicit `online` value so each case declares whether network fallback is allowed.

- [ ] **Step 5: Run login tests and confirm RED**

```bash
pnpm --filter @markiro/station exec vitest run test/operator-login.test.tsx
```

Expected: FAIL because the props and retry flow are absent.

- [ ] **Step 6: Implement one-refresh local retry**

Factor the repeated sequence inside `OperatorLogin` without accepting a server credential verifier. Replace the string-only error state with `AuthMessage = { tone: "info" | "error"; text: string } | null` so refresh progress is not rendered as a red failure:

```ts
type RefreshedLocalResult<T> =
  { kind: "matched"; value: T } | { kind: "miss" } | { kind: "unavailable" };

async function refreshAfterMiss<T>(
  verifyLocal: () => Promise<T | null>,
): Promise<RefreshedLocalResult<T>> {
  if (!online || !refreshRoster) return { kind: "miss" };
  setMessage({ tone: "info", text: t("login.refreshingRoster") });
  const result = await refreshRoster();
  if (result === "unavailable") {
    setMessage({ tone: "error", text: t("login.rosterRefreshUnavailable") });
    return { kind: "unavailable" };
  }
  const value = await verifyLocal();
  return value ? { kind: "matched", value } : { kind: "miss" };
}
```

Badge and PIN handlers call their local verifier first, call this helper only on `null`, and never recurse. `matched` authenticates, `miss` shows the existing invalid-credential copy, and `unavailable` preserves the refresh-specific error instead of overwriting it. Name search reads and renders the mirror first, then starts `refreshRoster()` without blocking the cached results; after `updated`, reread the mirror and publish only if still mounted and still in the search stage.

- [ ] **Step 7: Wire one refresher through App**

Memoize `createOperatorRosterRefresher(authenticatedClient, tauriExecutor, credentialGeneration)` by credential identity. Use the same function for startup, browser-online retry, and `OperatorLogin`. Pass `online={browserOnline}`. A rejected credential continues through the existing seal/recovery boundary.

- [ ] **Step 8: Run focused tests and confirm GREEN**

```bash
pnpm --filter @markiro/station exec vitest run test/roster-sync.test.ts test/operator-login.test.tsx test/App.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit live roster authentication**

```bash
git add apps/station/src/lib/roster-sync.ts apps/station/src/pages/OperatorLogin.tsx apps/station/src/App.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/roster-sync.test.ts apps/station/test/operator-login.test.tsx apps/station/test/App.test.tsx
git commit -m "fix(station): refresh operators during sign in"
```

---

### Task 4: Replace the badge placeholder and clarify shift recovery

**Files:**

- Create: `apps/station/src/ui/BadgeScanIllustration.tsx`
- Create: `apps/station/test/badge-scan-illustration.test.tsx`
- Modify: `apps/station/src/pages/OperatorLogin.tsx:185-260`
- Modify: `apps/station/test/operator-login.test.tsx:30-120`
- Modify: `apps/station/src/pages/ShiftSelection.tsx:65-105`
- Modify: `apps/station/test/shift-selection.test.tsx:65-125`
- Modify: `apps/station/src/i18n/ru.json:75-140`
- Modify: `apps/station/src/i18n/en.json:75-140`
- Modify: `apps/station/src/station.css:1320-1390`

**Interfaces:**

- Produces: `BadgeScanIllustration(): JSX.Element`, decorative and bundled.
- Preserves: existing name and numeric login actions.

- [ ] **Step 1: Write failing illustration and copy tests**

Assert the badge stage contains one SVG with stable parts and no placeholder glyph:

```ts
expect(screen.getByTestId("badge-scan-illustration")).toBeDefined();
expect(screen.getByText("Hold the badge near the scanner")).toBeDefined();
expect(container.textContent).not.toContain("▣");
expect(stationCss).not.toMatch(/operator-login__badge-panel[^}]*dashed/s);
```

The SVG component test asserts `aria-hidden="true"`, `focusable="false"`, and child classes for badge, barcode, scanner, and beam. It must contain no `<image>` or external URL.

- [ ] **Step 2: Write failing transport-specific ShiftSelection test**

Make `fetch` reject with `TypeError("Failed to fetch")`; assert the alert reads `Could not load shifts. Check server access.` and that Retry, New shift, Workstation setup, and Conflicts remain present. Retain a separate API-error test proving safe server messages are still shown.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
pnpm --filter @markiro/station exec vitest run test/badge-scan-illustration.test.tsx test/operator-login.test.tsx test/shift-selection.test.tsx
```

Expected: FAIL because the illustration and copy do not exist.

- [ ] **Step 4: Implement the bundled SVG and layout**

Render a semantic wrapper and inline SVG:

```tsx
export function BadgeScanIllustration() {
  return (
    <svg
      data-testid="badge-scan-illustration"
      className="badge-scan-illustration"
      viewBox="0 0 240 160"
      aria-hidden="true"
      focusable="false"
    >
      <g className="badge-scan-illustration__badge">
        <rect x="18" y="58" width="126" height="82" rx="10" />
        <rect x="34" y="76" width="28" height="28" rx="4" />
      </g>
      <g className="badge-scan-illustration__barcode">
        <path d="M78 106v22m6-22v22m8-22v22m5-22v22m9-22v22m6-22v22m10-22v22" />
      </g>
      <g className="badge-scan-illustration__scanner">
        <path d="M154 32 211 20a10 10 0 0 1 12 8l5 24a10 10 0 0 1-8 12l-14 3 10 39-20 5-16-38-17 4a10 10 0 0 1-12-8l-5-25a10 10 0 0 1 8-12Z" />
      </g>
      <path className="badge-scan-illustration__beam" d="M142 65 90 83" />
    </svg>
  );
}
```

Replace the dashed panel with a two-column instruction card, use only Markiro tokens, and color only the scan beam with `--accent-module`. Put the full RU/EN copy in i18n.

- [ ] **Step 5: Implement transport-specific shift copy**

Treat `StationApiError` as a server message and all other request failures as `shifts.serverUnavailable`. Keep `loadFailed=true`, Retry, and the fixed footer; do not clear operator or cached station state.

- [ ] **Step 6: Run focused tests and confirm GREEN**

```bash
pnpm --filter @markiro/station exec vitest run test/badge-scan-illustration.test.tsx test/operator-login.test.tsx test/shift-selection.test.tsx test/i18n.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit scan and recovery presentation**

```bash
git add apps/station/src/ui/BadgeScanIllustration.tsx apps/station/src/pages/OperatorLogin.tsx apps/station/src/pages/ShiftSelection.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/src/station.css apps/station/test/badge-scan-illustration.test.tsx apps/station/test/operator-login.test.tsx apps/station/test/shift-selection.test.tsx apps/station/test/i18n.test.tsx
git commit -m "fix(station): clarify badge and shift recovery"
```

---

### Task 5: Put floor status and actions into one non-overlapping header

**Files:**

- Modify: `apps/station/src/ui/StatusBar.tsx:20-145`
- Modify: `apps/station/src/ui/FloorShell.tsx:1-85`
- Modify: `apps/station/src/App.tsx:930-975`
- Modify: `apps/station/src/station.css:45-65, 1940-2140`
- Modify: `apps/station/test/status-bar.test.tsx:1-180`
- Modify: `apps/station/test/floor-shell.test.tsx:55-150`
- Modify: `apps/station/test/fixed-viewport-source.test.tsx:1-125`

**Interfaces:**

- Changes: `FloorShellProps.windowChrome` to `windowControl?: ReactNode`.
- Extends: `StatusBarProps` with `windowControl?: ReactNode` and `operatorControl?: ReactNode`.
- Preserves: one semantic banner, update severity metadata, and the onboarding/setup floating window control outside FloorShell.

- [ ] **Step 1: Write failing normal-flow header tests**

Replace the old separate-chrome-row assertion with:

```ts
const header = screen.getByRole("banner", { name: "Station status" });
expect(within(header).getByRole("button", { name: "Window mode" })).toBeDefined();
expect(container.querySelector(".station-floor-window-chrome")).toBeNull();
expect(getComputedStyle(header).display).toBe("grid");
expect(getComputedStyle(within(header).getByRole("button", { name: "Window mode" })).position).toBe(
  "static",
);
```

In the source contract assert `.station-update-indicator` is not absolute, `.station-status-actions` is a grid, the compact media rule gives actions a dedicated row, and every action retains `min-height: 64px`.

- [ ] **Step 2: Run shell tests and confirm RED**

```bash
pnpm --filter @markiro/station exec vitest run test/status-bar.test.tsx test/floor-shell.test.tsx test/fixed-viewport-source.test.tsx
```

Expected: FAIL because the separate row and absolute update indicator remain.

- [ ] **Step 3: Implement the header composition**

Render the action rail as the last grid item inside the existing `<header>`:

```tsx
<div className="station-status-actions" aria-label={t("shell.stationActions")}>
  {updateButton}
  {operatorControl}
  {windowControl}
</div>
```

Remove `.station-floor-window-chrome`. Make `.station-update-indicator` static and assign each action a bounded cell. Use an explicit wide grid and this compact structure:

```css
@media (max-width: 1179px) {
  .station-status-bar {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .station-status-actions {
    grid-column: 1 / -1;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
```

Keep the authenticated header and footer inside `.station-root`'s flex height; do not use viewport-positioned controls.

- [ ] **Step 4: Run shell and gallery tests**

```bash
pnpm --filter @markiro/station exec vitest run test/status-bar.test.tsx test/floor-shell.test.tsx test/fixed-viewport-source.test.tsx test/screen-gallery.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the floor header**

```bash
git add apps/station/src/ui/StatusBar.tsx apps/station/src/ui/FloorShell.tsx apps/station/src/App.tsx apps/station/src/station.css apps/station/test/status-bar.test.tsx apps/station/test/floor-shell.test.tsx apps/station/test/fixed-viewport-source.test.tsx apps/station/test/screen-gallery.test.tsx
git commit -m "fix(station): reserve floor header actions"
```

---

### Task 6: Switch operators across a durable local-work boundary

**Files:**

- Create: `apps/station/src/ui/OperatorSwitchControl.tsx`
- Create: `apps/station/test/operator-switch-control.test.tsx`
- Modify: `apps/station/src/lib/credential-recovery.ts:125-190`
- Modify: `apps/station/test/credential-recovery.test.ts:120-260`
- Modify: `apps/station/src/App.tsx:180-1030`
- Modify: `apps/station/test/App.test.tsx:520-690, 2250-2560`
- Modify: `apps/station/src/i18n/ru.json:145-190`
- Modify: `apps/station/src/i18n/en.json:145-190`
- Modify: `apps/station/src/station.css:65-125`

**Interfaces:**

- Produces: `retireFloorWork(barriers: Iterable<FloorWorkBarrier>, timeoutMs?: number): Promise<void>`.
- Extends: `FloorWorkBarrier` with optional `close?: () => Promise<void>` while retaining `idle(): Promise<void>`.
- Produces: `OperatorSwitchControlProps = { activeShift: boolean; pending: boolean; error: boolean; onSwitch: () => Promise<void>; onDismissError: () => void }`.
- Consumes: Task 5's `operatorControl` slot.

- [ ] **Step 1: Write failing retirement-boundary tests**

Add these cases in `credential-recovery.test.ts`:

```ts
it("closes intake before waiting for accepted floor work", async () => {
  const order: string[] = [];
  const barrier = {
    close: vi.fn(async () => {
      order.push("close");
    }),
    idle: vi.fn(async () => {
      order.push("idle");
    }),
  };
  await retireFloorWork([barrier]);
  expect(order[0]).toBe("close");
});

it("rejects a bounded retirement timeout", async () => {
  vi.useFakeTimers();
  const pending = retireFloorWork(
    [{ close: () => new Promise(() => {}), idle: async () => {} }],
    50,
  );
  const assertion = expect(pending).rejects.toBeInstanceOf(FloorWorkBarrierTimeoutError);
  await vi.advanceTimersByTimeAsync(51);
  await assertion;
});
```

- [ ] **Step 2: Implement bounded retirement**

Snapshot the iterable, synchronously call every available `close()` before awaiting, then race completion against the existing 5-second timeout. For a legacy barrier without `close`, await `idle`. Keep `readSealedWorkSummary` behavior unchanged.

- [ ] **Step 3: Write failing OperatorSwitchControl tests**

Cover: no active shift calls `onSwitch` immediately; active shift opens `FullScreenDialog`; Stay closes it; confirm calls once; pending disables controls and shows `Saving the current operation…`; rejection/error renders a 64px Retry and leaves the control mounted.

- [ ] **Step 4: Implement the control**

Reuse `Button size="floor"` and `FullScreenDialog`:

```tsx
<FullScreenDialog
  open={confirming}
  title={t("operatorSwitch.confirmTitle")}
  backLabel={t("operatorSwitch.stay")}
  onClose={() => setConfirming(false)}
  footer={
    <Button size="floor" onClick={() => void runSwitch()}>
      {t("operatorSwitch.confirm")}
    </Button>
  }
>
  <p>{t("operatorSwitch.confirmDetail")}</p>
</FullScreenDialog>
```

Define `runSwitch` as an async function that closes the confirmation, awaits `onSwitch`, and catches the rejection because App has already published the safe `error` prop:

```ts
async function runSwitch(): Promise<void> {
  setConfirming(false);
  try {
    await onSwitch();
  } catch {
    // App owns the retryable, translated failure state.
  }
}
```

The visible header action label is “Сменить оператора” / “Change operator”. The no-shift action also calls `runSwitch`, never a floating promise.

- [ ] **Step 5: Write failing App integration tests**

Add one no-shift test that signs in, clicks Change operator, and immediately returns to badge login without clearing the credential or outbox. Add one active-shift test that:

1. opens and mirrors a shift so WorkScreen renders;
2. queues a scan whose SQLite journal write is held by a promise;
3. confirms Change operator;
4. asserts badge login is not visible while the write is held;
5. releases the write and asserts badge login appears;
6. signs in as a second operator and asserts the same shift screen resumes;
7. inspects journal parameters so the first entry has `op1` and the next entry has the second operator ID.

Add a timeout test using fake timers: after retirement times out, the old operator name and retryable switch error remain, and no credential/data deletion command was called.

- [ ] **Step 6: Implement App's two-phase switch**

Use explicit state:

```ts
type OperatorSwitchState = "idle" | "settling" | "failed";
const [operatorSwitchState, setOperatorSwitchState] = useState<OperatorSwitchState>("idle");

async function switchOperator(): Promise<void> {
  setOperatorSwitchState("settling");
  try {
    await retireFloorWork(floorWorkRegistry.current());
    setShowSetup(false);
    setShowConflicts(false);
    setShowUpdates(false);
    if (!shift) setFloorView("select");
    setOperator(null);
    setOperatorSwitchState("idle");
  } catch {
    setOperatorSwitchState("failed");
    throw new Error("operator switch did not settle");
  }
}
```

While `settling`, replace the active floor content with a bounded status screen and do not render `WorkScreen`; this initiates its cleanup while `retireFloorWork` has already closed intake. Do not clear `shift`, `shiftContext`, `boxCapacity`, or `issuerPrefix`. After the next `onAuthed`, existing routing resumes that shift. Do not wait for server sync and do not call a close-shift endpoint.
The remounted WorkScreen reloads the current box and its durable count from SQLite. Its accepted/rejected session counters intentionally restart at zero for the new operator.

- [ ] **Step 7: Run focused operator-switch tests and confirm GREEN**

```bash
pnpm --filter @markiro/station exec vitest run test/credential-recovery.test.ts test/operator-switch-control.test.tsx test/App.test.tsx test/work-screen.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit operator switching**

```bash
git add apps/station/src/ui/OperatorSwitchControl.tsx apps/station/src/lib/credential-recovery.ts apps/station/src/App.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/src/station.css apps/station/test/operator-switch-control.test.tsx apps/station/test/credential-recovery.test.ts apps/station/test/App.test.tsx apps/station/test/work-screen.test.tsx
git commit -m "feat(station): switch floor operators safely"
```

---

### Task 7: Validate the beta slice and document Windows acceptance

**Files:**

- Modify: `docs/hardware-acceptance-checklist.md`
- Modify: `docs/superpowers/specs/2026-08-12-station-live-roster-and-floor-recovery-design.md`
- Verify: all files committed by Tasks 1–6

**Interfaces:**

- Consumes: complete behavior from Tasks 1–6.
- Produces: explicit automated and manual acceptance record; no claim of Windows verification until it is performed on the beta installer.

- [ ] **Step 1: Add the exact manual acceptance section**

Append unchecked checklist items for:

```markdown
- [ ] Create an active Station operator while badge login is already open; scan the new badge without restarting.
- [ ] Disconnect the network; authenticate a previously cached operator without an HTTP request.
- [ ] Load, open, create, and rejoin a shift through `https://admin.markiro.app`.
- [ ] At 1280×800, 1024×768, and 1280×720, verify Update, Change operator, and window-mode controls do not overlap status or each other.
- [ ] During an active shift, queue a scan, change operator, and verify the same shift resumes with correct old/new attribution.
- [ ] Exercise keyboard-wedge and configured serial scanner input on Windows/WebView2 hardware.
- [ ] Reveal and hide the Windows taskbar; verify the footer and all floor actions remain recoverable.
```

- [ ] **Step 2: Run the complete Station gates**

```bash
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: all pass. Report Rust as host validation, not Windows validation.

- [ ] **Step 3: Run release and production contracts**

```bash
node --test tools/station-release/test/*.test.mjs
pnpm test:production-bundle:contract
```

Expected: all pass. If container, loopback, or sandbox infrastructure prevents a production case, identify the exact blocked tests and do not mark the suite complete.

- [ ] **Step 4: Run formatting and diff hygiene**

```bash
pnpm format:check
git diff --check
git diff main...HEAD --check
git status --short
```

Expected: formatting and diff checks pass; status contains no untracked test output, secrets, generated Tauri targets, or local environment files.

- [ ] **Step 5: Update spec status and commit acceptance documentation**

After all automated gates above pass, change the spec status from `Approved` to `Implemented; Windows acceptance pending`. Leave every unperformed Windows checklist item unchecked.

```bash
git add docs/hardware-acceptance-checklist.md docs/superpowers/specs/2026-08-12-station-live-roster-and-floor-recovery-design.md docs/superpowers/plans/2026-08-12-station-live-roster-and-floor-recovery.md
git commit -m "docs(station): record floor recovery acceptance"
```

- [ ] **Step 6: Prepare the beta handoff without releasing yet**

Record the commit SHA, automated gate totals, checks not run, and the production deployment ordering: deploy the Caddy route change first, verify the expanded live CORS gate, then start the next Station beta build. Do not trigger production deployment or a beta release without the user's explicit instruction at that stage.
