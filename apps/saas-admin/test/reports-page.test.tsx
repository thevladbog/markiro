import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { platformErrorSchema, platformReportSchema } from "@markiro/platform-contracts";
import type { PlatformPrincipal } from "../src/auth/PlatformAuthBoundary.js";
import * as AuthBoundary from "../src/auth/PlatformAuthBoundary.js";
import i18n from "../src/i18n/index.js";

import {
  jsonResponse,
  PLATFORM_ADMIN_ME,
  renderSaasApp,
  SUPPORT_ME,
  TENANT_ID,
  TENANT_LIST_ITEM,
} from "./render.js";

const REPORT_ID = "81111111-1111-4111-8111-111111111111";
const readyReport = (overrides: Record<string, unknown> = {}) =>
  platformReportSchema.parse({
    id: REPORT_ID,
    parameters: {
      reportType: "shifts",
      tenantIds: [TENANT_ID],
      fromDate: "2026-09-01",
      toDate: "2026-09-10",
      timezone: "Europe/Moscow",
      periodBasis: "events",
      privacy: "pseudonymous",
    },
    status: "ready",
    createdAt: "2026-09-10T08:00:00.000Z",
    snapshotAt: "2026-09-10T08:01:00.000Z",
    completedAt: "2026-09-10T08:02:00.000Z",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    errorCode: null,
    rowCount: 0,
    byteSize: 512,
    filename: "shifts.zip",
    ...overrides,
  });

const platformError = (code: string) =>
  platformErrorSchema.parse({
    code,
    message: "Report request failed",
    requestId: "85111111-1111-4111-8111-111111111111",
  });

async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  label: RegExp,
  option: string,
) {
  await user.click(within(container).getByRole("combobox", { name: label }));
  await user.click(await within(document.body).findByRole("option", { name: option }));
}

function installReportsApi({
  me = PLATFORM_ADMIN_ME as PlatformPrincipal,
  reports = [] as unknown[] | unknown[][],
  failFirstCreate = false,
  failDownload = false,
  listDelayMs = 0,
} = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let createCount = 0;
  let listCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
      if (url.includes("/api/platform/tenants?")) {
        return jsonResponse(200, { items: [TENANT_LIST_ITEM], page: 1, limit: 50, total: 1 });
      }
      if (url.includes("/api/platform/reports/options?")) {
        calls.push({ url, method });
        return jsonResponse(200, {
          items: [
            { id: "91111111-1111-4111-8111-111111111111", name: "Line 1", tenantId: TENANT_ID },
          ],
          nextOffset: url.includes("offset=0") ? 50 : null,
        });
      }
      if (url.endsWith("/api/platform/reports") && method === "POST") {
        const body = JSON.parse(String(init.body));
        calls.push({ url, method, body });
        createCount += 1;
        if (failFirstCreate && createCount === 1)
          return jsonResponse(503, platformError("report_unavailable"));
        const parameters = { ...body };
        delete parameters.idempotencyKey;
        return jsonResponse(201, readyReport({ parameters }));
      }
      if (url.includes("/api/platform/reports?") && method === "GET") {
        calls.push({ url, method });
        if (listDelayMs > 0)
          await new Promise((resolve) => globalThis.setTimeout(resolve, listDelayMs));
        const items = Array.isArray(reports[0])
          ? (reports as unknown[][])[Math.min(listCount, reports.length - 1)]!
          : reports;
        listCount += 1;
        return jsonResponse(200, {
          items: (items as unknown[]).map((report) => platformReportSchema.parse(report)),
          nextOffset: null,
        });
      }
      if (url.endsWith(`/api/platform/reports/${REPORT_ID}/download`)) {
        calls.push({ url, method });
        if (failDownload) return jsonResponse(410, platformError("report_expired"));
        return jsonResponse(200, {
          url: "https://download.invalid/report",
          filename: "shifts.zip",
          expiresInSeconds: 300,
        });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    }),
  );
  return calls;
}

