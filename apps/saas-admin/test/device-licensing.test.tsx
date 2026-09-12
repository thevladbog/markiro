import type { DeviceRetentionInspection } from "@markiro/platform-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n/index.js";
import { DeviceLicensingPanel } from "../src/pages/tenants/DeviceLicensingPanel.js";

const authRefetch = vi.hoisted(() => vi.fn());
vi.mock("../src/auth/client.js", () => ({
  useAuthClient: () => ({ useSession: () => ({ refetch: authRefetch }) }),
}));

const RETENTION: DeviceRetentionInspection = {
  canSelect: false,
  observation: null,
  selections: [],
  currentShadow: { awaitingSelection: false, affectedDeviceIds: [], enforced: false },
};
const POOL = {
  tenantId: "tenant-1",
  usage: 0,
  limit: null,
  canCancelReservations: true,
  integrity: "ready" as const,
  devices: [
    {
      deviceId: "11111111-1111-4111-8111-111111111111",
      name: "ТСД резерв",
      kind: "handheld" as const,
      assignmentId: "22222222-2222-4222-8222-222222222222",
      revision: 1,
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
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
  authRefetch.mockReset();
});

it("shows unlimited shared usage and never sends security revoke when cancelling", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  vi.stubGlobal("crypto", { randomUUID: () => "33333333-3333-4333-8333-333333333333" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/device-licensing/retention")) return response(RETENTION);
      if (String(input).endsWith("/device-licensing/replacements"))
        return response({ canPrepare: false, items: [] });
      const url = String(input);
      calls.push({ url, ...(init?.method ? { method: init.method } : {}) });
      if (init?.method === "POST")
        return response({
          requestId: "33333333-3333-4333-8333-333333333333",
          deviceId: POOL.devices[0]!.deviceId,
          assignmentId: POOL.devices[0]!.assignmentId,
          revision: 2,
          state: "released",
          releaseReason: "reservation_cancelled",
          releasedAt: "2026-09-12T10:00:00.000Z",
        });
      return response(POOL);
    }),
  );
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <ThemeProvider defaultTheme="light">
          <DeviceLicensingPanel tenantId="tenant-1" canWrite />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  expect(await screen.findByText(/без лимита/i)).toBeDefined();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Отменить резерв" }));
  expect(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Отмена" }),
  ).toBeDefined();
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Освободить место" }),
  );
  expect(calls.some((call) => call.url.includes("revoke"))).toBe(false);
  expect(
    calls.some(
      (call) =>
        call.url.endsWith(
          "/device-licensing/11111111-1111-4111-8111-111111111111/cancel-reservation",
        ) && call.method === "POST",
    ),
  ).toBe(true);
});

it("keeps cancellation unavailable without both platform write capabilities", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      response(
        String(input).endsWith("/device-licensing/retention")
          ? RETENTION
          : String(input).endsWith("/device-licensing/replacements")
            ? { canPrepare: false, items: [] }
            : POOL,
      ),
    ),
  );
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ThemeProvider defaultTheme="light">
          <DeviceLicensingPanel tenantId="tenant-1" canWrite={false} />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  await screen.findByRole("heading", { name: "Рабочие устройства: Station и ТСД" });
  expect(screen.queryByRole("button", { name: "Отменить резерв" })).toBeNull();
});

it("closes confirmation and reports a known session denial on 401", async () => {
  vi.stubGlobal("crypto", { randomUUID: () => "33333333-3333-4333-8333-333333333333" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/device-licensing/retention")
        ? response(RETENTION)
        : String(input).endsWith("/device-licensing/replacements")
          ? response({ canPrepare: false, items: [] })
          : init?.method === "POST"
            ? response(
                {
                  code: "unauthorized",
                  message: "Unauthorized",
                  requestId: "55555555-5555-4555-8555-555555555555",
                },
                401,
              )
            : response(POOL),
    ),
  );
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <ThemeProvider defaultTheme="light">
          <DeviceLicensingPanel tenantId="tenant-1" canWrite />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
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

it("closes an open confirmation before submit when write access changes", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) =>
    response(
      String(input).endsWith("/device-licensing/retention")
        ? RETENTION
        : String(input).endsWith("/device-licensing/replacements")
          ? { canPrepare: false, items: [] }
          : POOL,
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const frame = (canWrite: boolean) => (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ThemeProvider defaultTheme="light">
          <DeviceLicensingPanel tenantId="tenant-1" canWrite={canWrite} />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
  const view = render(frame(true));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Отменить резерв" }));
  expect(screen.getByRole("alertdialog")).toBeDefined();
  view.rerender(frame(false));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "/api/platform/tenants/tenant-1/device-licensing",
    "/api/platform/tenants/tenant-1/device-licensing/replacements",
    "/api/platform/tenants/tenant-1/device-licensing/retention",
  ]);
});

