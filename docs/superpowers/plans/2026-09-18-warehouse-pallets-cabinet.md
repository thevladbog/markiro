# Warehouse Pallets — Plan 3 of 3: Cabinet (`apps/admin`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an office manager see every pallet of the organisation (production and warehouse) in one registry, open a warehouse pallet's card with its cross-shift boxes and refused memberships, order the per-pallet GIS MT aggregation export, start its disassembly, and grant an employee the right to build pallets on a handheld.

**Architecture:** Everything is client-only: the API endpoints shipped in PR #595 (`GET /pallets` org-wide with cursor, `GET /code-search/pallets/:id` with `kind`/`rejections`, `POST|GET /pallets/:id/exports`, `GET /pallet-exports/formats`, `PATCH /employees/:id/pickup-policy` with `canBuildPallets`). The registry becomes a third tab of the existing code-search section (`/codes`, `/boxes`, **`/pallets`**) paged with `useInfiniteQuery`. The pallet card grows a kind chip, a shift-less header, box origin shifts, a rejections table, an inline exports section and a «Расформировать» action. The export history UI (`HistoryRow`, `ArtifactRow`, error mapping) is extracted from `ShiftExportsDialog.tsx` into a shared module so the pallet section reuses it byte-for-byte.

**Tech Stack:** React 19, Vite, TanStack Query 5, react-router 7 (data router), `@markiro/ui`, `@markiro/domain`, react-i18next (RU + EN in lockstep), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-17-warehouse-pallet-aggregation-design.md` §4 (Cabinet). Server (plan 1) merged in PR #595, handheld (plan 2) merged in PR #596.

## Global Constraints

- Branch `claude/warehouse-pallets-cabinet` cut from `origin/main` (`2d10acf74`). Commit only paths you changed; messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Every user-visible string goes through `t()` and is added to BOTH `apps/admin/src/i18n/ru.json` and `apps/admin/src/i18n/en.json`; `apps/admin/test/i18n.test.tsx` fails on any key present in one file only, and a missing key throws inside component tests.
- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: spread optional props conditionally (`{...(x ? { prop: x } : {})}`), no `!` except the established `queryFn: () => fetch(id!)` behind `enabled`.
- The cabinet shows every SSCC in the 20-digit AI-00 form via `formatSsccHri` from `@markiro/domain`; the server already returns 20 digits.
- Access: the registry, the card and its exports are `OPERATIONS_READ` (like `/codes`, `/boxes`); the «Расформировать» action and the employee checkbox need `OPERATIONS_WRITE` (`useCan(CABINET_CAPABILITY.OPERATIONS_WRITE)` from `apps/admin/src/access/context.ts`).
- Wire facts from `apps/api`: `GET /pallets?kind=&productId=&deviceId=&closedFrom=<ISO instant>&closedTo=<ISO instant>&limit=&cursor=` returns `{ items: PalletDto[], nextCursor?: string }` (org-wide default limit 100, max 500). `PalletDto` gained `kind`, `productId`, `productName`, `deviceName`, `rejectedMembershipCount`. Card `PalletCardDto` gained `kind`, nullable `shiftId`, `rejections[]` (reasons `already_on_pallet | not_found | not_closed | disassembled | pallet_closed | product_mismatch`), box rows gained `shiftId`, `shiftNumber`, `productionDate`. Exports: `ShiftExportDto.shiftId: string | null`, `palletId: string | null`, `formatId` may be `pallet_xml_gismt_aggregation`; pallet export body `{ formatId, formatVersion, idempotencyKey }` (no `maxLines`); new safe error codes `PALLET_NOT_CLOSED`, `PALLET_DISASSEMBLED`. Employee `pickupPolicy.canBuildPallets: boolean` is returned always and accepted optionally on PATCH.
- Tests use the repository's stub style: `vi.stubGlobal("fetch", vi.fn(async (input, init) => jsonResponse(...)))`, `jsonResponse` from `apps/admin/test/helpers/http.ts`, `QueryClient` with `retry: false`, `MemoryRouter`/`createMemoryRouter`, `cleanup()` + `vi.unstubAllGlobals()` in `afterEach`. Assert RU strings (tests run in `ru`).
- Gates for `apps/admin` (run from repo root): `pnpm --filter @markiro/admin exec vitest run test/<file>` per task, then `pnpm --filter @markiro/admin test`, `typecheck`, `lint`, `build`, and `pnpm format:check` at the end. In a fresh worktree build the deps first: `pnpm turbo run build --filter='@markiro/admin^...'`.
- Automated DOM tests are not browser confirmation; the final report states that the browser was not exercised unless it was.

---

## File map

| Path (under `apps/admin/`)                                                                                                 | Responsibility                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/pages/shifts/pallets-api.ts`                                                                                          | `PalletDto` widened; `PalletListFilters`, `useInfinitePallets` (org-wide, cursor)             |
| `src/pages/pallets/index.tsx` (new)                                                                                        | `PalletsPage`: filters, table, «Показать ещё»                                                 |
| `src/pages/code-search/RegistryTabs.tsx`                                                                                   | third tab `pallets` → `/pallets`                                                              |
| `src/app.tsx`, `src/layout/AppShell.tsx`                                                                                   | `/pallets` route; sidebar keeps «Поиск кодов» lit on `/pallets`                               |
| `src/pages/code-search/api.ts`                                                                                             | `PalletCardDto` widened (`kind`, nullable `shiftId`, `rejections`, box origin shift)          |
| `src/pages/code-search/PalletCard.tsx`                                                                                     | kind chip, shift-less header, box shift column, rejections, exports section, «Расформировать» |
| `src/pages/shifts/export-history.tsx` (new)                                                                                | `EXPORT_SAFE_ERROR_CODES`, `exportErrorMessage`, `HistoryRow`, `ArtifactRow`, `ExportHistory` |
| `src/pages/shifts/shift-exports-api.ts`                                                                                    | `ShiftExportDto` widened; retry scoped by shift OR pallet; pallet formats/list/create hooks   |
| `src/pages/shifts/ShiftExportsDialog.tsx`                                                                                  | consumes `export-history.tsx`; behaviour unchanged                                            |
| `src/pages/code-search/PalletExportsSection.tsx` (new)                                                                     | one-format create form + shared history for a pallet                                          |
| `src/pages/disaggregation/DocumentDetail.tsx`                                                                              | `AddLinesPanel` prefills from `?sscc=`                                                        |
| `src/pages/employees/api.ts`, `EmployeePickupPolicySection.tsx`                                                            | `canBuildPallets` in DTO/input and as a checkbox                                              |
| `src/i18n/ru.json`, `src/i18n/en.json`                                                                                     | new keys, both languages                                                                      |
| `test/warehouse-pallets-api.test.tsx` (new)                                                                                | `useInfinitePallets` URL + cursor                                                             |
| `test/warehouse-pallets.test.tsx` (new)                                                                                    | registry page, card additions, exports section, disassemble action                            |
| `test/pallets.test.tsx`, `test/access-routing.test.tsx`, `test/disaggregation-detail.test.tsx`, `test/employees*.test.tsx` | fixtures widened; routing + prefill + checkbox cases                                          |

---

### Task 1: Pallet list client — widened `PalletDto` and the org-wide infinite query

**Files:**

- Modify: `apps/admin/src/pages/shifts/pallets-api.ts`
- Modify: `apps/admin/test/pallets.test.tsx:96-107` (the `PALLET` fixture)
- Test: `apps/admin/test/warehouse-pallets-api.test.tsx` (new)

**Interfaces:**

- Consumes: `apiFetch<T>(path)` from `apps/admin/src/api/client.ts` (base `/api`).
- Produces (used by Task 2):

  ```ts
  export type PalletKind = "production" | "warehouse";
  export interface PalletListFilters {
    kind?: PalletKind;
    productId?: string;
    deviceId?: string;
    closedFrom?: string;
    closedTo?: string;
  }
  export const PALLET_LIST_PAGE_SIZE = 100;
  export function useInfinitePallets(
    filters: PalletListFilters,
  ): UseInfiniteQueryResult<InfiniteData<ListPalletsResponse, string | undefined>>;
  ```

  `PalletDto` gains `kind: PalletKind; productId: string | null; productName: string | null; deviceName: string | null; rejectedMembershipCount: number`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/test/warehouse-pallets-api.test.tsx`:

```tsx
/**
 * The org-wide pallet list client (warehouse pallets, plan 3 Task 1): the
 * request it builds from filters and the cursor it carries into the next page.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useInfinitePallets, type PalletDto } from "../src/pages/shifts/pallets-api.js";
import { jsonResponse } from "./helpers/http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const WAREHOUSE_PALLET: PalletDto = {
  id: "pal-w1",
  sscc: "00104600682000000019",
  kind: "warehouse",
  productId: "p1",
  productName: "Молоко 1л",
  deviceName: "ТСД-1",
  rejectedMembershipCount: 2,
  terminalId: "hh-1",
  lineName: null,
  operatorId: null,
  boxCount: 30,
  unitCount: 600,
  closedAt: "2026-09-17T10:00:00.000Z",
  contentsChangedAfterClose: false,
  disassembledAt: null,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useInfinitePallets", () => {
  it("requests the org-wide list with only the set filters and pages by cursor", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("cursor=")) {
        return jsonResponse(200, { items: [{ ...WAREHOUSE_PALLET, id: "pal-w2" }] });
      }
      return jsonResponse(200, { items: [WAREHOUSE_PALLET], nextCursor: "abc" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () =>
        useInfinitePallets({
          kind: "warehouse",
          productId: "p1",
          closedFrom: "2026-09-01T00:00:00.000Z",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/pallets?kind=warehouse&productId=p1&closedFrom=2026-09-01T00%3A00%3A00.000Z&limit=100",
    );
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "/api/pallets?kind=warehouse&productId=p1&closedFrom=2026-09-01T00%3A00%3A00.000Z&limit=100&cursor=abc",
    );
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.data?.pages.flatMap((page) => page.items).map((row) => row.id)).toEqual([
      "pal-w1",
      "pal-w2",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets-api.test.tsx`
Expected: FAIL — `useInfinitePallets` is not exported (and `PalletDto` lacks `kind`).

- [ ] **Step 3: Widen the DTO and add the hook**

Replace the whole of `apps/admin/src/pages/shifts/pallets-api.ts` with:

```ts
/**
 * Typed fetchers + TanStack Query hooks for `GET /pallets`. Thin wrapper over
 * `../../api/client.ts`'s `apiFetch` -- see that module for the shared base
 * URL, credentials, and error-message parsing.
 *
 * Two consumers, two hooks:
 * - `usePallets(shiftId)` is the shift panel's list (06d): the WHOLE shift,
 *   no paging -- the server sends no `LIMIT` when `shiftId` is given without
 *   `limit`, precisely so this reader keeps seeing every pallet.
 * - `useInfinitePallets(filters)` is the org-wide registry (warehouse pallets,
 *   plan 3): a keyset page of `PALLET_LIST_PAGE_SIZE` rows at a time, in the
 *   server's `closed_at DESC NULLS FIRST, id ASC` order, continued with the
 *   `nextCursor` the server issued. The cursor is opaque here.
 *
 * ONE DIFFERENCE FROM THE BOX CLIENT, and it matters for error handling:
 * `GET /pallets` 404s for a `shiftId` that does not exist or belongs to
 * another tenant (`PalletsService.listPallets`), where `GET /boxes` returns
 * an empty list instead. A caller must therefore treat the error state as a
 * real failure to report, not as "this shift has no pallets".
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

export type PalletKind = "production" | "warehouse";

/** Mirrors `apps/api/src/modules/pallets/dto.ts`'s `PalletDto`, `Date` fields as `string`. */
export interface PalletDto {
  id: string;
  /** 20-значный код с GS1 AI "00" (требование Честного знака); в БД хранится голый 18-значный SSCC. */
  sscc: string | null;
  /** `warehouse` is built on a handheld from closed boxes of arbitrary shifts. */
  kind: PalletKind;
  /** A warehouse pallet's own product; a production pallet's through its shift. */
  productId: string | null;
  productName: string | null;
  /** Name of the station/handheld that reported this pallet, when resolvable. */
  deviceName: string | null;
  /** Memberships the server refused for this pallet; always 0 for a production one. */
  rejectedMembershipCount: number;
  terminalId: string | null;
  /** Assigned production line of the station that reported this pallet. */
  lineName: string | null;
  operatorId: string | null;
  /** Member boxes that are closed and not disassembled. */
  boxCount: number;
  /** Live items across those member boxes -- a disassembled box's items are off the stack too. */
  unitCount: number;
  closedAt: string | null;
  /** A member box was disassembled after this pallet closed: it is short a box it can no longer correct. */
  contentsChangedAfterClose: boolean;
  disassembledAt: string | null;
}

/** `GET /pallets` response; `nextCursor` is absent on the last page and on an unpaged shift list. */
export interface ListPalletsResponse {
  items: PalletDto[];
  nextCursor?: string;
}

