import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, PLATFORM_ADMIN_ME, renderSaasApp, SUPPORT_ME } from "./render.js";
import i18n from "../src/i18n/index.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111121";
const TENANT_ID = "21111111-1111-4111-8111-111111111121";
const OFFER_ID = "31111111-1111-4111-8111-111111111121";
const EVENT_ID = "41111111-1111-4111-8111-111111111121";
const now = "2026-08-28T08:00:00.000Z";

const request = {
  id: REQUEST_ID,
  tenantId: TENANT_ID,
  number: "BR-2026-0042",
  type: "renewal",
  status: "under_review",
  description: "Продлить подписку",
  desiredAt: null,
  context: null,
  responsibleSide: "markiro",
  createdAt: now,
  updatedAt: now,
};

const event = {
  id: EVENT_ID,
  tenantId: TENANT_ID,
  requestId: REQUEST_ID,
  kind: "offer_accepted",
  fromStatus: null,
  toStatus: null,
  actorKind: "tenant_user",
  actorUserId: "tenant-user",
  actorPlatformUserId: null,
  message: null,
  metadata: { offerId: OFFER_ID },
  createdAt: now,
};

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

describe("platform billing request operations", () => {
  it("keeps a revoked reader on a non-actionable forbidden surface", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, SUPPORT_ME);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    renderSaasApp({ initialEntry: "/billing-requests" });

    expect(
      await screen.findByRole("heading", { name: "Доступ к заявкам ограничен" }),
    ).toBeDefined();
    expect(within(screen.getByRole("main")).queryByRole("button")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serializes exact filters and renders only server-allowed transitions", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        paths.push(url);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.includes("/api/platform/billing/requests?")) {
          return jsonResponse(200, {
            items: [{ ...request, allowedTransitions: ["offer_prepared"], latestEvent: event }],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp({
      initialEntry: `/billing-requests?tenantId=${TENANT_ID}&status=under_review&type=renewal`,
    });

    expect(await screen.findByText("BR-2026-0042")).toBeDefined();
    expect(paths).toContain(
      `/api/platform/billing/requests?tenantId=${TENANT_ID}&status=under_review&type=renewal`,
    );
  });

  it("renders the operator request registry in English", async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/billing/requests")) {
          return jsonResponse(200, { items: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp({ initialEntry: "/billing-requests" });

    expect(await screen.findByRole("heading", { name: "Billing requests" })).toBeDefined();
    expect(screen.getByRole("form", { name: "Request filters" })).toBeDefined();
  });

  it("uses authoritative offer actionability and posts a locked idempotent comment", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    let releaseComment: (() => void) | undefined;
    const pendingComment = new Promise<void>((resolve) => {
      releaseComment = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ path: url, method, ...(body === undefined ? {} : { body }) });
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}`) && method === "GET") {
          return jsonResponse(200, {
            ...request,
            allowedTransitions: ["clarification_required", "offer_prepared"],
            offerAction: {
              offerId: OFFER_ID,
              currentOfferId: OFFER_ID,
              latestDecision: "accepted",
              canRevise: false,
              canCreateInvoice: true,
            },
            events: [event],
            links: [],
          });
        }
        if (url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}/comments`)) {
          await pendingComment;
          return jsonResponse(201, { ...event, kind: "platform_comment", message: body.message });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/billing-requests/${REQUEST_ID}` });

    expect(await screen.findByRole("button", { name: "Нужно уточнение" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Выполнена" })).toBeNull();
    expect(screen.getByRole("link", { name: "Создать счёт" }).getAttribute("href")).toBe(
      "/invoices/new",
    );
    expect(screen.getByRole("link", { name: "Создать предложение" }).getAttribute("href")).toBe(
      `/billing-requests/${REQUEST_ID}/offers/new`,
    );
    expect(screen.queryByRole("button", { name: "Создать новую версию" })).toBeNull();

    await user.type(screen.getByLabelText("Комментарий Маркиро"), "Нужна спецификация");
    const submit = screen.getByRole("button", { name: "Добавить комментарий" });
    await user.click(submit);
    expect(submit.hasAttribute("disabled")).toBe(true);
    await user.click(submit);
    expect(calls.filter((call) => call.path.endsWith("/comments"))).toHaveLength(1);
    const commentBody = calls.find((call) => call.path.endsWith("/comments"))?.body;
    expect(commentBody).toMatchObject({ message: "Нужна спецификация" });
    expect(commentBody).toHaveProperty("idempotencyKey");
    releaseComment?.();
    await waitFor(() => {
      const input = screen.getByLabelText("Комментарий Маркиро");
      expect(input).toBeInstanceOf(HTMLInputElement);
      if (input instanceof HTMLInputElement) expect(input.value).toBe("");
    });
  });

  it("retries an immutable comment attempt and invalidates only request queries", async () => {
    const commentBodies: string[] = [];
    let commentCount = 0;
    const detailBody = {
      ...request,
      allowedTransitions: [],
      offerAction: null,
      events: [event],
      links: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}`) && method === "GET") {
          return jsonResponse(200, detailBody);
        }
        if (url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}/comments`)) {
          if (typeof init?.body === "string") commentBodies.push(init.body);
          commentCount += 1;
          if (commentCount === 1) return jsonResponse(503, { code: "temporary" });
          return jsonResponse(201, { ...event, kind: "platform_comment", message: "Exact" });
        }
        if (url.endsWith("/api/platform/billing/requests")) {
          return jsonResponse(200, { items: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    const rendered = renderSaasApp({ initialEntry: `/billing-requests/${REQUEST_ID}` });
    const invalidate = vi.spyOn(rendered.queryClient, "invalidateQueries");

    await user.type(await screen.findByLabelText("Комментарий Маркиро"), "Exact");
    await user.click(screen.getByRole("button", { name: "Добавить комментарий" }));
    await user.click(await screen.findByRole("button", { name: "Повторить тот же запрос" }));

    await waitFor(() => expect(commentBodies).toHaveLength(2));
    expect(commentBodies[0]).toBe(commentBodies[1]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["platform", "billing", "requests"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["platform", "billing", "requests", REQUEST_ID],
    });
  });

  it("freezes every alternate mutation while an ambiguous attempt is retained", async () => {
    const detailBody = {
      ...request,
      allowedTransitions: ["in_progress"],
      offerAction: {
        offerId: OFFER_ID,
        currentOfferId: OFFER_ID,
        latestDecision: "changes_requested",
        canRevise: true,
        canCreateInvoice: false,
      },
      events: [event],
      links: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}`) && method === "GET") {
          return jsonResponse(200, detailBody);
        }
        if (url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}/comments`)) {
          return jsonResponse(503, { code: "temporary" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/billing-requests/${REQUEST_ID}` });

    await user.type(await screen.findByLabelText("Комментарий Маркиро"), "Frozen");
    await user.click(screen.getByRole("button", { name: "Добавить комментарий" }));
    expect(await screen.findByRole("button", { name: "Повторить тот же запрос" })).toBeDefined();

    expect(screen.getByLabelText("Комментарий Маркиро")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "В работе" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Создать новую версию" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("ID объекта")).toHaveProperty("disabled", true);
    expect(screen.queryByRole("link", { name: "Создать предложение" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Выпустить акт" })).toBeNull();
  });
});
