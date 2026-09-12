import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import i18n from "../src/i18n/index.js";
import { DeviceLicensingPanel } from "../src/pages/devices/DeviceLicensingPanel.js";
import { reservationCancelledOrUnknown } from "../src/pages/devices/index.js";

const authRefetch = vi.hoisted(() => vi.fn());
vi.mock("../src/auth/client.js", () => ({
  useAuthClient: () => ({ useSession: () => ({ refetch: authRefetch }) }),
}));

const POOL = {
  tenantId: "tenant-1",
  usage: 1,
  limit: 2,
  canCancelReservations: true,
  integrity: "ready" as const,
  devices: [
    {
      deviceId: "11111111-1111-4111-8111-111111111111",
      name: "Station reserve",
      kind: "station" as const,
      assignmentId: "22222222-2222-4222-8222-222222222222",
      revision: 3,
      state: "reserved" as const,
      releaseReason: null,
      slotOccupied: true,
      canCancel: true,
      blockedReason: null,
      connectionStatus: "awaiting_pairing" as const,
      pairedAt: null,
      lastSeenAt: null,
    },
  ],
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function renderPanel(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <DeviceLicensingPanel enabled />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
  authRefetch.mockReset();
});

it("shows the shared Station and handheld count and cancels only after keyboard confirmation", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal("crypto", { randomUUID: () => "33333333-3333-4333-8333-333333333333" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (init?.method === "POST")
        return response({
          requestId: "33333333-3333-4333-8333-333333333333",
          deviceId: POOL.devices[0]!.deviceId,
          assignmentId: POOL.devices[0]!.assignmentId,
          revision: 4,
          state: "released",
          releaseReason: "reservation_cancelled",
          releasedAt: "2026-09-12T10:00:00.000Z",
        });
      return response(POOL);
    }),
  );
  renderPanel();
  expect(await screen.findByText("1 из 2")).toBeDefined();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Отменить резерв" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText(/освободится одно место/i)).toBeDefined();
  await user.keyboard("{Tab}{Enter}");
  expect(requests.find((item) => item.body)?.body).toEqual({
    requestId: "33333333-3333-4333-8333-333333333333",
    expectedRevision: 3,
  });
});

it("does not inspect licensing without credentials permission", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider defaultTheme="light">
        <DeviceLicensingPanel enabled={false} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("retries an uncertain response after remount with the same request id and revision", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("crypto", { randomUUID: () => "33333333-3333-4333-8333-333333333333" });
  let posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        posts += 1;
        if (posts === 1) throw new TypeError("response lost");
        return response({
          requestId: "33333333-3333-4333-8333-333333333333",
          deviceId: POOL.devices[0]!.deviceId,
          assignmentId: POOL.devices[0]!.assignmentId,
          revision: 4,
          state: "released",
          releaseReason: "reservation_cancelled",
          releasedAt: "2026-09-12T10:00:00.000Z",
        });
      }
      return response(POOL);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = renderPanel(client);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Отменить резерв" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Освободить место" }),
  );
  await screen.findByText(/Результат неизвестен/);
  view.unmount();
  renderPanel(client);
  await screen.findByText("1 из 2");
  await user.click(screen.getByRole("button", { name: "Отменить резерв" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Освободить место" }),
  );
  expect(bodies).toEqual([
    { requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: 3 },
    { requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: 3 },
  ]);
});

it("treats authorization denial as known, clears confirmation and refreshes access", async () => {
  vi.stubGlobal("crypto", { randomUUID: () => "33333333-3333-4333-8333-333333333333" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? response({ message: "Forbidden" }, 403) : response(POOL),
    ),
  );
  renderPanel();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Отменить резерв" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Освободить место" }),
  );
  expect(await screen.findByText(/Сессия или права изменились/)).toBeDefined();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByText(/Результат неизвестен/)).toBeNull();
  expect(authRefetch).toHaveBeenCalledTimes(1);
});

it("requires a fresh confirmation and request after a revision conflict", async () => {
  const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
  vi.stubGlobal("crypto", { randomUUID: () => ids.shift()! });
  const bodies: Array<{ requestId: string; expectedRevision: number }> = [];
  let revision = 3;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        if (bodies.length === 1) {
          revision = 4;
          return response({ message: "Conflict" }, 409);
        }
        return response({
          requestId: bodies[1]!.requestId,
          deviceId: POOL.devices[0]!.deviceId,
          assignmentId: POOL.devices[0]!.assignmentId,
          revision: 5,
          state: "released",
          releaseReason: "reservation_cancelled",
          releasedAt: "2026-09-12T10:00:00.000Z",
        });
      }
      return response({ ...POOL, devices: [{ ...POOL.devices[0]!, revision }] });
    }),
  );
  renderPanel();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Отменить резерв" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Освободить место" }),
  );
  expect(await screen.findByText(/Резерв изменился/)).toBeDefined();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Отменить резерв" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Освободить место" }),
  );
  expect(bodies).toEqual([
    { requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: 3 },
    { requestId: "44444444-4444-4444-8444-444444444444", expectedRevision: 4 },
  ]);
});

it("renders zero usage in English", async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ ...POOL, usage: 0 })),
  );
  renderPanel();
  expect(await screen.findByText("0 of 2")).toBeDefined();
});

it("blocks a reloaded cancelled reservation but permits security-revoked re-pair", () => {
  const device = {
    id: POOL.devices[0]!.deviceId,
    type: "station" as const,
    name: "Station reserve",
    place: { id: null, name: null },
    status: "revoked" as const,
    lastSeenAt: null,
    paired: false,
  };
  expect(reservationCancelledOrUnknown(device, undefined)).toBe(true);
  expect(
    reservationCancelledOrUnknown(device, {
      ...POOL,
      devices: [{ ...POOL.devices[0]!, state: "released", releaseReason: "reservation_cancelled" }],
    }),
  ).toBe(true);
  expect(
    reservationCancelledOrUnknown(device, {
      ...POOL,
      devices: [{ ...POOL.devices[0]!, state: "released", releaseReason: "security_revoked" }],
    }),
  ).toBe(false);
});