/** Org-wide registry filters; every field maps 1:1 onto a `GET /pallets` query parameter. */
export interface PalletListFilters {
  kind?: PalletKind;
  productId?: string;
  deviceId?: string;
  /** ISO instant, inclusive lower bound on `closedAt`. */
  closedFrom?: string;
  /** ISO instant, inclusive upper bound on `closedAt`. */
  closedTo?: string;
}

/** The server's own default; its ceiling is 500. */
export const PALLET_LIST_PAGE_SIZE = 100;

/** Shared TanStack Query cache key prefix for the pallets list (all variants). */
export const PALLETS_QUERY_KEY = ["pallets"] as const;

function buildListPath(shiftId: string): string {
  return `/pallets?${new URLSearchParams({ shiftId }).toString()}`;
}

function buildRegistryPath(filters: PalletListFilters, cursor: string | undefined): string {
  const query = new URLSearchParams();
  if (filters.kind) query.set("kind", filters.kind);
  if (filters.productId) query.set("productId", filters.productId);
  if (filters.deviceId) query.set("deviceId", filters.deviceId);
  if (filters.closedFrom) query.set("closedFrom", filters.closedFrom);
  if (filters.closedTo) query.set("closedTo", filters.closedTo);
  query.set("limit", String(PALLET_LIST_PAGE_SIZE));
  if (cursor) query.set("cursor", cursor);
  return `/pallets?${query.toString()}`;
}

async function fetchPallets(shiftId: string): Promise<PalletDto[]> {
  const response = await apiFetch<ListPalletsResponse>(buildListPath(shiftId));
  return response.items;
}

function fetchPalletPage(
  filters: PalletListFilters,
  cursor: string | undefined,
): Promise<ListPalletsResponse> {
  return apiFetch<ListPalletsResponse>(buildRegistryPath(filters, cursor));
}

/**
 * `GET /pallets?shiftId=`. Disabled (no request sent) while no shift is
 * selected, and callers should also leave it disabled for a shift that never
 * enabled pallets -- the answer is known to be empty, and asking anyway
 * spends a request per panel open on every non-pallet shift in the plant.
 */
export function usePallets(shiftId: string | undefined): UseQueryResult<PalletDto[]> {
  return useQuery({
    queryKey: [...PALLETS_QUERY_KEY, shiftId],
    queryFn: () => fetchPallets(shiftId!),
    enabled: Boolean(shiftId),
  });
}

/**
 * Org-wide `GET /pallets` with keyset paging. `filters` is part of the cache
 * key, so changing any filter starts a fresh first page rather than appending
 * to the previous list.
 */
