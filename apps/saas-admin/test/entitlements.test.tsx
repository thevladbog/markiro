import { createMemoryRouter, RouterProvider } from "react-router";
import { NavigationGuardProvider } from "../src/layout/NavigationGuard.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import "../src/i18n/index.js";
import { EntitlementsPanel } from "../src/pages/tenants/EntitlementsPanel.js";
import { ENTITLEMENT_SNAPSHOT } from "./entitlements-fixture.js";
import { jsonResponse } from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(
  capabilities: Array<"tenants.write" | "billing.write"> = ["tenants.write", "billing.write"],
) {
  const previews: Record<string, unknown>[] = [];
  const confirms: Record<string, unknown>[] = [];
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/preview")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        previews.push(body);
        const command = body.command as { requestId: string } | undefined;
        return jsonResponse(200, {
          previewId: "31111111-1111-4111-8111-111111111111",
          requestId: command?.requestId ?? body.requestId,
          intent: body.intent,
          revision: "3",
          usageRevision: "2",
          expiresAt: "2099-01-01T00:00:00.000Z",
          before: ENTITLEMENT_SNAPSHOT,
          after: ENTITLEMENT_SNAPSHOT,
        });
      }
      if (url.endsWith("/confirm")) {
        confirms.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse(409, { code: "entitlement_preview_stale" });
      }
      reads++;
      return jsonResponse(200, {
        snapshot: ENTITLEMENT_SNAPSHOT,
        detailsVisible: false,
        sourceDetails: [],
      });
    }),
  );
  render(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: "/",
          element: (
            <NavigationGuardProvider>
              <QueryClientProvider
                client={
                  new QueryClient({
                    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
                  })
                }
              >
                <ThemeProvider>
                  <EntitlementsPanel
                    tenantId={ENTITLEMENT_SNAPSHOT.tenantId}
                    capabilities={capabilities}
                  />
                </ThemeProvider>
              </QueryClientProvider>
            </NavigationGuardProvider>
          ),
        },
      ])}
    />,
  );
  return { previews, confirms, reads: () => reads };
}
it("uses server current quota separately from candidate and labels unknown mappings and scoped prepared sources", async () => {
  setup([]);
  expect(await screen.findByText("17 / 20")).toBeDefined();
  expect(screen.getByText("17 / 25")).toBeDefined();
  expect(screen.getAllByText("Подготовлено").length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Не сопоставлено/).length).toBeGreaterThan(0);
  expect(screen.getByText("НК: поиск товара")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Подготовить источник" })).toBeNull();
});
it.each([["tenants.write"], ["billing.write"]] as const)(
  "requires both capabilities: %s alone cannot mutate",
  async (capability) => {
    setup([capability]);
    await screen.findByText("17 / 20");
    expect(screen.queryByRole("button", { name: "Подготовить источник" })).toBeNull();
  },
);
async function prepare(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Подготовить источник" }));
  fireEvent.change(screen.getByLabelText("Основание"), { target: { value: "Test intent" } });
  fireEvent.change(screen.getByLabelText("Ссылка на решение"), {
    target: { value: "internal-decision" },
  });
  await user.click(screen.getByLabelText("НК: поиск товара"));
  await user.click(screen.getByRole("button", { name: "Рассчитать изменения" }));
  await screen.findByRole("button", { name: "Подтвердить подготовку" });
}
it("editing intent invalidates confirmation; stale preview retains intent, refreshes facts and uses a new UUID", async () => {
  const api = setup();
  const user = userEvent.setup();
  await prepare(user);
  await user.type(screen.getByLabelText("Основание"), " updated");
  expect(screen.queryByRole("button", { name: "Подтвердить подготовку" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Рассчитать изменения" }));
  await user.click(await screen.findByRole("button", { name: "Подтвердить подготовку" }));
  await screen.findByText("Предпросмотр устарел. Данные обновлены; рассчитайте изменения заново.");
  expect((screen.getByLabelText("Основание") as HTMLInputElement).value).toBe(
    "Test intent updated",
  );
  expect(api.reads()).toBeGreaterThan(1);
  await user.click(screen.getByRole("button", { name: "Рассчитать изменения" }));
  await waitFor(() => expect(api.previews).toHaveLength(3));
  const ids = api.previews.map((p) => (p.command as { requestId: string }).requestId);
  expect(new Set(ids).size).toBe(3);
});

it("shows calculation time, usage time, next change and exact plan source baseline without recalculating the current quota", async () => {
  setup([]);
  await screen.findByText("17 / 20");
  expect(screen.getByText(/Следующее изменение:/)).toBeDefined();
  expect(screen.getByText(/Рассчитано:/)).toBeDefined();
  expect(screen.getByText(/Использование на:/)).toBeDefined();
  expect(screen.getByText("Линии: 1")).toBeDefined();
  expect(screen.getByText("Киоски: 0")).toBeDefined();
  expect(screen.getByText("Пользователи кабинета: Без лимита")).toBeDefined();
});

it("does not call a future addon current merely because it belongs to the current subscription", async () => {
  const future = {
    ...ENTITLEMENT_SNAPSHOT,
    sources: [
      ...ENTITLEMENT_SNAPSHOT.sources,
      {
        id: "41111111-1111-4111-8111-111111111111",
        versionId: "51111111-1111-4111-8111-111111111111",
        kind: "addon",
        prepared: false,
        startsAt: "2026-09-20T00:00:00.000Z",
        endsAt: "2026-10-01T00:00:00.000Z",
        effects: [{ key: "stations", quotaIncrement: 1 }],
        operationIds: [],
      },
    ],
  };
  setup([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse(200, { snapshot: future, detailsVisible: false, sourceDetails: [] }),
    ),
  );
  // A second tenant instance has its own fresh query and exercises the server interval.
  cleanup();
  render(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: "/",
          element: (
            <NavigationGuardProvider>
              <QueryClientProvider
                client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
              >
                <ThemeProvider>
                  <EntitlementsPanel tenantId={ENTITLEMENT_SNAPSHOT.tenantId} capabilities={[]} />
                </ThemeProvider>
              </QueryClientProvider>
            </NavigationGuardProvider>
          ),
        },
      ])}
    />,
  );
  expect(await screen.findByText("Запланировано")).toBeDefined();
});

