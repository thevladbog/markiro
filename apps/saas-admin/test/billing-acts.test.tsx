import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, PLATFORM_ADMIN_ME, renderSaasApp, SUPPORT_ME } from "./render.js";

const TENANT_ID = "21111111-1111-4111-8111-111111111121";
const REQUEST_ID = "11111111-1111-4111-8111-111111111121";
const ACT_ID = "51111111-1111-4111-8111-111111111121";
const USER_ID = "61111111-1111-4111-8111-111111111121";
const now = "2026-08-28T08:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("platform billing act issue", () => {
  it("rejects non-PDF and oversized files before creating an act", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    renderSaasApp({
      initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
    });

    const input = await screen.findByLabelText("PDF акта");
    await user.upload(input, new File(["text"], "act.pdf", { type: "text/plain" }));
    expect(screen.getByRole("alert").textContent).toContain("только PDF");

    await user.upload(
      input,
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "oversized.pdf", {
        type: "application/pdf",
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain("5 МиБ");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("creates, uploads, and shows issued only from issued API metadata", async () => {
    const calls: Array<{ path: string; body: BodyInit | null | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ path: url, body: init?.body });
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/billing/acts")) {
          return jsonResponse(201, act("draft", null));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`)) {
          return jsonResponse(
            201,
            act("issued", {
              id: "71111111-1111-4111-8111-111111111121",
              revision: 1,
              state: "ready",
              contentType: "application/pdf",
              byteSize: 4,
              sha256: "a".repeat(64),
              uploadedByPlatformUserId: USER_ID,
              readyAt: now,
              createdAt: now,
              updatedAt: now,
            }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({
      initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
    });

    await user.type(await screen.findByLabelText("Номер акта"), "ACT-42");
    await user.type(screen.getByLabelText("Начало периода"), "2026-08-01");
    await user.type(screen.getByLabelText("Конец периода"), "2026-08-31");
    await user.upload(
      screen.getByLabelText("PDF акта"),
      new File(["%PDF"], "act.pdf", { type: "application/pdf" }),
    );
    expect(screen.queryByText("Акт выпущен")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));

    expect(await screen.findByText("Акт выпущен")).toBeDefined();
    const issue = calls.find((call) => call.path.endsWith("/issue"));
    expect(issue?.body).toBeInstanceOf(FormData);
    expect((issue?.body as FormData).get("file")).toBeInstanceOf(File);
    expect((issue?.body as FormData).get("idempotencyKey")).toMatch(/[0-9a-f-]{36}/);
    await waitFor(() => expect(calls).toHaveLength(3));
  });

  it("retries the exact issue attempt without creating a duplicate act", async () => {
    const createBodies: string[] = [];
    const issueBodies: FormData[] = [];
    let issueCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/billing/acts")) {
          if (typeof init?.body === "string") createBodies.push(init.body);
          return jsonResponse(201, act("draft", null));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`)) {
          if (init?.body instanceof FormData) issueBodies.push(init.body);
          issueCount += 1;
          if (issueCount === 1) return jsonResponse(503, { code: "storage_unavailable" });
          return jsonResponse(201, act("issued", readyDocument()));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({
      initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
    });

    await user.type(await screen.findByLabelText("Номер акта"), "ACT-42");
    await user.type(screen.getByLabelText("Начало периода"), "2026-08-01");
    await user.type(screen.getByLabelText("Конец периода"), "2026-08-31");
    await user.upload(
      screen.getByLabelText("PDF акта"),
      new File(["%PDF"], "act.pdf", { type: "application/pdf" }),
    );
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));
    await user.click(await screen.findByRole("button", { name: "Продолжить выпуск черновика" }));

    expect(await screen.findByText("Акт выпущен")).toBeDefined();
    expect(createBodies).toHaveLength(1);
    expect(issueBodies).toHaveLength(2);
    expect(issueBodies[0]?.get("idempotencyKey")).toBe(issueBodies[1]?.get("idempotencyKey"));
  });

  it("resets a discarded form allowance before a retained act starts in the same shell", async () => {
    const issueBodies: FormData[] = [];
    let createCount = 0;
    let issueCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/catalog/items") && method === "GET") {
          return jsonResponse(200, { items: [] });
        }
        if (url.endsWith("/api/platform/settings/demo-plan") && method === "GET") {
          return jsonResponse(200, { catalogVersionId: null });
        }
        if (url.endsWith("/api/platform/offers") && method === "GET") {
          return jsonResponse(200, []);
        }
        if (url.endsWith("/api/platform/billing/acts") && method === "POST") {
          createCount += 1;
          return jsonResponse(201, act("draft", null));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`) && method === "POST") {
          issueCount += 1;
          if (init?.body instanceof FormData) issueBodies.push(init.body);
          if (issueCount === 1) return jsonResponse(503, { code: "storage_unavailable" });
          return jsonResponse(201, act("issued", readyDocument()));
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();
    const rendered = renderSaasApp({ initialEntry: "/catalog" });

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    await user.type(screen.getByLabelText("Код позиции"), "unfinished-item");
    await user.click(screen.getByRole("link", { name: "Предложения" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Отменить изменения",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Коммерческие предложения" })).toBeDefined();

    await rendered.router.navigate(
      `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
    );
    await fillActForm(user);
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));

    expect(await screen.findByText("Черновик акта сохранён")).toBeDefined();
    expect(screen.getByText(ACT_ID)).toBeDefined();
    await user.click(screen.getByRole("link", { name: "Каталог" }));
    expect(await screen.findByText("Операция выполняется. Дождитесь её завершения.")).toBeDefined();
    expect(screen.getByText(ACT_ID)).toBeDefined();
    await user.click(screen.getByRole("link", { name: "Вернуться к заявке" }));
    expect(screen.getByText(ACT_ID)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Продолжить выпуск черновика" }));
    expect(await screen.findByText("Акт выпущен")).toBeDefined();
    expect(createCount).toBe(1);
    expect(issueBodies).toHaveLength(2);
    expect(issueBodies[0]?.get("idempotencyKey")).toBe(issueBodies[1]?.get("idempotencyKey"));

    await user.click(screen.getByRole("link", { name: "Каталог" }));
    expect(await screen.findByRole("heading", { name: "Каталог" })).toBeDefined();
  });

  it.each(["create", "issue", "reconcile"] as const)(
    "latches forbidden after act %s authority is revoked without another write",
    async (revokedAt) => {
      let createCount = 0;
      let issueCount = 0;
      let reconcileCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
          if (url.endsWith("/api/platform/billing/acts") && method === "POST") {
            createCount += 1;
            if (revokedAt === "create") return jsonResponse(403, { code: "forbidden" });
            return jsonResponse(201, act("draft", null));
          }
          if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`)) {
            issueCount += 1;
            if (revokedAt === "issue") return jsonResponse(403, { code: "forbidden" });
            return jsonResponse(503, { code: "storage_unavailable" });
          }
          if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}`) && method === "GET") {
            reconcileCount += 1;
            return jsonResponse(403, { code: "forbidden" });
          }
          throw new Error(`Unexpected request: ${method} ${url}`);
        }),
      );
      const randomUuid = vi.spyOn(crypto, "randomUUID");
      const user = userEvent.setup();
      const rendered = renderSaasApp({
        initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
      });
      const invalidate = vi.spyOn(rendered.queryClient, "invalidateQueries");

      await fillActForm(user);
      await user.click(screen.getByRole("button", { name: "Выпустить акт" }));
      if (revokedAt === "reconcile") {
        await user.click(
          await screen.findByRole("button", { name: "Сверить состояние черновика" }),
        );
      }
      const uuidCount = randomUuid.mock.calls.length;

      expect(await screen.findByRole("heading", { name: "Выпуск акта недоступен" })).toBeDefined();
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["platform", "me"] });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["platform", "billing", "requests"],
      });
      if (revokedAt !== "create") expect(screen.getByText(ACT_ID)).toBeDefined();
      expect(screen.queryByRole("button", { name: /выпуск|Сверить|Продолжить/i })).toBeNull();
      expect(createCount).toBe(1);
      expect(issueCount).toBe(revokedAt === "create" ? 0 : 1);
      expect(reconcileCount).toBe(revokedAt === "reconcile" ? 1 : 0);
      expect(randomUuid).toHaveBeenCalledTimes(uuidCount);
    },
  );

  it("makes a retained act non-discardable through downgrade, retry, and success", async () => {
    let principal: typeof PLATFORM_ADMIN_ME | typeof SUPPORT_ME = PLATFORM_ADMIN_ME;
    let createCount = 0;
    let issueCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, principal);
        if (url.endsWith("/api/platform/billing/acts") && method === "POST") {
          createCount += 1;
          return jsonResponse(201, act("draft", null));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`) && method === "POST") {
          issueCount += 1;
          if (issueCount === 1) {
            principal = SUPPORT_ME;
            return jsonResponse(403, { code: "forbidden" });
          }
          return jsonResponse(201, act("issued", readyDocument()));
        }
        if (url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}`) && method === "GET") {
          return jsonResponse(404, { code: "not_found" });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const randomUuid = vi.spyOn(crypto, "randomUUID");
    const user = userEvent.setup();
    const rendered = renderSaasApp({
      initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
    });

    await fillActForm(user);
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));

    expect(await screen.findByRole("heading", { name: "Выпуск акта недоступен" })).toBeDefined();
    expect(screen.getByText(ACT_ID)).toBeDefined();
    expect(screen.getByText("ACT-42")).toBeDefined();
    expect(screen.getByText("Черновик акта сохранён")).toBeDefined();
    expect(screen.queryByRole("button", { name: /выпуск|Сверить|Продолжить/i })).toBeNull();
    const uuidCount = randomUuid.mock.calls.length;

    await user.click(screen.getByRole("link", { name: "Вернуться к заявке" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить изменения" })).toBeNull();
    expect(await screen.findByText("Операция выполняется. Дождитесь её завершения.")).toBeDefined();
    expect(screen.getByText(ACT_ID)).toBeDefined();
    expect(screen.getByText("ACT-42")).toBeDefined();
    const unload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, unload);
    expect(unload.defaultPrevented).toBe(true);

    principal = PLATFORM_ADMIN_ME;
    await rendered.queryClient.invalidateQueries({ queryKey: ["platform", "me"] });
    await user.click(await screen.findByRole("button", { name: "Продолжить выпуск черновика" }));

    expect(await screen.findByText("Акт выпущен")).toBeDefined();
    expect(createCount).toBe(1);
    expect(issueCount).toBe(2);
    expect(randomUuid).toHaveBeenCalledTimes(uuidCount);
    await user.click(screen.getByRole("link", { name: "Вернуться к заявке" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Заявки по биллингу" })).toBeDefined();
  });

  it("reconciles a lost issue response to issued without retaining the stale failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/billing/acts") && method === "POST") {
          return jsonResponse(201, act("draft", null));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`)) {
          return jsonResponse(503, { code: "lost_response" });
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}`) && method === "GET") {
          return jsonResponse(200, act("issued", readyDocument()));
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({
      initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
    });

    await fillActForm(user);
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));
    expect(await screen.findByText(/Сеть или сервер недоступны/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Сверить состояние черновика" }));

    expect(await screen.findByText("Акт выпущен")).toBeDefined();
    expect(screen.queryByText(/Сеть или сервер недоступны/)).toBeNull();
  });

  it.each(["billing_act_service_not_completed", "billing_act_period_not_closed"])(
    "retains a terminally rejected draft for %s and resumes without another create",
    async (terminalCode) => {
      let createCount = 0;
      let issueCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
          if (url.endsWith("/api/platform/billing/acts")) {
            createCount += 1;
            return jsonResponse(201, act("draft", null));
          }
          if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`)) {
            issueCount += 1;
            if (issueCount === 1) {
              return jsonResponse(409, { code: terminalCode });
            }
            return jsonResponse(201, act("issued", readyDocument()));
          }
          throw new Error(`Unexpected request: ${url}`);
        }),
      );
      const user = userEvent.setup();
      const rendered = renderSaasApp({
        initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
      });
      const invalidate = vi.spyOn(rendered.queryClient, "invalidateQueries");

      const number = await screen.findByLabelText("Номер акта");
      await user.type(number, "ACT-42");
      await user.type(screen.getByLabelText("Начало периода"), "2026-08-01");
      await user.type(screen.getByLabelText("Конец периода"), "2026-08-31");
      await user.upload(
        screen.getByLabelText("PDF акта"),
        new File(["%PDF"], "act.pdf", { type: "application/pdf" }),
      );
      await user.click(screen.getByRole("button", { name: "Выпустить акт" }));

      expect(await screen.findByText("Черновик акта сохранён")).toBeDefined();
      expect(number).toHaveProperty("disabled", true);
      await user.type(number, "-changed");
      expect(number).toHaveProperty("value", "ACT-42");
      expect(createCount).toBe(1);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["platform", "billing", "acts"] });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["platform", "billing", "requests"],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["platform", "billing", "requests", REQUEST_ID],
      });

      await user.click(screen.getByRole("button", { name: "Продолжить выпуск черновика" }));
      expect(await screen.findByText("Акт выпущен")).toBeDefined();
      expect(createCount).toBe(1);
      expect(issueCount).toBe(2);
    },
  );
});

async function fillActForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Номер акта"), "ACT-42");
  await user.type(screen.getByLabelText("Начало периода"), "2026-08-01");
  await user.type(screen.getByLabelText("Конец периода"), "2026-08-31");
  await user.upload(
    screen.getByLabelText("PDF акта"),
    new File(["%PDF"], "act.pdf", { type: "application/pdf" }),
  );
}

function readyDocument() {
  return {
    id: "71111111-1111-4111-8111-111111111121",
    revision: 1,
    state: "ready",
    contentType: "application/pdf",
    byteSize: 4,
    sha256: "a".repeat(64),
    uploadedByPlatformUserId: USER_ID,
    readyAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function act(status: "draft" | "issued", document: unknown) {
  return {
    id: ACT_ID,
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    invoiceId: null,
    orderedServiceId: null,
    number: "ACT-42",
    status,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    createdByPlatformUserId: USER_ID,
    issuedByPlatformUserId: status === "issued" ? USER_ID : null,
    issuedAt: status === "issued" ? now : null,
    cancelledByPlatformUserId: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    document,
  };
}