export function useInfinitePallets(filters: PalletListFilters) {
  return useInfiniteQuery({
    queryKey: [...PALLETS_QUERY_KEY, "registry", filters] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPalletPage(filters, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
```

- [ ] **Step 4: Widen the existing `PALLET` fixture**

In `apps/admin/test/pallets.test.tsx`, replace the `PALLET` constant (lines 96–107) with:

```ts
const PALLET = {
  id: "pal-1",
  sscc: "00103460068200000004",
  kind: "production",
  productId: "p1",
  productName: "Молоко 1л",
  deviceName: "Станция 1",
  rejectedMembershipCount: 0,
  terminalId: "t1",
  lineName: "Линия розлива № 1",
  operatorId: null,
  boxCount: 12,
  unitCount: 240,
  closedAt: "2026-09-11T15:00:00.000Z",
  contentsChangedAfterClose: false,
  disassembledAt: null,
};
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets-api.test.tsx test/pallets.test.tsx && pnpm --filter @markiro/admin typecheck`
Expected: both files PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/pages/shifts/pallets-api.ts apps/admin/test/warehouse-pallets-api.test.tsx apps/admin/test/pallets.test.tsx
git commit -m "feat(admin): org-wide pallet list client with cursor paging

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `/pallets` registry page as the third code-search tab

**Files:**

- Create: `apps/admin/src/pages/pallets/index.tsx`
- Modify: `apps/admin/src/pages/code-search/RegistryTabs.tsx`
- Modify: `apps/admin/src/app.tsx:236-244` (add the route next to `boxes`)
- Modify: `apps/admin/src/layout/AppShell.tsx:200-208` and `:318-325`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/access-routing.test.tsx` (fetch stub branch + one case)
- Test: `apps/admin/test/warehouse-pallets.test.tsx` (new)

**Interfaces:**

- Consumes: `useInfinitePallets`, `PalletListFilters`, `PalletDto`, `PalletKind` (Task 1); `useProducts()` → `ProductDto[] {id, name, gtin14}` from `pages/catalog/api.ts`; `useAllDevices()` → `DeviceDto[] {id, name}` from `pages/devices/api.ts`; `formatCreatedAt(iso, language)` from `lib/datetime.ts`; `DatePicker`, `Select`, `Table`, `Badge`, `Button`, `EmptyState`, `Alert`, `Spinner`, `PageHeader` from `@markiro/ui`.
- Produces: route `/pallets` → `PalletsPage`; `RegistryTab` union `"codes" | "boxes" | "pallets"`; i18n namespace `pages.pallets.*` and `pages.codeSearch.tabs.pallets`.

- [ ] **Step 1: Write the failing tests**

Create `apps/admin/test/warehouse-pallets.test.tsx`:

```tsx
/**
 * Cabinet surfaces of warehouse pallets (plan 3): the org-wide `/pallets`
 * registry tab, the widened pallet card, its exports section and its
 * «Расформировать» action.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { PalletsPage } from "../src/pages/pallets/index.js";
import { jsonResponse } from "./helpers/http.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const READ_ONLY: AccessDocument = { roles: [], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ] };

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const WAREHOUSE_PALLET = {
  id: "pal-w1",
  sscc: "00104600682000000019",
  kind: "warehouse",
  productId: "p1",
  productName: "Молоко 1л",
  deviceName: "ТСД-1",
  rejectedMembershipCount: 2,
  terminalId: "hh-1",
  lineName: null,
  operatorId: null,
  boxCount: 30,
  unitCount: 600,
  closedAt: "2026-09-17T10:00:00.000Z",
  contentsChangedAfterClose: false,
  disassembledAt: null,
};

const PRODUCTION_PALLET = {
  ...WAREHOUSE_PALLET,
  id: "pal-p1",
  sscc: "00103460068200000004",
  kind: "production",
  deviceName: "Станция 1",
  rejectedMembershipCount: 0,
  lineName: "Линия розлива № 1",
  boxCount: 12,
  unitCount: 240,
  contentsChangedAfterClose: true,
};

type FetchBody = (url: string, init: RequestInit | undefined) => unknown;

function stubRegistryFetch(body: FetchBody) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/products" || url.startsWith("/api/products?")) {
      return jsonResponse(200, {
        items: [{ id: "p1", gtin14: "04600682000019", name: "Молоко 1л" }],
      });
    }
    if (url.includes("/api/devices")) {
      return jsonResponse(200, {
        items: [
          {
            id: "hh-1",
            type: "handheld",
            name: "ТСД-1",
            place: { id: null, name: null },
            status: "active",
            lastSeenAt: null,
            paired: true,
          },
        ],
        page: 1,
        pageSize: 50,
        total: 1,
      });
    }
    return jsonResponse(200, body(url, init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderRegistry() {
  return render(
    <QueryClientProvider client={newQueryClient()}>
      <AccessProvider value={READ_ONLY}>
        <MemoryRouter initialEntries={["/pallets"]}>
          <Routes>
            <Route path="/pallets" element={<PalletsPage />} />
          </Routes>
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
}

describe("pallets registry", () => {
  it("lists production and warehouse pallets org-wide with kind, device and warnings", async () => {
    stubRegistryFetch(() => ({ items: [WAREHOUSE_PALLET, PRODUCTION_PALLET] }));
    renderRegistry();

    expect(await screen.findByRole("tab", { name: "Паллеты" })).toBeDefined();
    const table = within(await screen.findByRole("table"));
    const warehouseLink = table.getByRole("link", { name: "(00)104600682000000019" });
    expect(warehouseLink.getAttribute("href")).toBe("/codes/pallet/pal-w1");
    expect(table.getByText("Складская")).toBeDefined();
    expect(table.getByText("Производственная")).toBeDefined();
    expect(table.getByText("ТСД-1")).toBeDefined();
    expect(table.getByText("Отказов: 2")).toBeDefined();
    expect(table.getByText("Состав изменился после закрытия")).toBeDefined();
  });

  it("sends the chosen kind, product and closure window as query parameters", async () => {
    const fetchMock = stubRegistryFetch(() => ({ items: [] }));
    renderRegistry();
    const user = userEvent.setup();

    expect(await screen.findByText("Паллет по этим условиям нет")).toBeDefined();
    await user.click(screen.getByRole("combobox", { name: "Вид паллеты" }));
    await user.click(await screen.findByRole("option", { name: "Складские" }));
    await user.click(screen.getByRole("combobox", { name: "Товар" }));
    await user.click(await screen.findByRole("option", { name: "Молоко 1л" }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls).toContain("/api/pallets?kind=warehouse&productId=p1&limit=100");
    });
  });

  it("loads the next page with the server's cursor on «Показать ещё»", async () => {
    const fetchMock = stubRegistryFetch((url) =>
      url.includes("cursor=")
        ? { items: [PRODUCTION_PALLET] }
        : { items: [WAREHOUSE_PALLET], nextCursor: "next-1" },
    );
    renderRegistry();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Показать ещё" }));

    const table = within(await screen.findByRole("table"));
    expect(await table.findByRole("link", { name: "(00)103460068200000004" })).toBeDefined();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      "/api/pallets?limit=100&cursor=next-1",
    );
    expect(screen.queryByRole("button", { name: "Показать ещё" })).toBeNull();
  });
});
```

Also, in `apps/admin/test/access-routing.test.tsx`, inside the fetch stub (after the `/api/shifts` branch at ~line 132) add:

```ts
if (path.startsWith("/api/pallets")) return jsonResponse(200, { items: [] });
```

and after the "allows operations readers to open production lines…" case add:

```ts
it("opens the pallets registry for operations readers and forbids users without read access", async () => {
  const reader = renderAccessRoute("/pallets", OPERATIONS_READ_ONLY);
  expect(await screen.findByRole("tab", { name: "Паллеты" })).toBeDefined();
  expect(screen.queryByTestId("forbidden-page")).toBeNull();
  reader.unmount();

  renderAccessRoute("/pallets", INTEGRATIONS_ONLY_ACCESS);
  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx test/access-routing.test.tsx`
Expected: FAIL — `../src/pages/pallets/index.js` does not exist; the routing case renders the not-found page.

- [ ] **Step 3: Add the tab, the route and the sidebar highlight**

`apps/admin/src/pages/code-search/RegistryTabs.tsx` — replace the file:

```tsx
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { DataTabs } from "@markiro/ui";

type RegistryTab = "codes" | "boxes" | "pallets";

const TAB_ROUTES: Record<RegistryTab, string> = {
  codes: "/codes",
  boxes: "/boxes",
  pallets: "/pallets",
};

/**
 * Segmented switch between the three code-search registries. The pages stay
 * separate routes (`/codes`, `/boxes`, `/pallets`) -- deep links and the
 * code/box/pallet cards' back actions keep working unchanged -- and only the
 * sidebar entry was collapsed into the single "Поиск кодов" item, so this
 * switch is the sole navigation between them.
 */
export function RegistryTabs({ active }: { active: RegistryTab }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <DataTabs
      items={[
        { id: "codes", label: t("pages.codeSearch.tabs.codes") },
        { id: "boxes", label: t("pages.codeSearch.tabs.boxes") },
        { id: "pallets", label: t("pages.codeSearch.tabs.pallets") },
      ]}
      activeId={active}
      onChange={(id) => {
        if (id !== active) void navigate(TAB_ROUTES[id]);
      }}
      label={t("pages.codeSearch.tabs.label")}
    />
  );
}
```

`apps/admin/src/app.tsx` — add the import next to `BoxesPage`:

```tsx
import { PalletsPage } from "./pages/pallets/index.js";
```

and add this route immediately after the `boxes/sell` route:

```tsx
<Route
  path="pallets"
  element={
    <RequireCapability capability={C.OPERATIONS_READ}>
      <PalletsPage />
    </RequireCapability>
  }
/>
```

`apps/admin/src/layout/AppShell.tsx` — both places that keep «Поиск кодов» lit. Add a module-level helper above the component (next to the other top-level helpers/constants):

```ts
/**
 * `/boxes` and `/pallets` have no sidebar entries of their own: they are the
 * "Короба" and "Паллеты" tabs inside the code-search section (see
 * pages/code-search/RegistryTabs.tsx), so the "Поиск кодов" item stays lit
 * on them too.
 */
function isCodeSearchSubRoute(pathname: string): boolean {
  return pathname.startsWith("/boxes") || pathname.startsWith("/pallets");
}
```

Then at lines ~200–208 replace

```tsx
                // /boxes lives under the code-search section as its "Короба"
                // tab, so the "Поиск кодов" item stays lit there too.
                (isActive || (item.to === "/codes" && location.pathname.startsWith("/boxes"))) &&
```

with

```tsx
                (isActive || (item.to === "/codes" && isCodeSearchSubRoute(location.pathname))) &&
```

and at lines ~318–325 replace

```tsx
const boxesRouteIsActive = item.to === "/codes" && pathname.startsWith("/boxes");
```

with

```tsx
const boxesRouteIsActive = item.to === "/codes" && isCodeSearchSubRoute(pathname);
```

(keep the variable name; it is used a few lines below). Also update the comment above the `/codes` nav item (line ~48) to mention `/pallets`.

- [ ] **Step 4: Write the page**

Create `apps/admin/src/pages/pallets/index.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { formatSsccHri } from "@markiro/domain";
import {
  Alert,
  Badge,
  Button,
  DatePicker,
  EmptyState,
  PageHeader,
  Select,
  Spinner,
  Table,
} from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { formatCreatedAt } from "../../lib/datetime.js";
import { useProducts } from "../catalog/api.js";
import { RegistryTabs } from "../code-search/RegistryTabs.js";
import { useAllDevices } from "../devices/api.js";
import {
  useInfinitePallets,
  type PalletDto,
  type PalletKind,
  type PalletListFilters,
} from "../shifts/pallets-api.js";

const ALL = "all";

type KindFilter = PalletKind | typeof ALL;

/**
 * The manager picks civil days in the browser's own zone; the server filters
 * on `closed_at` instants. A day starts at local midnight and ends at the last
 * millisecond of that local day, so «с 17.09 по 17.09» means the whole of the
 * 17th where the manager sits, not a UTC day that may straddle two local ones.
 */
function dayStartIso(civilDate: string): string {
  return new Date(`${civilDate}T00:00:00`).toISOString();
}

function dayEndIso(civilDate: string): string {
  return new Date(`${civilDate}T23:59:59.999`).toISOString();
}

/**
 * Org-wide pallet registry (warehouse pallets, plan 3): the third tab of the
 * code-search section. Unlike the shift panel's list (`usePallets(shiftId)`),
 * this one spans every shift and every warehouse pallet of the tenant, so it
 * is paged by the server's cursor and grown with «Показать ещё» rather than
 * fetched whole.
 */
export function PalletsPage() {
  const { t, i18n } = useTranslation();

  const [kind, setKind] = useState<KindFilter>(ALL);
  const [productId, setProductId] = useState<string>(ALL);
  const [deviceId, setDeviceId] = useState<string>(ALL);
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string | undefined>(undefined);

  const filters = useMemo<PalletListFilters>(
    () => ({
      ...(kind !== ALL ? { kind } : {}),
      ...(productId !== ALL ? { productId } : {}),
      ...(deviceId !== ALL ? { deviceId } : {}),
      ...(from ? { closedFrom: dayStartIso(from) } : {}),
      ...(to ? { closedTo: dayEndIso(to) } : {}),
    }),
    [kind, productId, deviceId, from, to],
  );

  const query = useInfinitePallets(filters);
  const { data: products } = useProducts();
  const { data: devices } = useAllDevices();

  const kindOptions: SelectOption[] = [
    { value: ALL, label: t("pages.pallets.filters.kindAll") },
    { value: "production", label: t("pages.pallets.filters.kindProduction") },
    { value: "warehouse", label: t("pages.pallets.filters.kindWarehouse") },
  ];
  const productOptions: SelectOption[] = useMemo(
    () => [
      { value: ALL, label: t("pages.pallets.filters.productAll") },
      ...(products ?? []).map((product) => ({ value: product.id, label: product.name })),
    ],
    [products, t],
  );
  const deviceOptions: SelectOption[] = useMemo(
    () => [
      { value: ALL, label: t("pages.pallets.filters.deviceAll") },
      ...(devices ?? []).map((device) => ({ value: device.id, label: device.name })),
    ],
    [devices, t],
  );

  const columns: TableColumn<PalletDto>[] = useMemo(
    () => [
      {
        key: "sscc",
        title: t("pages.pallets.table.sscc"),
        mono: true,
        render: (row) => (
          <Link to={`/codes/pallet/${row.id}`}>
            {row.sscc ? formatSsccHri(row.sscc) : t("pages.pallets.noSscc")}
          </Link>
        ),
      },
      {
        key: "kind",
        title: t("pages.pallets.table.kind"),
        render: (row) => (
          <Badge tone={row.kind === "warehouse" ? "accent" : "neutral"}>
            {t(`pages.pallets.kind.${row.kind}`)}
          </Badge>
        ),
      },
      {
        key: "productName",
        title: t("pages.pallets.table.product"),
        wrap: true,
        render: (row) => row.productName ?? "—",
      },
      {
        key: "deviceName",
        title: t("pages.pallets.table.device"),
        render: (row) => row.deviceName ?? "—",
      },
      {
        key: "boxCount",
        title: t("pages.pallets.table.boxCount"),
        align: "right",
        mono: true,
        render: (row) => new Intl.NumberFormat(i18n.language).format(row.boxCount),
      },
      {
        key: "unitCount",
        title: t("pages.pallets.table.unitCount"),
        align: "right",
        mono: true,
        render: (row) => new Intl.NumberFormat(i18n.language).format(row.unitCount),
      },
      {
        key: "closedAt",
        title: t("pages.pallets.table.closedAt"),
        render: (row) => (row.closedAt ? formatCreatedAt(row.closedAt, i18n.language) : "—"),
      },
      {
        key: "status",
        title: t("pages.pallets.table.status"),
        wrap: true,
        // Three independent facts, each its own badge with text (never colour
        // alone): taken apart, short a box after closing, and how many boxes
        // the server refused to put on it.
        render: (row) => (
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            {row.disassembledAt ? (
              <Badge tone="neutral">{t("pages.pallets.disassembled")}</Badge>
            ) : null}
            {row.contentsChangedAfterClose ? (
              <Badge tone="warn">{t("pages.pallets.contentsChangedAfterClose")}</Badge>
            ) : null}
            {row.rejectedMembershipCount > 0 ? (
              <Badge tone="error">
                {t("pages.pallets.rejections", {
                  count: new Intl.NumberFormat(i18n.language).format(row.rejectedMembershipCount),
                })}
              </Badge>
            ) : null}
          </span>
        ),
      },
    ],
    [t, i18n.language],
  );

  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.codeSearch.title")} />

      <RegistryTabs active="pallets" />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.pallets.filters.kindLabel")}
            options={kindOptions}
            value={kind}
            onValueChange={(value) => setKind(value as KindFilter)}
          />
        </div>
        <div style={{ width: "min(100%, 320px)" }}>
          <Select
            label={t("pages.pallets.filters.productLabel")}
            options={productOptions}
            value={productId}
            onValueChange={setProductId}
            searchable
            searchLabel={t("pages.pallets.filters.productSearchLabel")}
          />
        </div>
        <div style={{ width: "min(100%, 260px)" }}>
          <Select
            label={t("pages.pallets.filters.deviceLabel")}
            options={deviceOptions}
            value={deviceId}
            onValueChange={setDeviceId}
            searchable
            searchLabel={t("pages.pallets.filters.deviceSearchLabel")}
          />
        </div>
        <DatePicker
          label={t("pages.pallets.filters.fromLabel")}
          placeholder={t("common.datePicker.placeholder")}
          clearLabel={t("common.datePicker.clear")}
          calendarLabel={t("common.datePicker.calendar")}
          previousMonthLabel={t("common.datePicker.previousMonth")}
          nextMonthLabel={t("common.datePicker.nextMonth")}
          locale={i18n.language}
          {...(from !== undefined ? { value: from } : {})}
          onValueChange={setFrom}
        />
        <DatePicker
          label={t("pages.pallets.filters.toLabel")}
          placeholder={t("common.datePicker.placeholder")}
          clearLabel={t("common.datePicker.clear")}
          calendarLabel={t("common.datePicker.calendar")}
          previousMonthLabel={t("common.datePicker.previousMonth")}
          nextMonthLabel={t("common.datePicker.nextMonth")}
          locale={i18n.language}
          {...(to !== undefined ? { value: to } : {})}
          onValueChange={setTo}
        />
      </div>

      {query.isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : query.isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title={t("pages.pallets.empty")} />
      ) : (
        <>
          <Table
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            scrollLabel={t("pages.pallets.title")}
          />
          {query.hasNextPage ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t("pages.pallets.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add the strings (both languages)**

`apps/admin/src/i18n/ru.json` — in `pages.codeSearch.tabs` add `"pallets": "Паллеты"`; add a new `pages.pallets` object (place it right after `pages.boxes`):

```json
"pallets": {
  "title": "Паллеты",
  "empty": "Паллет по этим условиям нет",
  "noSscc": "Без SSCC",
  "loadMore": "Показать ещё",
  "disassembled": "Разобрана",
  "contentsChangedAfterClose": "Состав изменился после закрытия",
  "rejections": "Отказов: {{count}}",
  "kind": { "production": "Производственная", "warehouse": "Складская" },
  "filters": {
    "kindLabel": "Вид паллеты",
    "kindAll": "Все",
    "kindProduction": "Производственные",
    "kindWarehouse": "Складские",
    "productLabel": "Товар",
    "productAll": "Все товары",
    "productSearchLabel": "Поиск товара",
    "deviceLabel": "Устройство",
    "deviceAll": "Все устройства",
    "deviceSearchLabel": "Поиск устройства",
    "fromLabel": "Закрыта с",
    "toLabel": "Закрыта по"
  },
  "table": {
    "sscc": "SSCC",
    "kind": "Вид",
    "product": "Товар",
    "device": "Устройство",
    "boxCount": "Коробов",
    "unitCount": "Кодов",
    "closedAt": "Закрыта",
    "status": "Статус"
  }
}
```

`apps/admin/src/i18n/en.json` — `pages.codeSearch.tabs.pallets: "Pallets"` and:

```json
"pallets": {
  "title": "Pallets",
  "empty": "No pallets match these filters",
  "noSscc": "No SSCC",
  "loadMore": "Show more",
  "disassembled": "Taken apart",
  "contentsChangedAfterClose": "Contents changed after closing",
  "rejections": "Refused: {{count}}",
  "kind": { "production": "Production", "warehouse": "Warehouse" },
  "filters": {
    "kindLabel": "Pallet kind",
    "kindAll": "All",
    "kindProduction": "Production",
    "kindWarehouse": "Warehouse",
    "productLabel": "Product",
    "productAll": "All products",
    "productSearchLabel": "Search product",
    "deviceLabel": "Device",
    "deviceAll": "All devices",
    "deviceSearchLabel": "Search device",
    "fromLabel": "Closed from",
    "toLabel": "Closed to"
  },
  "table": {
    "sscc": "SSCC",
    "kind": "Kind",
    "product": "Product",
    "device": "Device",
    "boxCount": "Boxes",
    "unitCount": "Codes",
    "closedAt": "Closed",
    "status": "Status"
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx test/access-routing.test.tsx test/i18n.test.tsx test/boxes.test.tsx test/code-search.test.tsx`
Expected: all PASS. If the `Select` option role/name differs from `combobox`/`option` in your run, look at how `apps/admin/test/boxes.test.tsx` or `conflicts.test.tsx` drives `Select` and mirror that — do not weaken the URL assertion.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/pages/pallets/index.tsx apps/admin/src/pages/code-search/RegistryTabs.tsx apps/admin/src/app.tsx apps/admin/src/layout/AppShell.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/warehouse-pallets.test.tsx apps/admin/test/access-routing.test.tsx
git commit -m "feat(admin): org-wide pallets registry as a code-search tab

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pallet card — kind, shift-less header, box origin shift, refused memberships

**Files:**

- Modify: `apps/admin/src/pages/code-search/api.ts:167-200` (`PalletCardBoxDto`, `PalletCardDto`)
- Modify: `apps/admin/src/pages/code-search/PalletCard.tsx`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json` (`pages.codeSearch.palletCard.*`)
- Modify: `apps/admin/test/pallets.test.tsx:815-846` (`PALLET_CARD` fixture)
- Test: `apps/admin/test/warehouse-pallets.test.tsx` (append)

**Interfaces:**

- Produces (used by Tasks 4–5):

  ```ts
  export type PalletMembershipRejectionReason =
    | "already_on_pallet"
    | "not_found"
    | "not_closed"
    | "disassembled"
    | "pallet_closed"
    | "product_mismatch";
  export interface PalletCardRejectionDto {
    boxSscc: string;
    boxId: string | null;
    reason: PalletMembershipRejectionReason | (string & {});
    winningPalletSscc: string | null;
    addedAt: string;
    recordedAt: string;
  }
  // PalletCardDto: kind: "production" | "warehouse"; shiftId: string | null; rejections: PalletCardRejectionDto[]
  // PalletCardBoxDto: shiftId: string; shiftNumber: string | null; productionDate: string | null
  ```

- [ ] **Step 1: Write the failing tests**

In `apps/admin/test/warehouse-pallets.test.tsx`, extend the imports (the card, `useLocation` for a later case, and a write-capable access document):

```tsx
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
…
import { PalletCardPage } from "../src/pages/code-search/PalletCard.js";
…
const READ_WRITE: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};
```

then append:

```tsx
const WAREHOUSE_CARD = {
  id: "pal-w1",
  sscc: "00104600682000000019",
  status: "closed",
  kind: "warehouse",
  shiftId: null,
  shiftNumber: null,
  productId: "p1",
  productName: "Молоко 1л",
  terminalId: "hh-1",
  lineName: null,
  operatorId: null,
  openedAt: "2026-09-17T09:00:00.000Z",
  closedAt: "2026-09-17T10:00:00.000Z",
  disassembledAt: null,
  boxes: [
    {
      id: "box-1",
      sscc: "00123460682000000101",
      shiftId: "shift-a",
      shiftNumber: "SEP26-001",
      productionDate: "2026-09-10",
      itemCount: 20,
      closedAt: "2026-09-10T15:00:00.000Z",
      disassembledAt: null,
    },
    {
      id: "box-2",
      sscc: "00123460682000000102",
      shiftId: "shift-b",
      shiftNumber: "SEP26-004",
      productionDate: "2026-09-14",
      itemCount: 20,
      closedAt: "2026-09-14T15:00:00.000Z",
      disassembledAt: null,
    },
  ],
  exceptions: [],
  rejections: [
    {
      boxSscc: "00123460682000000103",
      boxId: "box-3",
      reason: "already_on_pallet",
      winningPalletSscc: "00104600682000000002",
      addedAt: "2026-09-17T09:30:00.000Z",
      recordedAt: "2026-09-17T09:31:00.000Z",
    },
    {
      boxSscc: "00123460682000000999",
      boxId: null,
      reason: "not_found",
      winningPalletSscc: null,
      addedAt: "2026-09-17T09:35:00.000Z",
      recordedAt: "2026-09-17T09:36:00.000Z",
    },
  ],
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderCard(
  card: unknown,
  access: AccessDocument = READ_ONLY,
  extra: FetchBody = () => ({ items: [] }),
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/code-search/pallets/pal-w1") return jsonResponse(200, card);
    return jsonResponse(200, extra(url, init));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={newQueryClient()}>
      <AccessProvider value={access}>
        <MemoryRouter initialEntries={["/codes/pallet/pal-w1"]}>
          <Routes>
            <Route path="/codes/pallet/:palletId" element={<PalletCardPage />} />
            <Route path="/disaggregation/:id" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { fetchMock, user: userEvent.setup() };
}

describe("warehouse pallet card", () => {
  it("shows the kind, no shift link, and each box's own origin shift", async () => {
    renderCard(WAREHOUSE_CARD);

    expect(await screen.findByRole("heading", { name: "(00)104600682000000019" })).toBeDefined();
    expect(screen.getByText("Складская")).toBeDefined();
    expect(screen.queryByRole("link", { name: /SEP26/ })).toBeNull();
    const boxes = within(screen.getByRole("region", { name: "Короба на паллете" }));
    expect(boxes.getByText("SEP26-001")).toBeDefined();
    expect(boxes.getByText("SEP26-004")).toBeDefined();
  });

  it("lists refused memberships with a readable reason and the winning pallet", async () => {
    renderCard(WAREHOUSE_CARD);

    const rejections = within(await screen.findByRole("region", { name: "Отказано в постановке" }));
    expect(rejections.getByText("(00)123460682000000103")).toBeDefined();
    expect(rejections.getByText("Уже на другой паллете")).toBeDefined();
    expect(rejections.getByText("(00)104600682000000002")).toBeDefined();
    expect(rejections.getByText("Короб не найден")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx -t "warehouse pallet card"`
Expected: FAIL — no «Складская» text, no rejections region.

- [ ] **Step 3: Widen the card types**

In `apps/admin/src/pages/code-search/api.ts` replace `PalletCardBoxDto` and `PalletCardDto` with:

```ts
/** Mirrors `apps/api/src/modules/code-search/dto.ts`'s `PalletCardBoxDto`, `Date` fields as `string`. */
export interface PalletCardBoxDto {
  id: string;
  sscc: string | null;
  /**
   * The shift this box CLOSED in -- its own origin, not the pallet's. On a
   * warehouse pallet the members come from arbitrary shifts, and that is
   * exactly what a manager needs to see.
   */
  shiftId: string;
  shiftNumber: string | null;
  /** That shift's effective production day (`YYYY-MM-DD`). */
  productionDate: string | null;
  /** Live items only, the same figure the box list reports for this box. */
  itemCount: number;
  closedAt: string | null;
  /** Non-null once this box was taken apart; it stays listed, flagged. */
  disassembledAt: string | null;
}

/** `pallet_membership_rejections.reason` values (spec §1.4). */
export type PalletMembershipRejectionReason =
  | "already_on_pallet"
  | "not_found"
  | "not_closed"
  | "disassembled"
  | "pallet_closed"
  | "product_mismatch";

/** One membership the server refused for this pallet. */
export interface PalletCardRejectionDto {
  /** 20-значный код с GS1 AI "00", как и любой SSCC в кабинете. */
  boxSscc: string;
  boxId: string | null;
  /** A known reason renders translated; an unknown one (newer server) renders raw. */
  reason: PalletMembershipRejectionReason | (string & {});
  /** The pallet that already holds the box, for `already_on_pallet`; null while that rival is still open. */
  winningPalletSscc: string | null;
  addedAt: string;
  recordedAt: string;
}

/** Mirrors `apps/api/src/modules/code-search/dto.ts`'s `PalletCardDto`, `Date` fields as `string`. */
export interface PalletCardDto {
  id: string;
  sscc: string | null;
  status: "open" | "closed" | "disassembled";
  /** `warehouse` is built on a handheld from closed boxes of arbitrary shifts. */
  kind: "production" | "warehouse";
  /** Null for a warehouse pallet, which is not tied to any shift. */
  shiftId: string | null;
  /** Saved human-readable shift number, e.g. `AUG26-003/S`. */
  shiftNumber: string | null;
  productId: string | null;
  productName: string | null;
  terminalId: string | null;
  lineName: string | null;
  operatorId: string | null;
  openedAt: string;
  closedAt: string | null;
  disassembledAt: string | null;
  boxes: PalletCardBoxDto[];
  exceptions: {
    kind: string;
    /** NOT NULL server-side, unlike a box exception's reason. */
    reason: string;
    occurredAt: string;
    operatorId: string | null;
    disaggregationDocumentId: string | null;
    disaggregationDocNo: string | null;
  }[];
  /** Always empty for a production pallet, whose boxes join it through their own closure. */
  rejections: PalletCardRejectionDto[];
}
```

- [ ] **Step 4: Update the card**

In `apps/admin/src/pages/code-search/PalletCard.tsx`:

1. Change the imports:

```tsx
import { formatSsccHri } from "@markiro/domain";
import { Alert, Badge, Button, Card, PageHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";

import { formatCreatedAt, formatDate } from "../../lib/datetime.js";
import {
  usePalletCard,
  type PalletCardBoxDto,
  type PalletCardDto,
  type PalletCardRejectionDto,
  type PalletMembershipRejectionReason,
} from "./api.js";
```

2. Add below `STATUS_TO_CHIP`:

```tsx
const REJECTION_REASONS: ReadonlySet<string> = new Set<PalletMembershipRejectionReason>([
  "already_on_pallet",
  "not_found",
  "not_closed",
  "disassembled",
  "pallet_closed",
  "product_mismatch",
]);
```

3. In `boxColumns`, insert a shift column between `sscc` and `itemCount`:

```tsx
    {
      key: "shift",
      title: t("pages.codeSearch.palletCard.table.shift"),
      wrap: true,
      // A box's OWN shift, not the pallet's: on a warehouse pallet every row
      // may come from a different one, and the production date beside the
      // number is what tells the manager how old the stack really is.
      render: (row) => (
        <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
          <Link to={`/shifts/${row.shiftId}`}>{row.shiftNumber ?? row.shiftId}</Link>
          {row.productionDate ? (
            <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
              {formatDate(row.productionDate, i18n.language)}
            </span>
          ) : null}
        </span>
      ),
    },
```

4. After `boxColumns`, add the rejections columns:

```tsx
const rejectionColumns: TableColumn<PalletCardRejectionDto>[] = [
  {
    key: "boxSscc",
    title: t("pages.codeSearch.palletCard.rejections.table.sscc"),
    mono: true,
    render: (row) =>
      row.boxId ? (
        <Link to={`/codes/box/${row.boxId}`}>{formatSsccHri(row.boxSscc)}</Link>
      ) : (
        formatSsccHri(row.boxSscc)
      ),
  },
  {
    key: "reason",
    title: t("pages.codeSearch.palletCard.rejections.table.reason"),
    wrap: true,
    render: (row) =>
      REJECTION_REASONS.has(row.reason)
        ? t(`pages.codeSearch.palletCard.rejections.reason.${row.reason}`)
        : row.reason,
  },
  {
    key: "winningPalletSscc",
    title: t("pages.codeSearch.palletCard.rejections.table.winningPallet"),
    mono: true,
    render: (row) => (row.winningPalletSscc ? formatSsccHri(row.winningPalletSscc) : "—"),
  },
  {
    key: "addedAt",
    title: t("pages.codeSearch.palletCard.rejections.table.addedAt"),
    render: (row) => formatCreatedAt(row.addedAt, i18n.language),
  },
];
```

5. In the `PageHeader` `actions`, put the kind badge before the status chip:

```tsx
            <Badge tone={pallet.kind === "warehouse" ? "accent" : "neutral"}>
              {t(`pages.codeSearch.palletCard.kind.${pallet.kind}`)}
            </Badge>
            <StatusChip
              status={STATUS_TO_CHIP[pallet.status]}
              label={t(`pages.codeSearch.palletCard.status.${pallet.status}`)}
            />
```

6. Replace the shift `DetailField`:

```tsx
<DetailField
  label={t("pages.codeSearch.palletCard.shiftLabel")}
  value={
    pallet.shiftId ? (
      <Link to={`/shifts/${pallet.shiftId}`}>
        {pallet.shiftNumber ?? t("pages.codeSearch.palletCard.shiftLabel")}
      </Link>
    ) : (
      // A warehouse pallet belongs to no shift: say so rather than
      // linking to a shift that does not exist.
      t("pages.codeSearch.palletCard.noShift")
    )
  }
/>
```

7. Give the boxes card an accessible region so tests (and screen readers) can scope it. Wrap the boxes `Card` and the new rejections `Card` in `<section role="region" aria-label={…}>`:

```tsx
<section role="region" aria-label={t("pages.codeSearch.palletCard.boxesTitle")}>
  <Card title={t("pages.codeSearch.palletCard.boxesTitle")}>
    <Table
      columns={boxColumns}
      rows={pallet.boxes}
      getRowKey={(row) => row.id}
      empty={t("pages.codeSearch.palletCard.boxesEmpty")}
      scrollLabel={t("pages.codeSearch.palletCard.boxesTitle")}
    />
  </Card>
</section>;

{
  pallet.kind === "warehouse" ? (
    <section role="region" aria-label={t("pages.codeSearch.palletCard.rejections.title")}>
      <Card title={t("pages.codeSearch.palletCard.rejections.title")}>
        <Table
          columns={rejectionColumns}
          rows={pallet.rejections}
          getRowKey={(row) => `${row.boxSscc}:${row.recordedAt}`}
          empty={t("pages.codeSearch.palletCard.rejections.empty")}
          scrollLabel={t("pages.codeSearch.palletCard.rejections.title")}
        />
      </Card>
    </section>
  ) : null;
}
```

(The rejections card is shown only for warehouse pallets: a production pallet cannot have any, and an always-empty table would read as a defect.)

- [ ] **Step 5: Strings**

`ru.json`, inside `pages.codeSearch.palletCard`, add:

```json
"noShift": "Вне смены (складская паллета)",
"kind": { "production": "Производственная", "warehouse": "Складская" },
"rejections": {
  "title": "Отказано в постановке",
  "empty": "Все отсканированные короба поставлены на паллету",
  "table": { "sscc": "SSCC короба", "reason": "Причина", "winningPallet": "Паллета, где короб", "addedAt": "Скан" },
  "reason": {
    "already_on_pallet": "Уже на другой паллете",
    "not_found": "Короб не найден",
    "not_closed": "Короб не закрыт",
    "disassembled": "Короб расформирован",
    "pallet_closed": "Паллета уже закрыта",
    "product_mismatch": "Другой товар"
  }
}
```

and inside `pages.codeSearch.palletCard.table` add `"shift": "Смена короба"`.

`en.json`, same places:

```json
"noShift": "No shift (warehouse pallet)",
"kind": { "production": "Production", "warehouse": "Warehouse" },
"rejections": {
  "title": "Refused memberships",
  "empty": "Every scanned box was stacked on the pallet",
  "table": { "sscc": "Box SSCC", "reason": "Reason", "winningPallet": "Pallet holding the box", "addedAt": "Scanned" },
  "reason": {
    "already_on_pallet": "Already on another pallet",
    "not_found": "Box not found",
    "not_closed": "Box not closed",
    "disassembled": "Box taken apart",
    "pallet_closed": "Pallet already closed",
    "product_mismatch": "Different product"
  }
}
```

and `table.shift: "Box shift"`.

- [ ] **Step 6: Widen the legacy `PALLET_CARD` fixture**

In `apps/admin/test/pallets.test.tsx` replace the `PALLET_CARD` constant with:

```ts
const PALLET_CARD = {
  id: "pal-1",
  sscc: PALLET.sscc,
  status: "closed",
  kind: "production",
  shiftId: SHIFT.id,
  shiftNumber: "SEP26-001",
  productId: "p1",
  productName: "Молоко 1л",
  terminalId: "t1",
  lineName: "Линия розлива № 1",
  operatorId: null,
  openedAt: "2026-09-11T14:00:00.000Z",
  closedAt: "2026-09-11T15:00:00.000Z",
  disassembledAt: null,
  boxes: [
    {
      id: "box-1",
      sscc: "00123460682000000101",
      shiftId: SHIFT.id,
      shiftNumber: "SEP26-001",
      productionDate: "2026-09-11",
      itemCount: 12,
      closedAt: "2026-09-11T15:00:00.000Z",
      disassembledAt: null,
    },
    {
      id: "box-2",
      sscc: "00123460682000000102",
      shiftId: SHIFT.id,
      shiftNumber: "SEP26-001",
      productionDate: "2026-09-11",
      itemCount: 0,
      closedAt: "2026-09-11T15:00:00.000Z",
      disassembledAt: "2026-09-11T16:30:00.000Z",
    },
  ],
  exceptions: [],
  rejections: [],
};
```

If an existing card case in `pallets.test.tsx` (around lines 880–950) queries `screen.getByRole("table")` and now finds two tables, scope it with `within(screen.getByRole("region", { name: "Короба на паллете" }))` — the production card renders one table only (no rejections card), so this should not be needed; verify by running.

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx test/pallets.test.tsx test/box-card.test.tsx test/i18n.test.tsx && pnpm --filter @markiro/admin typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/pages/code-search/api.ts apps/admin/src/pages/code-search/PalletCard.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/pallets.test.tsx apps/admin/test/warehouse-pallets.test.tsx
git commit -m "feat(admin): pallet card shows kind, box origin shifts and refused memberships

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Shared export history + per-pallet GIS MT export on the card

**Files:**

- Create: `apps/admin/src/pages/shifts/export-history.tsx`
- Modify: `apps/admin/src/pages/shifts/ShiftExportsDialog.tsx` (remove the moved pieces, import them)
- Modify: `apps/admin/src/pages/shifts/shift-exports-api.ts`
- Create: `apps/admin/src/pages/code-search/PalletExportsSection.tsx`
- Modify: `apps/admin/src/pages/code-search/PalletCard.tsx`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/warehouse-pallets.test.tsx` (append); existing `test/shift-exports-dialog.test.tsx` and `test/pallets.test.tsx` must stay green.

**Interfaces:**

- Produces in `export-history.tsx`:
  ```ts
  export const EXPORT_STATUS_TO_CHIP: Record<ShiftExportStatus, StatusChipStatus>;
  export const EXPORT_SAFE_ERROR_CODES: ReadonlySet<string>;
  export function formatExportNumber(value: number, language: string): string;
  export function formatExportDateTime(value: string | null, language: string): string | null;
  export function exportErrorMessage(error: unknown, t: (key: string) => string): string;
  export function HistoryRow(props: {
    item: ShiftExportDto;
    language: string;
    formatLabel: string | undefined;
    onError: (error: unknown) => void;
  }): JSX.Element;
  export function ExportHistory(props: {
    items: ShiftExportDto[] | undefined;
    isPending: boolean;
    isError: boolean;
    formats: readonly { id: string; version: number; label: string }[];
    onError: (error: unknown) => void;
  }): JSX.Element;
  ```
- Produces in `shift-exports-api.ts`:
  ```ts
  export interface ShiftExportDto { …; shiftId: string | null; palletId: string | null; formatId: ShiftExportFormatId | PalletExportFormatId; … }
  export function useRetryShiftExport(): UseMutationResult<ShiftExportDto, Error, { exportId: string; shiftId: string | null; palletId: string | null }>;
  export const PALLET_EXPORT_FORMATS_QUERY_KEY = ["pallet-export-formats"] as const;
  export const palletExportsQueryKey = (palletId: string) => ["pallet-exports", palletId] as const;
  export interface CreatePalletExportInput { formatId: PalletExportFormatId; formatVersion: number; idempotencyKey: string }
  export function usePalletExportFormats(): UseQueryResult<PalletExportFormatDescriptor[]>;
  export function usePalletExports(palletId: string, enabled: boolean): UseQueryResult<ShiftExportDto[]>;
  export function useCreatePalletExport(): UseMutationResult<ShiftExportDto, Error, { palletId: string; input: CreatePalletExportInput }>;
  ```
- Produces `PalletExportsSection({ pallet }: { pallet: PalletCardDto })`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/admin/test/warehouse-pallets.test.tsx`:

```tsx
const PALLET_FORMAT = {
  id: "pallet_xml_gismt_aggregation",
  version: 1,
  label: "[XML][ГИСМТ] Агрегация паллеты",
  extension: "xml",
  mimeType: "application/xml; charset=utf-8",
};

const READY_EXPORT = {
  id: "exp-1",
  shiftId: null,
  palletId: "pal-w1",
  formatId: "pallet_xml_gismt_aggregation",
  formatVersion: 1,
  maxLines: null,
  status: "ready",
  errorCode: null,
  productNameSnapshot: "Молоко 1л",
  shiftDateSnapshot: "2026-09-17",
  totalCodeCount: 0,
  totalBoxCount: 2,
  createdByUserId: "u1",
  createdByName: "Елена Ким",
  sourceSnapshotStartedAt: "2026-09-17T10:05:00.000Z",
  completedAt: "2026-09-17T10:05:02.000Z",
  attemptCount: 1,
  createdAt: "2026-09-17T10:05:00.000Z",
  stale: false,
  artifacts: [
    {
      id: "art-1",
      partNumber: 1,
      physicalLineCount: 12,
      codeCount: 0,
      boxCount: 2,
      filename: "Молоко_2026-09-17_паллета_00104600682000000019_2_коробов.xml",
      mimeType: "application/xml; charset=utf-8",
      byteSize: 512,
      sha256: "0".repeat(64),
    },
  ],
};

describe("pallet exports section", () => {
  it("orders the pallet aggregation export and shows the history", async () => {
    let created = false;
    const { fetchMock, user } = renderCard(WAREHOUSE_CARD, READ_ONLY, (url, init) => {
      if (url === "/api/pallet-exports/formats") return [PALLET_FORMAT];
      if (url === "/api/pallets/pal-w1/exports" && init?.method === "POST") {
        created = true;
        return { ...READY_EXPORT, status: "queued", artifacts: [] };
      }
      if (url === "/api/pallets/pal-w1/exports") return created ? [READY_EXPORT] : [];
      return { items: [] };
    });

    const section = within(await screen.findByRole("region", { name: "Отчёты паллеты" }));
    expect(await section.findByText("Отчёты для этой паллеты ещё не формировались.")).toBeDefined();
    await user.click(section.getByRole("button", { name: "Сформировать отчёт" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) => String(call[0]) === "/api/pallets/pal-w1/exports" && call[1]?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ formatId: "pallet_xml_gismt_aggregation", formatVersion: 1 });
      expect(typeof body.idempotencyKey).toBe("string");
      expect(body).not.toHaveProperty("maxLines");
    });
    expect(await section.findByText("Готов")).toBeDefined();
    expect(section.getByText(/паллета_00104600682000000019/)).toBeDefined();
    expect(section.getByText("2 коробов")).toBeDefined();
  });

  it("explains instead of offering the export while the pallet is not closed", async () => {
    renderCard({ ...WAREHOUSE_CARD, status: "open", closedAt: null });

    const section = within(await screen.findByRole("region", { name: "Отчёты паллеты" }));
    expect(section.getByText("Отчёт доступен после закрытия паллеты.")).toBeDefined();
    expect(section.queryByRole("button", { name: "Сформировать отчёт" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx -t "pallet exports section"`
Expected: FAIL — no «Отчёты паллеты» region.

- [ ] **Step 3: Widen the exports client and add the pallet hooks**

Replace `apps/admin/src/pages/shifts/shift-exports-api.ts` with:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type {
  PalletExportFormatDescriptor,
  PalletExportFormatId,
  ShiftExportFormatDescriptor,
  ShiftExportFormatId,
} from "@markiro/domain";

import { apiFetch } from "../../api/client.js";

export type ShiftExportStatus = "queued" | "processing" | "ready" | "failed";

export interface ShiftExportArtifactDto {
  id: string;
  partNumber: number;
  physicalLineCount: number;
  codeCount: number;
  boxCount: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}

/**
 * Mirrors `apps/api/src/modules/shift-exports/dto.ts`'s `ShiftExportDto`. One
 * row type serves both scopes: a shift export has `shiftId` and no
 * `palletId`; a per-pallet export (warehouse pallets, plan 1) the reverse.
 */
export interface ShiftExportDto {
  id: string;
  /** Null exactly when this is a per-pallet export; `palletId` is then set. */
  shiftId: string | null;
  palletId: string | null;
  formatId: ShiftExportFormatId | PalletExportFormatId;
  formatVersion: number;
  maxLines: number | null;
  status: ShiftExportStatus;
  errorCode: string | null;
  productNameSnapshot: string | null;
  shiftDateSnapshot: string | null;
  totalCodeCount: number | null;
  totalBoxCount: number | null;
  createdByUserId: string;
  createdByName: string | null;
  sourceSnapshotStartedAt: string | null;
  completedAt: string | null;
  attemptCount: number;
  createdAt: string;
  stale: boolean;
  artifacts: ShiftExportArtifactDto[];
}

export interface CreateShiftExportInput {
  formatId: ShiftExportFormatId;
  formatVersion: number;
  maxLines: number | null;
  idempotencyKey: string;
}

/** A pallet export has no `maxLines`: one `pack_content`, never split into parts. */
export interface CreatePalletExportInput {
  formatId: PalletExportFormatId;
  formatVersion: number;
  idempotencyKey: string;
}

export interface ShiftExportDownloadDto {
  url: string;
  filename: string;
  expiresInSeconds: 300;
}

export const SHIFT_EXPORT_FORMATS_QUERY_KEY = ["shift-export-formats"] as const;
export const PALLET_EXPORT_FORMATS_QUERY_KEY = ["pallet-export-formats"] as const;

export const shiftExportsQueryKey = (shiftId: string) => ["shift-exports", shiftId] as const;
export const palletExportsQueryKey = (palletId: string) => ["pallet-exports", palletId] as const;

function fetchShiftExportFormats(): Promise<ShiftExportFormatDescriptor[]> {
  return apiFetch<ShiftExportFormatDescriptor[]>("/shift-exports/formats");
}

function fetchPalletExportFormats(): Promise<PalletExportFormatDescriptor[]> {
  return apiFetch<PalletExportFormatDescriptor[]>("/pallet-exports/formats");
}

function fetchShiftExports(shiftId: string): Promise<ShiftExportDto[]> {
  return apiFetch<ShiftExportDto[]>(`/shifts/${shiftId}/exports`);
}

function fetchPalletExports(palletId: string): Promise<ShiftExportDto[]> {
  return apiFetch<ShiftExportDto[]>(`/pallets/${palletId}/exports`);
}

function postShiftExport(shiftId: string, input: CreateShiftExportInput): Promise<ShiftExportDto> {
  return apiFetch<ShiftExportDto>(`/shifts/${shiftId}/exports`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function postPalletExport(
  palletId: string,
  input: CreatePalletExportInput,
): Promise<ShiftExportDto> {
  return apiFetch<ShiftExportDto>(`/pallets/${palletId}/exports`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function postRetryShiftExport(exportId: string): Promise<ShiftExportDto> {
  return apiFetch<ShiftExportDto>(`/shift-exports/${exportId}/retry`, { method: "POST" });
}

export function downloadShiftExportArtifact(
  exportId: string,
  artifactId: string,
): Promise<ShiftExportDownloadDto> {
  return apiFetch<ShiftExportDownloadDto>(
    `/shift-exports/${exportId}/artifacts/${artifactId}/download`,
  );
}

/** Poll every 2 s while any row is still being produced. */
function exportsRefetchInterval(items: ShiftExportDto[] | undefined): number | false {
  return items?.some((item) => item.status === "queued" || item.status === "processing")
    ? 2_000
    : false;
}

export function useShiftExportFormats(): UseQueryResult<ShiftExportFormatDescriptor[]> {
  return useQuery({
    queryKey: SHIFT_EXPORT_FORMATS_QUERY_KEY,
    queryFn: fetchShiftExportFormats,
  });
}

export function usePalletExportFormats(): UseQueryResult<PalletExportFormatDescriptor[]> {
  return useQuery({
    queryKey: PALLET_EXPORT_FORMATS_QUERY_KEY,
    queryFn: fetchPalletExportFormats,
  });
}

export function useShiftExports(
  shiftId: string,
  enabled: boolean,
): UseQueryResult<ShiftExportDto[]> {
  return useQuery({
    queryKey: shiftExportsQueryKey(shiftId),
    queryFn: () => fetchShiftExports(shiftId),
    enabled,
    refetchInterval: (query) => exportsRefetchInterval(query.state.data),
  });
}

export function usePalletExports(
  palletId: string,
  enabled: boolean,
): UseQueryResult<ShiftExportDto[]> {
  return useQuery({
    queryKey: palletExportsQueryKey(palletId),
    queryFn: () => fetchPalletExports(palletId),
    enabled,
    refetchInterval: (query) => exportsRefetchInterval(query.state.data),
  });
}

export function useCreateShiftExport(): UseMutationResult<
  ShiftExportDto,
  Error,
  { shiftId: string; input: CreateShiftExportInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ shiftId, input }) => postShiftExport(shiftId, input),
    onSuccess: (_data, { shiftId }) => {
      void queryClient.invalidateQueries({ queryKey: shiftExportsQueryKey(shiftId) });
    },
  });
}

export function useCreatePalletExport(): UseMutationResult<
  ShiftExportDto,
  Error,
  { palletId: string; input: CreatePalletExportInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ palletId, input }) => postPalletExport(palletId, input),
    onSuccess: (_data, { palletId }) => {
      void queryClient.invalidateQueries({ queryKey: palletExportsQueryKey(palletId) });
    },
  });
}

/**
 * Retry is one endpoint for both scopes; the row's own `shiftId`/`palletId`
 * says which history list to refresh afterwards.
 */
export function useRetryShiftExport(): UseMutationResult<
  ShiftExportDto,
  Error,
  { exportId: string; shiftId: string | null; palletId: string | null }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ exportId }) => postRetryShiftExport(exportId),
    onSuccess: (_data, { shiftId, palletId }) => {
      if (shiftId) {
        void queryClient.invalidateQueries({ queryKey: shiftExportsQueryKey(shiftId) });
      }
      if (palletId) {
        void queryClient.invalidateQueries({ queryKey: palletExportsQueryKey(palletId) });
      }
    },
  });
}
```

- [ ] **Step 4: Extract the history UI**

Create `apps/admin/src/pages/shifts/export-history.tsx` (moved verbatim from `ShiftExportsDialog.tsx` except for the renames noted in the Interfaces block, the two new error codes, and the `retry.mutateAsync` call):

```tsx
/**
 * The export history UI shared by the shift panel/dialog and the pallet card:
 * one row per export with status, parameters, failure text with retry, and
 * the downloadable parts. Both scopes produce the same `ShiftExportDto`
 * rows and the same `pages.shifts.exports.*` wording, so this is one module,
 * not two copies.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Spinner, StatusChip } from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import {
  downloadShiftExportArtifact,
  useRetryShiftExport,
  type ShiftExportArtifactDto,
  type ShiftExportDto,
  type ShiftExportStatus,
} from "./shift-exports-api.js";

export const EXPORT_STATUS_TO_CHIP: Record<ShiftExportStatus, StatusChipStatus> = {
  queued: "info",
  processing: "warn",
  ready: "ok",
  failed: "error",
};

/**
 * Mirrors `SHIFT_EXPORT_SAFE_ERROR_CODES`
 * (apps/api/src/modules/shift-exports/shift-export-runner.service.ts). A code
 * missing here is not a cosmetic gap: the UI falls back to the generic
 * infrastructure sentence and the operator never learns what actually went
 * wrong. Keep the two lists in step.
 */