it("keeps preview confirmation next to a compact server before/after comparison", async () => {
  setup();
  const user = userEvent.setup();
  await prepare(user);
  expect(screen.getAllByRole("heading", { name: "Права и использование" })).toHaveLength(1);
  expect(screen.getByRole("table", { name: "Влияние на подготовленную модель" })).toBeDefined();
});

it("retains editable intent if refreshing an obsolete preview fails", async () => {
  setup();
  const user = userEvent.setup();
  await prepare(user);
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) =>
      String(input).endsWith("/entitlements")
        ? jsonResponse(503, { code: "unavailable" })
        : original(input, init),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Подтвердить подготовку" }));
  await screen.findAllByText("Не удалось загрузить права.");
  expect((screen.getByLabelText("Основание") as HTMLInputElement).value).toBe("Test intent");
  expect(screen.queryByRole("button", { name: "Подтвердить подготовку" })).toBeNull();
});

it.each(["network", "contract", "server"])(
  "retries an uncertain %s confirmation with the exact same identity",
  async (failure) => {
    const api = setup();
    const user = userEvent.setup();
    await prepare(user);
    const original = globalThis.fetch;
    const attempts: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (!String(input).endsWith("/confirm")) return original(input, init);
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        attempts.push(body);
        if (attempts.length === 1) {
          if (failure === "network") throw new TypeError("response lost");
          return failure === "contract"
            ? jsonResponse(200, {})
            : jsonResponse(503, { code: "unavailable" });
        }
        return jsonResponse(200, {
          ...body,
          sourceId: "41111111-1111-4111-8111-111111111111",
          confirmedAt: "2026-09-11T10:00:00.000Z",
          after: ENTITLEMENT_SNAPSHOT,
        });
      }),
    );
    await user.click(screen.getByRole("button", { name: "Подтвердить подготовку" }));
    const retry = await screen.findByRole("button", { name: "Повторить подтверждение" });
    expect(
      (screen.getByRole("button", { name: "Подготовить источник" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Рассчитать изменения" }) as HTMLButtonElement).closest(
        "fieldset",
      )?.disabled,
    ).toBe(true);
    await user.click(retry);
    await screen.findByText("Изменение подготовлено. Текущие права не изменены.");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(api.previews).toHaveLength(1);
  },
);

it("reports committed confirmation separately when the following refresh fails", async () => {
  setup();
  const user = userEvent.setup();
  await prepare(user);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).endsWith("/confirm"))
        return jsonResponse(200, {
          ...JSON.parse(String(init.body)),
          sourceId: "41111111-1111-4111-8111-111111111111",
          confirmedAt: "2026-09-11T10:00:00.000Z",
          after: ENTITLEMENT_SNAPSHOT,
        });
      return jsonResponse(503, { code: "unavailable" });
    }),
  );
  await user.click(screen.getByRole("button", { name: "Подтвердить подготовку" }));
  await screen.findByText(
    "Подготовленная модель сохранена. Текущие права не изменены. Не удалось обновить отображаемые данные.",
  );
  expect(screen.queryByRole("button", { name: "Подтвердить подготовку" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Повторить подтверждение" })).toBeNull();
});

it("releases an uncertain unconfirmed command only for a verified stale preview and recalculates with a new UUID", async () => {
  const api = setup();
  const user = userEvent.setup();
  await prepare(user);
  const original = globalThis.fetch;
  let lost = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).endsWith("/confirm") && !lost) {
        lost = true;
        throw new TypeError("response lost before commit");
      }
      return original(input, init);
    }),
  );
  await user.click(screen.getByRole("button", { name: "Подтвердить подготовку" }));
  await user.click(await screen.findByRole("button", { name: "Повторить подтверждение" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Повторить подтверждение" })).toBeNull(),
  );
  expect(
    (screen.getByLabelText("Основание") as HTMLInputElement).closest("fieldset")?.disabled,
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Рассчитать изменения" }));
  await screen.findByRole("button", { name: "Подтвердить подготовку" });
  expect(api.previews).toHaveLength(2);
  const requestId = (preview: Record<string, unknown> | undefined) =>
    (preview?.command as { requestId: string }).requestId;
  expect(requestId(api.previews[1])).not.toBe(requestId(api.previews[0]));
});