it("requires a fresh confirmation and request after a revision conflict", async () => {
  const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
  vi.stubGlobal("crypto", { randomUUID: () => ids.shift()! });
  const bodies: Array<{ requestId: string; expectedRevision: number }> = [];
  let revision = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/device-licensing/retention")) return response(RETENTION);
      if (String(input).endsWith("/device-licensing/replacements"))
        return response({ canPrepare: false, items: [] });
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        if (bodies.length === 1) {
          revision = 2;
          return response(
            {
              code: "conflict",
              message: "Conflict",
              requestId: "55555555-5555-4555-8555-555555555555",
            },
            409,
          );
        }
        return response({
          requestId: bodies[1]!.requestId,
          deviceId: POOL.devices[0]!.deviceId,
          assignmentId: POOL.devices[0]!.assignmentId,
          revision: 3,
          state: "released",
          releaseReason: "reservation_cancelled",
          releasedAt: "2026-09-12T10:00:00.000Z",
        });
      }
      return response({ ...POOL, devices: [{ ...POOL.devices[0]!, revision }] });
    }),
  );
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <ThemeProvider defaultTheme="light">
          <DeviceLicensingPanel tenantId="tenant-1" canWrite />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
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
    { requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: 1 },
    { requestId: "44444444-4444-4444-8444-444444444444", expectedRevision: 2 },
  ]);
});

it.each(["network", 401, 403, 409] as const)(
  "retries an uncertain %s result after remount with the same request",
  async (failure) => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333")
      .mockReturnValue("44444444-4444-4444-8444-444444444444");
    vi.stubGlobal("crypto", { randomUUID });
    const bodies: unknown[] = [];
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/device-licensing/retention")) return response(RETENTION);
        if (String(input).endsWith("/device-licensing/replacements"))
          return response({ canPrepare: false, items: [] });
        if (init?.method === "POST") {
          bodies.push(JSON.parse(String(init.body)));
          posts += 1;
          if (posts === 1) {
            if (failure === "network") throw new TypeError("response lost");
            return response({ message: "Malformed error without code or requestId" }, failure);
          }
          return response({
            requestId: "33333333-3333-4333-8333-333333333333",
            deviceId: POOL.devices[0]!.deviceId,
            assignmentId: POOL.devices[0]!.assignmentId,
            revision: 2,
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
    const frame = (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <ThemeProvider defaultTheme="light">
            <DeviceLicensingPanel tenantId="tenant-1" canWrite />
          </ThemeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    );
    const view = render(frame);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Отменить резерв" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Освободить место" }),
    );
    await screen.findByText(/Результат неизвестен/);
    expect(authRefetch).not.toHaveBeenCalled();
    expect(
      client.getQueryData([
        "platform",
        "tenants",
        "tenant-1",
        "device-licensing",
        "cancel-attempt",
        POOL.devices[0]!.deviceId,
      ]),
    ).toEqual({
      requestId: "33333333-3333-4333-8333-333333333333",
      expectedRevision: 1,
    });
    view.unmount();
    render(frame);
    await user.click(await screen.findByRole("button", { name: "Отменить резерв" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Освободить место" }),
    );
    expect(bodies).toEqual([
      { requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: 1 },
      { requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: 1 },
    ]);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  },
);

it("renders zero unlimited usage in English", async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      response(
        String(input).endsWith("/device-licensing/retention")
          ? RETENTION
          : String(input).endsWith("/device-licensing/replacements")
            ? { canPrepare: false, items: [] }
            : { ...POOL, usage: 0 },
      ),
    ),
  );
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ThemeProvider defaultTheme="light">
          <DeviceLicensingPanel tenantId="tenant-1" canWrite />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  expect(await screen.findByText("0 · unlimited")).toBeDefined();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Cancel reservation" }));
  expect(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
  ).toBeDefined();
});

it("shows the translated licensing load error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ message: "Unavailable" }, 503)),
  );
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ThemeProvider defaultTheme="light">
          <DeviceLicensingPanel tenantId="tenant-1" canWrite />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  expect(await screen.findByText("Не удалось загрузить учёт рабочих устройств.")).toBeDefined();
});

it("binds retention inspection to the route tenant when pool response names another tenant", async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/retention")) return response(RETENTION);
      if (url.endsWith("/replacements")) return response({ canPrepare: false, items: [] });
      return response({ ...POOL, tenantId: "wrong-tenant" });
    }),
  );
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ThemeProvider defaultTheme="light">
          <DeviceLicensingPanel tenantId="tenant-1" canWrite />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  await screen.findByText("ТСД резерв · ТСД");
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() =>
    expect(urls.filter((url) => url.endsWith("/retention"))).toEqual([
      expect.stringContaining("/tenants/tenant-1/device-licensing/retention"),
    ]),
  );
});