export const EXPORT_SAFE_ERROR_CODES: ReadonlySet<string> = new Set([
  "SHIFT_NOT_CLOSED",
  "SHIFT_HAS_NO_CODES",
  "SHIFT_DATE_MISSING",
  "BOX_COVERAGE_INCOMPLETE",
  "SHIFT_HAS_NO_PALLETS",
  "PALLET_NOT_CLOSED",
  "PALLET_DISASSEMBLED",
  "ORG_INN_MISSING",
  "FORMAT_NOT_FOUND",
  "INVALID_LINE_LIMIT",
  "BOX_EXCEEDS_LINE_LIMIT",
  "PALLET_EXCEEDS_LINE_LIMIT",
  "INVALID_BOX_SSCC",
  "INVALID_CIS",
  "GENERATION_FAILED",
  "STORAGE_FAILED",
  "QUEUE_FAILED",
]);

export function formatExportNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language).format(value);
}

export function formatExportDateTime(value: string | null, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function exportErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiRequestError && error.code && EXPORT_SAFE_ERROR_CODES.has(error.code)) {
    return t(`pages.shifts.exports.errors.${error.code}`);
  }
  return t("pages.shifts.exports.errors.infrastructure");
}

function ExportParameters({
  item,
  language,
  formatLabel,
}: {
  item: ShiftExportDto;
  language: string;
  formatLabel: string | undefined;
}) {
  const { t } = useTranslation();
  const split =
    item.maxLines === null
      ? t("pages.shifts.exports.parameters.single")
      : t("pages.shifts.exports.parameters.split", {
          count: formatExportNumber(item.maxLines, language),
        });

  return (
    <dl className="mk-shift-exports__details">
      <div>
        <dt>{t("pages.shifts.exports.details.actor")}</dt>
        <dd>{item.createdByName ?? t("pages.shifts.exports.details.unknownActor")}</dd>
      </div>
      <div>
        <dt>{t("pages.shifts.exports.details.created")}</dt>
        <dd>{formatExportDateTime(item.createdAt, language) ?? "—"}</dd>
      </div>
      <div>
        <dt>{t("pages.shifts.exports.details.format")}</dt>
        <dd>{formatLabel ?? item.formatId}</dd>
      </div>
      <div>
        <dt>{t("pages.shifts.exports.details.parameters")}</dt>
        <dd>{split}</dd>
      </div>
      {item.totalCodeCount !== null ? (
        <div>
          <dt>{t("pages.shifts.exports.details.codes")}</dt>
          <dd>
            {t("pages.shifts.exports.counts.codes", {
              count: formatExportNumber(item.totalCodeCount, language),
            })}
          </dd>
        </div>
      ) : null}
      {item.totalBoxCount !== null && item.totalBoxCount > 0 ? (
        <div>
          <dt>{t("pages.shifts.exports.details.boxes")}</dt>
          <dd>
            {t("pages.shifts.exports.counts.boxes", {
              count: formatExportNumber(item.totalBoxCount, language),
            })}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function ArtifactRow({
  item,
  artifact,
  language,
  onError,
}: {
  item: ShiftExportDto;
  artifact: ShiftExportArtifactDto;
  language: string;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      const result = await downloadShiftExportArtifact(item.id, artifact.id);
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } catch (error) {
      onError(error);
    } finally {
      setDownloading(false);
    }
  };

  const counts = [
    t("pages.shifts.exports.counts.lines", {
      count: formatExportNumber(artifact.physicalLineCount, language),
    }),
    t("pages.shifts.exports.counts.codes", {
      count: formatExportNumber(artifact.codeCount, language),
    }),
    ...(artifact.boxCount > 0
      ? [
          t("pages.shifts.exports.counts.boxes", {
            count: formatExportNumber(artifact.boxCount, language),
          }),
        ]
      : []),
    t("pages.shifts.exports.counts.bytes", {
      count: formatExportNumber(artifact.byteSize, language),
    }),
  ];

  return (
    <li className="mk-shift-exports__part">
      <div>
        <strong>{t("pages.shifts.exports.part", { number: artifact.partNumber })}</strong>
        <span>{counts.join(" · ")}</span>
        <span className="mk-shift-exports__filename">{artifact.filename}</span>
      </div>
      <Button
        type="button"
        size="compact"
        variant="secondary"
        loading={downloading}
        onClick={() => void download()}
      >
        {t("pages.shifts.exports.download")}
      </Button>
    </li>
  );
}

export function HistoryRow({
  item,
  language,
  formatLabel,
  onError,
}: {
  item: ShiftExportDto;
  language: string;
  formatLabel: string | undefined;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const retry = useRetryShiftExport();
  const [retryError, setRetryError] = useState<string | null>(null);

  const retryExport = async () => {
    setRetryError(null);
    try {
      await retry.mutateAsync({
        exportId: item.id,
        shiftId: item.shiftId,
        palletId: item.palletId,
      });
    } catch (error) {
      setRetryError(exportErrorMessage(error, t));
    }
  };

  return (
    <article className="mk-shift-exports__history-row">
      <div className="mk-shift-exports__history-head">
        <StatusChip
          status={EXPORT_STATUS_TO_CHIP[item.status]}
          label={t(`pages.shifts.exports.status.${item.status}`)}
        />
        <span>{formatExportDateTime(item.completedAt ?? item.createdAt, language) ?? "—"}</span>
      </div>
      {item.stale ? <Alert tone="warn">{t("pages.shifts.exports.stale")}</Alert> : null}
      <ExportParameters item={item} language={language} formatLabel={formatLabel} />
      {item.status === "failed" ? (
        <div className="mk-shift-exports__failed">
          <Alert tone="error">
            {item.errorCode && EXPORT_SAFE_ERROR_CODES.has(item.errorCode)
              ? t(`pages.shifts.exports.errors.${item.errorCode}`)
              : t("pages.shifts.exports.errors.infrastructure")}
          </Alert>
          <Button
            type="button"
            size="compact"
            variant="secondary"
            loading={retry.isPending}
            onClick={() => void retryExport()}
          >
            {t("pages.shifts.exports.retry")}
          </Button>
          {retryError ? <Alert tone="error">{retryError}</Alert> : null}
        </div>
      ) : null}
      {item.status === "ready" && item.artifacts.length > 0 ? (
        <ol className="mk-shift-exports__parts">
          {[...item.artifacts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((artifact) => (
              <ArtifactRow
                key={artifact.id}
                item={item}
                artifact={artifact}
                language={language}
                onError={onError}
              />
            ))}
        </ol>
      ) : null}
    </article>
  );
}

/**
 * The history block: newest first, with format labels resolved by
 * `id@version` first and by `id` alone as a fallback (a row from a version no
 * longer advertised still gets its friendly label).
 */
export function ExportHistory({
  items,
  isPending,
  isError,
  formats,
  emptyText,
  onError,
}: {
  items: ShiftExportDto[] | undefined;
  isPending: boolean;
  isError: boolean;
  formats: readonly { id: string; version: number; label: string }[];
  emptyText: string;
  onError: (error: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const history = [...(items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const formatLabels = new Map(
    formats.map((format) => [`${format.id}@${format.version}`, format.label]),
  );
  const formatLabelsById = new Map(formats.map((format) => [format.id, format.label]));

  return (
    <section
      className="mk-shift-exports__history"
      aria-label={t("pages.shifts.exports.historyLabel")}
    >
      <h3>{t("pages.shifts.exports.historyTitle")}</h3>
      {isPending ? <Spinner label={t("common.loading")} /> : null}
      {isError ? (
        <Alert tone="error">{t("pages.shifts.exports.errors.infrastructure")}</Alert>
      ) : null}
      {!isPending && !isError && history.length === 0 ? (
        <p className="mk-shift-exports__empty">{emptyText}</p>
      ) : null}
      {history.map((item) => (
        <HistoryRow
          key={item.id}
          item={item}
          language={i18n.language}
          formatLabel={
            formatLabels.get(`${item.formatId}@${item.formatVersion}`) ??
            formatLabelsById.get(item.formatId)
          }
          onError={onError}
        />
      ))}
    </section>
  );
}
```

- [ ] **Step 5: Make `ShiftExportsDialog.tsx` consume the shared module**

In `apps/admin/src/pages/shifts/ShiftExportsDialog.tsx`:

1. Delete `STATUS_TO_CHIP`, `SAFE_ERROR_CODES`, `formatNumber`, `formatDateTime`, `errorMessage`, `ExportParameters`, `ArtifactRow`, `HistoryRow` and the now-unused imports (`StatusChip`, `StatusChipStatus`, `ApiRequestError`, `downloadShiftExportArtifact`, `useRetryShiftExport`, `ShiftExportArtifactDto`, `ShiftExportDto`, `ShiftExportStatus`).
2. Add `import { ExportHistory, exportErrorMessage } from "./export-history.js";`.
3. In `ShiftExportsContent`, replace `setError(errorMessage(caught, t))` with `setError(exportErrorMessage(caught, t))`, delete the `history`, `formatLabels`, `formatLabelsById` memos, and replace the whole `<section className="mk-shift-exports__history" …>…</section>` with:

```tsx
<ExportHistory
  items={exportsQuery.data}
  isPending={exportsQuery.isPending}
  isError={exportsQuery.isError}
  formats={formats.data ?? []}
  emptyText={t("pages.shifts.exports.historyEmpty")}
  onError={(caught) => setError(exportErrorMessage(caught, t))}
/>
```

Keep `parseLineLimit`, the `MIN/MAX/DEFAULT_LINES_PER_PART` constants, `ShiftExportsContent` and `ShiftExportsDialog` exactly as they are otherwise.

- [ ] **Step 6: The pallet exports section**

Create `apps/admin/src/pages/code-search/PalletExportsSection.tsx`:

```tsx
/**
 * Per-pallet GIS MT aggregation export (warehouse pallets, spec §4 «Export
 * dialog»): one format today, so the form is a radio with a single option
 * plus the button, and the history is the same block the shift panel shows.
 * Only a CLOSED pallet is offered the form: the server refuses an open one
 * with `PALLET_NOT_CLOSED` and a retired one with `PALLET_DISASSEMBLED`, and
 * a red row for something that could never have worked helps nobody.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, RadioGroup, Spinner } from "@markiro/ui";
import type { PalletExportFormatId } from "@markiro/domain";

import { ExportHistory, exportErrorMessage } from "../shifts/export-history.js";
import {
  useCreatePalletExport,
  usePalletExportFormats,
  usePalletExports,
} from "../shifts/shift-exports-api.js";
import type { PalletCardDto } from "./api.js";
import "../shifts/shifts.css";

export function PalletExportsSection({ pallet }: { pallet: PalletCardDto }) {
  const { t } = useTranslation();
  const closed = pallet.status === "closed";
  const formats = usePalletExportFormats();
  const exportsQuery = usePalletExports(pallet.id, true);
  const create = useCreatePalletExport();
  const idempotencyKey = useRef<string | null>(null);
  const [formatId, setFormatId] = useState<PalletExportFormatId | "">("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const firstFormat = formats.data?.[0];
    if (!firstFormat || formatId) return;
    setFormatId(firstFormat.id);
  }, [formatId, formats.data]);

  const canSubmit = closed && Boolean(formatId) && !formats.isPending && !create.isPending;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || !formatId) return;
    const selectedFormat = (formats.data ?? []).find((format) => format.id === formatId);
    if (!selectedFormat) return;
    // A new deliberate submission after a failed request starts a new idempotency scope.
    const requestIdempotencyKey = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = requestIdempotencyKey;
    setError(null);
    try {
      await create.mutateAsync({
        palletId: pallet.id,
        input: {
          formatId,
          formatVersion: selectedFormat.version,
          idempotencyKey: requestIdempotencyKey,
        },
      });
      idempotencyKey.current = null;
    } catch (caught) {
      setError(exportErrorMessage(caught, t));
    }
  };

  return (
    <div className="mk-shift-exports">
      {closed ? (
        <form
          id="pallet-export-form"
          className="mk-shift-exports__form"
          onSubmit={(event) => void submit(event)}
        >
          {error ? <Alert tone="error">{error}</Alert> : null}
          {formats.isError ? (
            <Alert tone="error">{t("pages.shifts.exports.errors.infrastructure")}</Alert>
          ) : null}
          {formats.isPending ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <RadioGroup
              label={t("pages.shifts.exports.formatLabel")}
              name="pallet-export-format"
              value={formatId}
              disabled={create.isPending}
              onValueChange={(value) => {
                idempotencyKey.current = null;
                setFormatId(value as PalletExportFormatId);
              }}
              options={(formats.data ?? []).map((format) => ({
                value: format.id,
                label: format.label,
              }))}
            />
          )}
          <Button type="submit" disabled={!canSubmit} loading={create.isPending}>
            {t("pages.codeSearch.palletCard.exports.create")}
          </Button>
        </form>
      ) : (
        <p className="mk-shift-exports__empty">
          {pallet.status === "disassembled"
            ? t("pages.codeSearch.palletCard.exports.disassembledHint")
            : t("pages.codeSearch.palletCard.exports.afterCloseHint")}
        </p>
      )}
      <ExportHistory
        items={exportsQuery.data}
        isPending={exportsQuery.isPending}
        isError={exportsQuery.isError}
        formats={formats.data ?? []}
        emptyText={t("pages.codeSearch.palletCard.exports.historyEmpty")}
        onError={(caught) => setError(exportErrorMessage(caught, t))}
      />
    </div>
  );
}
```

- [ ] **Step 7: Mount it on the card**

In `apps/admin/src/pages/code-search/PalletCard.tsx` add `import { PalletExportsSection } from "./PalletExportsSection.js";` and, after the exceptions `Card`, add:

```tsx
<section role="region" aria-label={t("pages.codeSearch.palletCard.exports.title")}>
  <Card title={t("pages.codeSearch.palletCard.exports.title")}>
    <PalletExportsSection pallet={pallet} />
  </Card>
</section>
```

- [ ] **Step 8: Strings**

`ru.json`, inside `pages.codeSearch.palletCard`:

```json
"exports": {
  "title": "Отчёты паллеты",
  "create": "Сформировать отчёт",
  "historyEmpty": "Отчёты для этой паллеты ещё не формировались.",
  "afterCloseHint": "Отчёт доступен после закрытия паллеты.",
  "disassembledHint": "Паллета разобрана — новый отчёт не формируется."
}
```

`ru.json`, inside `pages.shifts.exports.errors` (both new safe codes):

```json
"PALLET_NOT_CLOSED": "Паллета ещё не закрыта — отчёт формируется только по закрытой паллете.",
"PALLET_DISASSEMBLED": "Паллета разобрана — отчёт по ней больше не формируется."
```

`en.json`:

```json
"exports": {
  "title": "Pallet exports",
  "create": "Create export",
  "historyEmpty": "No exports have been created for this pallet yet.",
  "afterCloseHint": "The export becomes available once the pallet is closed.",
  "disassembledHint": "The pallet was taken apart — no new export can be created."
}
```

```json
"PALLET_NOT_CLOSED": "The pallet is not closed yet — an export needs a closed pallet.",
"PALLET_DISASSEMBLED": "The pallet was taken apart — it can no longer be exported."
```

- [ ] **Step 9: Run tests and typecheck**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx test/shift-exports-dialog.test.tsx test/pallets.test.tsx test/i18n.test.tsx && pnpm --filter @markiro/admin typecheck`
Expected: PASS. `shift-exports-dialog.test.tsx` must pass unchanged — if it asserts something that moved, the extraction changed behaviour; fix the extraction, not the test. If any fixture there is typed `ShiftExportDto`, add `palletId: null`.

- [ ] **Step 10: Commit**

```bash
git add apps/admin/src/pages/shifts/export-history.tsx apps/admin/src/pages/shifts/ShiftExportsDialog.tsx apps/admin/src/pages/shifts/shift-exports-api.ts apps/admin/src/pages/code-search/PalletExportsSection.tsx apps/admin/src/pages/code-search/PalletCard.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/warehouse-pallets.test.tsx
git commit -m "feat(admin): per-pallet GIS MT export on the pallet card via shared export history

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: «Расформировать» — a prefilled disaggregation document from the card

**Files:**

- Modify: `apps/admin/src/pages/code-search/PalletCard.tsx`
- Modify: `apps/admin/src/pages/disaggregation/DocumentDetail.tsx:201-241` (`AddLinesPanel`)
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/warehouse-pallets.test.tsx` (append), `apps/admin/test/disaggregation-detail.test.tsx` (append)

**Interfaces:**

- Consumes: `useCreateDocument(): UseMutationResult<DocumentDto, Error, void>` from `pages/disaggregation/api.ts` (`POST /disaggregation`, returns `{ id, … }`); `useCan` from `access/context.ts`; `toast` from `lib/toast.ts`; `ApiRequestError` from `api/client.ts`.
- Produces: URL contract `/disaggregation/:id?sscc=<20-digit SSCC>` — `AddLinesPanel` seeds its textarea from `sscc` and drops the parameter after the first successful add.

- [ ] **Step 1: Write the failing tests**

Append to `apps/admin/test/warehouse-pallets.test.tsx`:

```tsx
describe("pallet disassembly from the card", () => {
  it("creates a draft document and opens it prefilled with the pallet SSCC", async () => {
    const { fetchMock, user } = renderCard(WAREHOUSE_CARD, READ_WRITE, (url, init) => {
      if (url === "/api/disaggregation" && init?.method === "POST") {
        return { id: "doc-9", docNo: "DA-9", status: "draft", lines: [] };
      }
      if (url === "/api/pallet-exports/formats") return [];
      if (url === "/api/pallets/pal-w1/exports") return [];
      return { items: [] };
    });

    await user.click(await screen.findByRole("button", { name: "Расформировать" }));

    expect((await screen.findByTestId("location")).textContent).toBe(
      "/disaggregation/doc-9?sscc=00104600682000000019",
    );
    expect(
      fetchMock.mock.calls.some(
        (call) => String(call[0]) === "/api/disaggregation" && call[1]?.method === "POST",
      ),
    ).toBe(true);
  });

  it("hides the action from read-only users and for a pallet already taken apart", async () => {
    renderCard(WAREHOUSE_CARD, READ_ONLY);
    expect(await screen.findByRole("heading", { name: "(00)104600682000000019" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Расформировать" })).toBeNull();
    cleanup();

    renderCard(
      { ...WAREHOUSE_CARD, status: "disassembled", disassembledAt: "2026-09-18T08:00:00.000Z" },
      READ_WRITE,
    );
    expect(await screen.findByRole("heading", { name: "(00)104600682000000019" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Расформировать" })).toBeNull();
  });
});
```

Append to `apps/admin/test/disaggregation-detail.test.tsx` (inside its existing `describe`, or as a new top-level `it` if the file has none):

```tsx
it("prefills the SSCC textarea from ?sscc= and drops the parameter after adding", async () => {
  const fetchMock = stubFetch(DOC_DRAFT_READY);
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/disaggregation/:id" element={<DisaggregationDocumentPage />} />,
    ),
    { initialEntries: ["/disaggregation/d1?sscc=00104600682000000019"] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={ACCESS_WRITE}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();

  const textarea = await screen.findByRole("textbox", { name: "SSCC коробов" });
  expect((textarea as HTMLTextAreaElement).value).toBe("00104600682000000019");

  await user.click(screen.getByRole("button", { name: "Добавить" }));

  await waitFor(() => expect(router.state.location.search).toBe(""));
  expect(
    fetchMock.mock.calls.some(
      (call) => String(call[0]) === "/api/disaggregation/d1/lines" && call[1]?.method === "POST",
    ),
  ).toBe(true);
});
```

If the add button's RU label differs from «Добавить», take it from `pages.disaggregation.detail.addLines` in `ru.json`; if `stubFetch` does not answer `POST /api/disaggregation/d1/lines` with a 2xx body, extend it with `if (path === "/api/disaggregation/d1/lines" && init?.method === "POST") return jsonResponse(200, { added: 1, lines: [] });` (match the `AddLinesResponse` shape in `pages/disaggregation/api.ts`).

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx -t "disassembly" && pnpm --filter @markiro/admin exec vitest run test/disaggregation-detail.test.tsx -t "prefills"`
Expected: both FAIL (no button; empty textarea).

- [ ] **Step 3: The action on the card**

In `apps/admin/src/pages/code-search/PalletCard.tsx`:

1. Imports:

```tsx
import { Link, useNavigate, useParams } from "react-router";

import { CABINET_CAPABILITY, formatSsccHri } from "@markiro/domain";
…
import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useCreateDocument } from "../disaggregation/api.js";
```

2. At the top of `PalletCardPage`, after `useParams`:

```tsx
const navigate = useNavigate();
const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
const createDocument = useCreateDocument();
```

3. After the early returns (so `pallet` is defined), add:

```tsx
// Taking a pallet apart in the cabinet IS a disaggregation document (spec
// §4): the card only opens a fresh draft with this pallet's SSCC already in
// the paste box. Only a closed, labelled pallet can be taken apart, and only
// by someone allowed to write operations.
const canDisassemble = canWrite && pallet.status === "closed" && pallet.sscc !== null;

const startDisassembly = () => {
  if (!pallet.sscc) return;
  const sscc = pallet.sscc;
  createDocument.mutate(undefined, {
    onSuccess: (doc) => {
      void navigate(`/disaggregation/${doc.id}?${new URLSearchParams({ sscc }).toString()}`);
    },
    onError: (error) =>
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.codeSearch.palletCard.disassembleError"),
      ),
  });
};
```

4. In the `PageHeader` `actions`, before the print button:

```tsx
{
  canDisassemble ? (
    <Button
      type="button"
      variant="secondary"
      loading={createDocument.isPending}
      onClick={startDisassembly}
    >
      {t("pages.codeSearch.palletCard.disassembleAction")}
    </Button>
  ) : null;
}
```

- [ ] **Step 4: Prefill in `AddLinesPanel`**

In `apps/admin/src/pages/disaggregation/DocumentDetail.tsx` change the router import to `import { Link, useParams, useSearchParams } from "react-router";` and rewrite the top of `AddLinesPanel`:

```tsx
function AddLinesPanel({ docId }: { docId: string }) {
  const { t } = useTranslation();
  const addLinesMutation = useAddLines(docId);
  const importMutation = useImportLines(docId);
  // `?sscc=` is how the pallet card hands over the pallet it wants taken
  // apart (`/codes/pallet/:id` → «Расформировать»). It seeds the paste box
  // once and is dropped after the first successful add, so a reload of the
  // document does not offer the same SSCC a second time.
  const [searchParams, setSearchParams] = useSearchParams();
  const [pasteValue, setPasteValue] = useState(() => searchParams.get("sscc") ?? "");

  const handleAddLines = async () => {
    const ssccs = splitSsccInput(pasteValue);
    if (ssccs.length === 0) return;
    try {
      await addLinesMutation.mutateAsync(ssccs);
      setPasteValue("");
      if (searchParams.has("sscc")) setSearchParams({}, { replace: true });
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.disaggregation.detail.addLinesError"),
      );
    }
  };
```

(the rest of the function is unchanged).

- [ ] **Step 5: Strings**

`ru.json`, `pages.codeSearch.palletCard`:

```json
"disassembleAction": "Расформировать",
"disassembleError": "Не удалось создать документ разагрегации"
```

`en.json`:

```json
"disassembleAction": "Take apart",
"disassembleError": "Could not create the disaggregation document"
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @markiro/admin exec vitest run test/warehouse-pallets.test.tsx test/disaggregation-detail.test.tsx test/pallets.test.tsx test/i18n.test.tsx && pnpm --filter @markiro/admin typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/pages/code-search/PalletCard.tsx apps/admin/src/pages/disaggregation/DocumentDetail.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/warehouse-pallets.test.tsx apps/admin/test/disaggregation-detail.test.tsx
git commit -m "feat(admin): start pallet disassembly from the pallet card with a prefilled document

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Employee card — «Сборка паллет на ТСД»

**Files:**

- Modify: `apps/admin/src/pages/employees/api.ts:20-24` (`EmployeePickupPolicyInput`)
- Modify: `apps/admin/src/pages/employees/EmployeePickupPolicySection.tsx`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json` (`pages.employees.pickupPolicy.*`)
- Modify fixtures: every `pickupPolicy: {` literal in `apps/admin/test/employees.test.tsx`, `employees-routing.test.tsx`, `employee-station-access.test.tsx`, `employee-badges.test.tsx`, and `access-routing.test.tsx` (`JANE`) gets `canBuildPallets: false` (or `true` where the case wants it).
- Test: `apps/admin/test/employees.test.tsx` (append to the pickup-policy `describe`)

**Interfaces:**

- Produces: `EmployeePickupPolicyInput.canBuildPallets: boolean` (sent on every PATCH; the server accepts it optionally and returns it always).

- [ ] **Step 1: Write the failing test**

In `apps/admin/test/employees.test.tsx`, next to the existing pickup-policy cases (they use `renderPickupPolicy()` and `JANE`), add:

```tsx
it("saves the handheld pallet-building permission alongside the pickup limits", async () => {
  const savedEmployee: EmployeeDto = {
    ...JANE,
    pickupPolicy: { limitMode: "limited", dayLimit: 12, canWriteoff: false, canBuildPallets: true },
  };
  const fetchMock = vi.fn(async () => jsonResponse(200, savedEmployee));
  vi.stubGlobal("fetch", fetchMock);
  renderPickupPolicy();
  const user = userEvent.setup();

  const checkbox = screen.getByRole("checkbox", { name: "Сборка паллет на ТСД" });
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  await user.click(checkbox);
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  await user.click(screen.getByRole("button", { name: "Сохранить правила выдачи" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/employees/1/pickup-policy",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          limitMode: "limited",
          dayLimit: 12,
          canWriteoff: false,
          canBuildPallets: true,
        }),
      }),
    ),
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/employees.test.tsx -t "pallet-building"`
Expected: FAIL — no checkbox named «Сборка паллет на ТСД» (and a type error on `canBuildPallets` in the fixture).

- [ ] **Step 3: Widen the input type and fixtures**

`apps/admin/src/pages/employees/api.ts`:

```ts
export interface EmployeePickupPolicyInput {
  limitMode: EmployeePickupLimitMode;
  dayLimit: number;
  canWriteoff: boolean;
  /** May build warehouse pallets on a handheld (spec §2.5); independent of the pickup limit. */
  canBuildPallets: boolean;
}
```

Then add `canBuildPallets: false` to every `pickupPolicy: { … }` literal in the five test files listed above (run `grep -rn "pickupPolicy: {" apps/admin/test` to find them all; `pnpm --filter @markiro/admin typecheck` must be clean afterwards).

- [ ] **Step 4: The checkbox**

In `apps/admin/src/pages/employees/EmployeePickupPolicySection.tsx`:

1. Destructure and hold the new flag:

```tsx
const {
  limitMode: incomingLimitMode,
  dayLimit: incomingDayLimit,
  canWriteoff: incomingCanWriteoff,
  canBuildPallets: incomingCanBuildPallets,
} = employee.pickupPolicy;
const [limitMode, setLimitMode] = useState<EmployeePickupLimitMode>(incomingLimitMode);
const [dayLimit, setDayLimit] = useState(String(incomingDayLimit));
const [canWriteoff, setCanWriteoff] = useState(incomingCanWriteoff);
const [canBuildPallets, setCanBuildPallets] = useState(incomingCanBuildPallets);
```

2. `dirty`:

```tsx
const dirty =
  limitMode !== baseline.limitMode ||
  dayLimit !== String(baseline.dayLimit) ||
  canWriteoff !== baseline.canWriteoff ||
  canBuildPallets !== baseline.canBuildPallets;
```

3. The rehydration effect:

```tsx
useEffect(() => {
  const employeeChanged = employeeIdRef.current !== employee.id;
  if (!employeeChanged && dirtyRef.current) return;
  employeeIdRef.current = employee.id;
  setBaseline({
    limitMode: incomingLimitMode,
    dayLimit: incomingDayLimit,
    canWriteoff: incomingCanWriteoff,
    canBuildPallets: incomingCanBuildPallets,
  });
  setLimitMode(incomingLimitMode);
  setDayLimit(String(incomingDayLimit));
  setCanWriteoff(incomingCanWriteoff);
  setCanBuildPallets(incomingCanBuildPallets);
}, [
  employee.id,
  incomingCanBuildPallets,
  incomingCanWriteoff,
  incomingDayLimit,
  incomingLimitMode,
]);
```

4. `submit`:

```tsx
const savedEmployee = await mutation.mutateAsync({
  id: employee.id,
  input: { limitMode, dayLimit: Number(dayLimit), canWriteoff, canBuildPallets },
});
setBaseline(savedEmployee.pickupPolicy);
setLimitMode(savedEmployee.pickupPolicy.limitMode);
setDayLimit(String(savedEmployee.pickupPolicy.dayLimit));
setCanWriteoff(savedEmployee.pickupPolicy.canWriteoff);
setCanBuildPallets(savedEmployee.pickupPolicy.canBuildPallets);
```

5. After the writeoff `Checkbox`:

```tsx
<Checkbox
  label={t("pages.employees.pickupPolicy.canBuildPalletsLabel")}
  hint={t("pages.employees.pickupPolicy.canBuildPalletsHint")}
  checked={canBuildPallets}
  disabled={mutation.isPending}
  onCheckedChange={setCanBuildPallets}
/>
```

- [ ] **Step 5: Strings**

`ru.json`, `pages.employees.pickupPolicy`:

```json
"canBuildPalletsLabel": "Сборка паллет на ТСД",
"canBuildPalletsHint": "Сотрудник сможет ставить закрытые короба на складскую паллету в режиме «Паллеты» терминала."
```

`en.json`:

```json
"canBuildPalletsLabel": "Build pallets on a handheld",
"canBuildPalletsHint": "The employee can stack closed boxes onto a warehouse pallet in the handheld's Pallets mode."
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @markiro/admin exec vitest run test/employees.test.tsx test/employees-routing.test.tsx test/employee-station-access.test.tsx test/employee-badges.test.tsx test/access-routing.test.tsx test/i18n.test.tsx && pnpm --filter @markiro/admin typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/pages/employees/api.ts apps/admin/src/pages/employees/EmployeePickupPolicySection.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/employees.test.tsx apps/admin/test/employees-routing.test.tsx apps/admin/test/employee-station-access.test.tsx apps/admin/test/employee-badges.test.tsx apps/admin/test/access-routing.test.tsx
git commit -m "feat(admin): employee permission to build pallets on a handheld

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Full gates, spec status, docs

**Files:**

- Modify: `docs/superpowers/specs/2026-09-17-warehouse-pallet-aggregation-design.md:5` (status line)
- Modify: `apps/admin/README.md` only if it enumerates the code-search tabs or pallet surfaces (check with `grep -n "Короба\|/boxes\|pallet" apps/admin/README.md`); otherwise no doc change.

- [ ] **Step 1: Run the package gates**

```bash
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
pnpm format:check
git diff --check
```

Expected: all green. `lint` will flag any identifier left unused in `test/warehouse-pallets.test.tsx` (e.g. `LocationProbe` if Task 5's case was renamed) — remove the unused import/helper rather than disabling the rule.

- [ ] **Step 2: Update the spec status**

In the spec's line 5 status, append: `cabinet UI implemented (plan 3, this branch)` so it reads that all three plans are done.

- [ ] **Step 3: Review the whole diff against `origin/main`**

Run: `git fetch origin main && git diff origin/main...HEAD --stat` and read `git diff origin/main...HEAD -- apps/admin/src` once end-to-end. Check: no `any`, no `!` outside `queryFn`, every new `t()` key exists in both JSON files, the shift exports dialog behaviour is unchanged, the `/pallets` route is behind `OPERATIONS_READ`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-17-warehouse-pallet-aggregation-design.md
git commit -m "docs: warehouse pallets spec — cabinet UI shipped (plan 3)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Final report must list: behaviour changed (registry tab, card additions, per-pallet export, disassembly hand-off, employee checkbox), files changed, the automated checks with results, and state explicitly that the browser/visual layer was NOT exercised (DOM tests only) unless a preview was actually opened.

---

## Self-review

**Spec coverage (§4):**

- «Паллеты» page with kind/product/period/device filters and columns SSCC, kind, product, boxes, units, closed, disassembled, «состав изменён», rejections → Task 2 (disassembled/changed/rejections are the three status badges; the shift panel keeps `usePallets(shiftId)` untouched).
- Pallet card: header with kind, boxes with origin shift + production date + unit count, exceptions timeline (already present), rejected memberships with reasons, actions «Экспорт агрегации» and «Расформировать» → Tasks 3, 4, 5.
- Disaggregation UI unchanged except the `?sscc=` prefill → Task 5.
- Export dialog: one format, job appears in the existing history with its file → Task 4 (inline section rather than a modal, matching how the shift panel embeds `ShiftExportsContent`).
- Employee card checkbox → Task 6.
- Organisation profile pallet-label pickers → already shipped (`OrgProfilePage.tsx`, `defaultPalletLabelTemplateId` + `categoryPalletDefaults`, tested in `pallets.test.tsx`); no task.

**Placeholder scan:** none of the forbidden phrases; every code step shows the code. Task 6 Step 1 tells the implementer to replace one throw-away assertion with the file's own accessor — that is a deliberate instruction, with the concrete test body given.

**Type consistency:** `PalletKind`, `PalletListFilters`, `useInfinitePallets` (Task 1) are what Task 2 imports; `PalletCardRejectionDto`/`PalletMembershipRejectionReason` (Task 3) are what `PalletCard.tsx` uses; `ExportHistory`/`exportErrorMessage` (Task 4) are consumed by both `ShiftExportsDialog.tsx` and `PalletExportsSection.tsx`; `useRetryShiftExport` variables `{ exportId, shiftId, palletId }` match `HistoryRow`; `EmployeePickupPolicyInput.canBuildPallets` (Task 6) is used in the section and fixtures.
