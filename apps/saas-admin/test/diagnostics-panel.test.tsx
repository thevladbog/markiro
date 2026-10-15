import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, createMemoryRouter } from "react-router";
import { ThemeProvider } from "@markiro/ui";
import i18n from "../src/i18n/index.js";
import { NavigationGuardProvider } from "../src/layout/NavigationGuard.js";
import { TenantDiagnosticsPanel } from "../src/pages/tenants/TenantDiagnosticsPanel.js";
import { jsonResponse } from "./render.js";
import {
  DIAG_DETAIL,
  DIAG_EMPTY_OVERVIEW,
  DIAG_HISTORY,
  DIAG_ID,
  DIAG_INGESTED,
  DIAG_OVERVIEW,
  DIAG_STATISTICS,
  DIAG_TENANT_ID,
} from "./diagnostics-fixtures.js";

const BASE = `/api/platform/tenants/${DIAG_TENANT_ID}/standalone-diagnostics`;
function stubApi(routes: Record<string, Array<() => Response>>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${String(input)}`;
      calls.push({ key, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      const queue = routes[key];
      const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      if (!next) throw new Error(`Unexpected request: ${key}`);
      return next();
    }),
  );
  return calls;
}
const standard = () => ({
  [`GET ${BASE}/overview`]: [() => jsonResponse(200, DIAG_OVERVIEW)],
  [`GET ${BASE}/statistics`]: [() => jsonResponse(200, DIAG_STATISTICS)],
  [`GET ${BASE}`]: [() => jsonResponse(200, DIAG_HISTORY)],
  [`GET ${BASE}/${DIAG_ID}`]: [() => jsonResponse(200, DIAG_DETAIL)],
});
function renderPanel(canWrite: boolean) {
  // The form guards unsaved input through the app shell's navigation guard (a data router).
  const router = createMemoryRouter([
    {
      path: "*",
      element: (
        <NavigationGuardProvider>
          <TenantDiagnosticsPanel tenantId={DIAG_TENANT_ID} canWrite={canWrite} />
        </NavigationGuardProvider>
      ),
    },
  ]);
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tenant diagnostics tab (plan ДИАГ У1)", () => {
  it("shows quotas as used of available, an over-limit badge with text, the cloud file comparison and no 'outdated' without a source", async () => {
    stubApi(standard());
    renderPanel(true);
    expect(await screen.findByText(/Цех розлива/u)).toBeDefined();
    expect(screen.getByText(/4 из 3/u)).toBeDefined();
    expect(screen.getByText(/сверх лимита/u)).toBeDefined();
    expect(screen.getByText(/∞/u)).toBeDefined();
    expect(screen.getByText(/№3/u)).toBeDefined();
    expect(screen.getByText(/№4/u)).toBeDefined();
    expect(screen.queryByText(/устарел/iu)).toBeNull();
  });

  it("shows the empty state with the hint when there are no reports", async () => {
    stubApi({
      ...standard(),
      [`GET ${BASE}/overview`]: [() => jsonResponse(200, DIAG_EMPTY_OVERVIEW)],
      [`GET ${BASE}/statistics`]: [
        () => jsonResponse(200, { hosts: [], multipleHosts: false, months: [] }),
      ],
      [`GET ${BASE}`]: [() => jsonResponse(200, { items: [], nextCursor: null })],
    });
    renderPanel(true);
    expect(await screen.findByText(/Вставьте текст «Сведения для поддержки»/u)).toBeDefined();
  });

  it("hides the paste block without the licensing capability", async () => {
    stubApi(standard());
    renderPanel(false);
    await screen.findByText(/Цех розлива/u);
    expect(screen.queryByLabelText(/Текст «Сведения для поддержки»/u)).toBeNull();
  });

  it("sends the text, clears it, and reports the saved report", async () => {
    const calls = stubApi({
      ...standard(),
      [`POST ${BASE}`]: [() => jsonResponse(200, DIAG_INGESTED)],
    });
    renderPanel(true);
    const input = await screen.findByLabelText(/Текст «Сведения для поддержки»/u);
    await userEvent.type(input, "MKS1.sup-d11c3182.AAAA");
    await userEvent.click(screen.getByRole("button", { name: /Разобрать и сохранить/u }));
    expect(await screen.findByText(/Сохранено/u)).toBeDefined();
    expect(calls.find((c) => c.key === `POST ${BASE}`)?.body).toEqual({
      text: "MKS1.sup-d11c3182.AAAA",
    });
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain("MKS1.sup-d11c3182");
    expect(location.search).not.toContain("MKS1");
  });

  it("keeps the text typed while a report is being sent: no editing during the send, no clearing of the next report", async () => {
    let finish: () => void = () => undefined;
    stubApi(standard());
    vi.mocked(fetch).mockImplementation(async (input, init = {}) => {
      const key = `${init.method ?? "GET"} ${String(input)}`;
      if (key === `POST ${BASE}`) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return jsonResponse(200, DIAG_INGESTED);
      }
      const route = (standard() as Record<string, Array<() => Response>>)[key];
      if (!route?.[0]) throw new Error(`Unexpected request: ${key}`);
      return route[0]();
    });
    renderPanel(true);
    const input = (await screen.findByLabelText(
      /Текст «Сведения для поддержки»/u,
    )) as HTMLTextAreaElement;
    await userEvent.type(input, "MKS1.report-A");
    await userEvent.click(screen.getByRole("button", { name: /Разобрать и сохранить/u }));
    await waitFor(() => expect(input.readOnly).toBe(true));
    // Report B arrives in the field anyway (a paste event, an autofill): A's success must not wipe it.
    fireEvent.change(input, { target: { value: "MKS1.report-B" } });
    finish();
    expect(await screen.findByText(/Сохранено/u)).toBeDefined();
    expect(input.value).toBe("MKS1.report-B");
    expect(input.readOnly).toBe(false);
  });

  it("asks to confirm an unbound host and repeats the request with the flag", async () => {
    const calls = stubApi({
      ...standard(),
      [`POST ${BASE}`]: [
        () => jsonResponse(409, { code: "standalone_diagnostics_host_unbound" }),
        () => jsonResponse(200, DIAG_INGESTED),
      ],
    });
    renderPanel(true);
    await userEvent.type(
      await screen.findByLabelText(/Текст «Сведения для поддержки»/u),
      "MKS1.x.AAAA",
    );
    await userEvent.click(screen.getByRole("button", { name: /Разобрать и сохранить/u }));
    expect(await screen.findByText(/Площадка не найдена среди площадок клиента/u)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /Сохранить без привязки/u }));
    await waitFor(() => expect(calls.filter((c) => c.key === `POST ${BASE}`)).toHaveLength(2));
    expect(calls.filter((c) => c.key === `POST ${BASE}`)[1]?.body).toEqual({
      text: "MKS1.x.AAAA",
      acknowledgeUnboundHost: true,
    });
  });

  it.each([
    ["standalone_diagnostics_unknown_key", /не подходит ключ/u],
    ["standalone_diagnostics_undecryptable", /не удалось расшифровать/u],
    ["standalone_diagnostics_host_other_tenant", /другого клиента/u],
    ["standalone_diagnostics_not_configured", /приём не настроен/u],
    ["standalone_diagnostics_text_too_large", /слишком большой/u],
  ])("explains %s in human words without the token", async (code, words) => {
    stubApi({
      ...standard(),
      [`POST ${BASE}`]: [() => jsonResponse(409, { code })],
    });
    renderPanel(true);
    await userEvent.type(
      await screen.findByLabelText(/Текст «Сведения для поддержки»/u),
      "SECRET-TOKEN-TEXT",
    );
    await userEvent.click(screen.getByRole("button", { name: /Разобрать и сохранить/u }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(words);
    expect(alert.textContent).not.toContain("SECRET-TOKEN-TEXT");
  });

  it("shows 'no data' for a missing month, never zero, and notes several hosts", async () => {
    stubApi(standard());
    renderPanel(false);
    const table = await screen.findByRole("table", { name: /Статистика по месяцам/u });
    expect(within(table).getByText("2026-09")).toBeDefined();
    const gap = within(table).getByText("2026-09").closest("tr");
    expect(gap?.textContent).toMatch(/нет данных/u);
    expect(screen.getByText(/несколько хостов/iu)).toBeDefined();
  });

  it("opens one report from the history", async () => {
    stubApi(standard());
    renderPanel(false);
    await userEvent.click(await screen.findByRole("button", { name: /Открыть отчёт/u }));
    // The overview already names the system; the opened report must show it inside its own dialog.
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/WebView2 130/u)).toBeDefined();
  });
});