afterEach(async () => {
  // Unmount observers and expiry effects before replacing clocks or notifying i18n.
  cleanup();
  vi.useRealTimers();
  await act(async () => {
    await i18n.changeLanguage("ru");
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("platform reports", () => {
  it("selects filters and dates through keyboard-accessible custom popovers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    const calls = installReportsApi();
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    const status = within(view.container).getByRole("combobox", { name: /статус/i });
    status.focus();
    await user.keyboard("{ArrowDown}");
    const listbox = await within(document.body).findByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: "Активна" }));
    expect(status.textContent).toContain("Активна");
    const from = within(view.container).getByRole("button", { name: "Дата с" });
    await user.click(from);
    await within(document.body).findByRole("dialog", { name: "Календарь" });
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(within(document.body).queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(from);
    await user.click(within(view.container).getByRole("radio", { name: "Агрегированный" }));
    expect(within(view.container).queryByRole("combobox", { name: /^оператор$/i })).toBeNull();
    await user.click(within(view.container).getByRole("button", { name: /сформировать/i }));
    await waitFor(() =>
      expect(calls.find((call) => call.body)?.body).toMatchObject({
        status: "active",
        fromDate: "2026-09-09",
        toDate: "2026-09-10",
        privacy: "aggregate",
      }),
    );
  });
  it.each([
    ["2026-09-10T20:59:59.000Z", "2026-09-10"],
    ["2026-09-10T21:00:00.000Z", "2026-09-11"],
  ])("defaults both dates to the Moscow calendar day at %s", async (now, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    installReportsApi();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await within(view.container).findByRole("checkbox", { name: /завод/i });
    expect(within(view.container).getByRole("button", { name: "Дата с" })).toBeTruthy();
    const dates = view.container.querySelectorAll<HTMLInputElement>(
      'input[name="fromDate"], input[name="toDate"]',
    );
    expect(Array.from(dates, (input) => input.value)).toEqual([expected, expected]);
  });

  it("refreshes default dates on remount after Moscow midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T20:59:59.000Z"));
    installReportsApi();
    const first = renderSaasApp({ initialEntry: "/reports" });
    await within(first.container).findByRole("checkbox", { name: /завод/i });
    first.unmount();
    vi.setSystemTime(new Date("2026-09-10T21:00:00.000Z"));
    const second = renderSaasApp({ initialEntry: "/reports" });
    await within(second.container).findByRole("checkbox", { name: /завод/i });
    const dates = second.container.querySelectorAll<HTMLInputElement>(
      'input[name="fromDate"], input[name="toDate"]',
    );
    expect(Array.from(dates, (input) => input.value)).toEqual(["2026-09-11", "2026-09-11"]);
  });

  it("preserves explicitly selected dates when timezone changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    installReportsApi();
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await within(view.container).findByRole("checkbox", { name: /завод/i });
    for (const name of ["Дата с", "Дата по"]) {
      await user.click(within(view.container).getByRole("button", { name }));
      await user.click(within(document.body).getByRole("button", { name: "Предыдущий месяц" }));
      await user.click(within(document.body).getByRole("button", { name: /25 августа 2026/ }));
    }
    const dates = view.container.querySelectorAll<HTMLInputElement>(
      'input[name="fromDate"], input[name="toDate"]',
    );
    fireEvent.change(within(view.container).getByLabelText(/часовой пояс/i), {
      target: { value: "America/New_York" },
    });
    expect(Array.from(dates, (input) => input.value)).toEqual(["2026-08-25", "2026-08-25"]);
  });

  it("denies the route and hides navigation without reports.read", async () => {
    installReportsApi({ me: SUPPORT_ME });
    const view = renderSaasApp({ initialEntry: "/reports" });
    expect(await within(view.container).findByText(/недоступ/i)).toBeTruthy();
    expect(within(view.container).queryByRole("link", { name: /отч[её]т/i })).toBeNull();
  });

  it("creates a pseudonymous report with explicit scope and period", async () => {
    const calls = installReportsApi();
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    await user.click(within(view.container).getByRole("button", { name: /сформировать/i }));
    await waitFor(() => expect(calls.some((call) => call.body)).toBe(true));
    expect(calls.find((call) => call.body)?.body).toMatchObject({
      reportType: "shifts",
      tenantIds: [TENANT_ID],
      fromDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      toDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      timezone: "Europe/Moscow",
      privacy: "pseudonymous",
      periodBasis: "events",
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("clears incompatible filters synchronously when the template changes", async () => {
    installReportsApi();
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    const form = view.container.querySelector("form")!;
    await selectOption(user, form, /статус/i, "Активна");
    await selectOption(user, form, /шаблон/i, "CommerceML");
    expect(within(form).queryByLabelText(/статус/i)).toBeNull();
    expect(within(form).getByLabelText(/результат обмена/i)).toBeTruthy();
  });

  it("renders zero-row ready, failed and expired history with valid named actions", async () => {
    installReportsApi({
      reports: [
        readyReport(),
        {
          ...readyReport(),
          id: "82111111-1111-4111-8111-111111111111",
          status: "failed",
          errorCode: "REPORT_SOURCE_TIMEOUT",
          rowCount: null,
          filename: null,
        },
        {
          ...readyReport(),
          id: "83111111-1111-4111-8111-111111111111",
          status: "expired",
          rowCount: 4,
        },
      ],
    });
    const view = renderSaasApp({ initialEntry: "/reports" });
    const downloadButton = await within(view.container).findByRole("button", { name: /скачать/i });
    const table = downloadButton.closest("table")!;
    expect(within(table).getByText("0")).toBeTruthy();
    expect(within(table).getByRole("button", { name: /скачать/i })).toBeTruthy();
    expect(within(table).getAllByRole("button", { name: /повторить/i })).toHaveLength(2);
    expect(within(table).queryAllByRole("button", { name: /скачать/i })).toHaveLength(1);
    expect(within(table).getByText(/тайм-аут/i)).toBeTruthy();
  });

  it("keeps the idempotency key for delivery retry and uses a fresh key for explicit repeat", async () => {
    const calls = installReportsApi({
      failFirstCreate: true,
      reports: [
        {
          ...readyReport(),
          status: "failed",
          errorCode: "REPORT_SOURCE_FAILED",
          rowCount: null,
          filename: null,
        },
      ],
    });
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    await user.click(within(view.container).getByRole("button", { name: /сформировать/i }));
    await user.click(
      await within(view.container).findByRole("button", { name: /повторить отправку/i }),
    );
    await user.click(await within(view.container).findByRole("button", { name: /^повторить$/i }));
    const bodies = calls
      .filter((call) => call.body)
      .map((call) => call.body as { idempotencyKey: string });
    expect(bodies[0]?.idempotencyKey).toBe(bodies[1]?.idempotencyKey);
    expect(bodies[2]?.idempotencyKey).not.toBe(bodies[1]?.idempotencyKey);
    expect(within(view.container).queryByText(/не удалось поставить/i)).toBeNull();
    expect(calls.filter((call) => call.url.includes("/reports?")).length).toBeGreaterThan(1);
  });

  it("searches and requests the next options page", async () => {
    const calls = installReportsApi();
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    await user.type(within(view.container).getByLabelText(/поиск вариантов/i), "line");
    await waitFor(() => expect(calls.some((call) => call.url.includes("search=line"))).toBe(true));
    await user.click(
      within(view.container).getAllByRole("button", { name: /следующие варианты/i })[0]!,
    );
    await waitFor(() => expect(calls.some((call) => call.url.includes("offset=50"))).toBe(true));
  });

  it("polls pending history through ready, stops, and reloads it after navigation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = { ...readyReport(), status: "queued", rowCount: null, filename: null };
    const processing = { ...pending, status: "processing" };
    const calls = installReportsApi({
      reports: [[pending], [processing], [readyReport()], [readyReport()]],
    });
    const view = renderSaasApp({ initialEntry: "/reports" });
    expect(await within(view.container).findByText("В очереди")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(await within(view.container).findByText("Формируется")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(await within(view.container).findByText("Готов")).toBeTruthy();
    const countAtReady = calls.filter((call) => call.url.includes("/reports?")).length;
    await act(() => vi.advanceTimersByTimeAsync(6_100));
    expect(calls.filter((call) => call.url.includes("/reports?")).length).toBe(countAtReady);
    await act(() => view.router.navigate("/"));
    await act(() => view.router.navigate("/reports"));
    expect(await within(view.container).findByText("Готов")).toBeTruthy();
  });

  it("renders report reading without identified controls or operator requests", async () => {
    const principal = {
      ...PLATFORM_ADMIN_ME,
      capabilities: ["reports.read", "reports.create", "reports.download"],
    } as PlatformPrincipal;
    vi.spyOn(AuthBoundary, "usePlatformPrincipal").mockReturnValue(principal);
    const calls = installReportsApi({ reports: [readyReport()] });
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    expect(
      await within(view.container).findByRole("heading", { name: /операционные отчёты/i }),
    ).toBeTruthy();
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    await waitFor(() => expect(calls.some((call) => call.url.includes("kind=lines"))).toBe(true));
    expect(within(view.container).queryByLabelText(/^оператор$/i)).toBeNull();
    expect(within(view.container).queryByRole("radio", { name: /с идентификацией/i })).toBeNull();
    expect(calls.some((call) => call.url.includes("kind=operators"))).toBe(false);
  });

  it("localizes report status and outcome option labels in Russian and English", async () => {
    installReportsApi();
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    const form = view.container.querySelector("form")!;
    await user.click(within(form).getByRole("combobox", { name: /статус/i }));
    expect(within(document.body).getByRole("option", { name: "Активна" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    await user.click(within(form).getByRole("combobox", { name: /status/i }));
    expect(within(document.body).getByRole("option", { name: "Active" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await selectOption(user, form, /template/i, "CommerceML");
    await user.click(within(form).getByRole("combobox", { name: /outcome/i }));
    expect(within(document.body).getByRole("option", { name: "Successful" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(within(form).getByRole("button", { name: "Date from" }));
    expect(within(document.body).getByRole("dialog", { name: "Calendar" })).toBeTruthy();
    expect(within(document.body).getByRole("button", { name: "Previous month" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await act(async () => {
      await i18n.changeLanguage("ru");
    });
    await user.click(within(form).getByRole("combobox", { name: /результат обмена/i }));
    expect(within(document.body).getByRole("option", { name: "Успешно" })).toBeTruthy();
  });

  it("omits filters cleared by a template change", async () => {
    const calls = installReportsApi();
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    await selectOption(user, view.container, /^линия$/i, "Line 1");
    await selectOption(user, view.container, /шаблон/i, "CommerceML");
    await user.click(within(view.container).getByRole("button", { name: /сформировать/i }));
    await waitFor(() => expect(calls.some((call) => call.body)).toBe(true));
    expect(calls.find((call) => call.body)?.body).not.toHaveProperty("lineId");
  });

  it("removes download when a ready report reaches its local expiry deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    const laterExpiry = new Date(Date.now() + 2_000).toISOString();
    installReportsApi({
      reports: [
        { ...readyReport(), expiresAt },
        { ...readyReport(), id: "84111111-1111-4111-8111-111111111111", expiresAt: laterExpiry },
      ],
    });
    const view = renderSaasApp({ initialEntry: "/reports" });
    expect(await within(view.container).findAllByRole("button", { name: /скачать/i })).toHaveLength(
      2,
    );
    await act(() => vi.advanceTimersByTimeAsync(1_100));
    await waitFor(() =>
      expect(within(view.container).getAllByRole("button", { name: /скачать/i })).toHaveLength(1),
    );
    await act(() => vi.advanceTimersByTimeAsync(1_100));
    await waitFor(() =>
      expect(within(view.container).queryByRole("button", { name: /скачать/i })).toBeNull(),
    );
  });

  it("does not offer download for a ready report that expires before its response arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installReportsApi({
      reports: [readyReport({ expiresAt: new Date(Date.now() + 500).toISOString() })],
      listDelayMs: 1_000,
    });
    const view = renderSaasApp({ initialEntry: "/reports" });
    await act(() => vi.advanceTimersByTimeAsync(1_100));
    expect(await within(view.container).findByText("Готов")).toBeTruthy();
    expect(within(view.container).queryByRole("button", { name: /скачать/i })).toBeNull();
  });

  it("shows an actionable download error and refreshes history", async () => {
    const calls = installReportsApi({ reports: [readyReport()], failDownload: true });
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("button", { name: /скачать/i }));
    expect(await within(view.container).findByText(/не удалось получить ссылку/i)).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((call) => call.url.includes("/reports?")).length).toBeGreaterThan(1),
    );
    await waitFor(() => {
      expect(view.queryClient.isFetching()).toBe(0);
      expect(view.queryClient.isMutating()).toBe(0);
    });
  });
});
