import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfferWorkspace } from "@markiro/platform-contracts";
import {
  ACCOUNTANT_ME,
  TENANT_ID,
  TENANT_LIST_ITEM,
  jsonResponse,
  renderSaasApp,
} from "./render.js";

const ID = "91111111-1111-4111-8111-111111111111";
const NOW = "2026-09-10T10:00:00.000Z";
const fingerprint = "a".repeat(64);
function workspace(): OfferWorkspace {
  return {
    offer: {
      id: ID,
      tenantId: TENANT_ID,
      familyId: ID,
      revision: 2,
      previousRevisionId: null,
      number: null,
      status: "draft",
      total: "12500.50",
      expiresAt: null,
      termsMarkdown: "Поставка в течение 14 дней",
      publishedAt: null,
      publishedByPlatformUserId: null,
      paidAt: null,
      createdByPlatformUserId: "platform-accountant",
      createdAt: NOW,
      updatedAt: NOW,
      lines: [
        {
          id: "a1111111-1111-4111-8111-111111111111",
          tenantId: TENANT_ID,
          offerId: ID,
          position: 1,
          kind: "service",
          catalogVersionId: null,
          nameRu: "Настройка линии",
          nameEn: "Line setup",
          descriptionRu: null,
          descriptionEn: null,
          quantity: 2,
          unit: "шт",
          catalogUnitPrice: null,
          agreedUnitPrice: "6250.25",
          vatRate: null,
          vatIncluded: false,
          priceOverrideReason: null,
          lineTotal: "12500.50",
          activationPolicy: null,
          createdAt: NOW,
        },
      ],
    },
    tenant: { id: TENANT_ID, name: "Молочная мастерская", slug: "dairy-workshop" },
    parties: { seller: null, buyer: null, sellerBankAccount: null, buyerBankAccount: null },
    revisions: [],
    decision: null,
    documents: [],
    request: null,
    actions: {
      publish: true,
      cancel: false,
      revise: false,
      pay: false,
      createInvoice: false,
      addSignedVariant: false,
    },
  };
}
function install(
  data = workspace(),
  {
    conflict = false,
    failPayment = false,
    previewFailsAfterFirst = false,
    canWrite = true,
    failRevise = false,
    workspaceStatuses = [200],
  } = {},
) {
  const calls: Array<{ path: string; method: string; body: unknown; key: string | null }> = [];
  let previews = 0;
  let workspaceReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      const method = init.method ?? "GET";
      calls.push({
        path,
        method,
        body: init.body ? JSON.parse(String(init.body)) : null,
        key: new Headers(init.headers).get("Idempotency-Key"),
      });
      if (path.endsWith("/me"))
        return jsonResponse(
          200,
          canWrite
            ? ACCOUNTANT_ME
            : {
                ...ACCOUNTANT_ME,
                capabilities: ACCOUNTANT_ME.capabilities.filter(
                  (value) => value !== "billing.write",
                ),
              },
        );
      if (path.includes("/tenants?"))
        return jsonResponse(200, { items: [TENANT_LIST_ITEM], page: 1, limit: 100, total: 1 });
      if (path.includes("/offers/registry?")) {
        const { lines, ...offer } = data.offer;
        return jsonResponse(200, {
          items: [
            {
              ...offer,
              tenantName: data.tenant.name,
              tenantSlug: data.tenant.slug,
              buyerLegalName: "ООО «Молочная мастерская»",
              buyerTaxId: "7701234567",
              lineSummary: ["Настройка линии"],
              lineCount: lines.length,
            },
          ],
          page: 1,
          limit: 25,
          total: 68,
        });
      }
      if (path.endsWith("/offers")) return jsonResponse(200, [data.offer]);
      if (path.endsWith("/workspace")) {
        const status = workspaceStatuses[workspaceReads++] ?? 200;
        return jsonResponse(status, status === 200 ? data : { code: "workspace_unavailable" });
      }
      if (path.endsWith("/preview")) {
        previews++;
        if (previews > 1 && previewFailsAfterFirst)
          return jsonResponse(409, { code: "billing_profile_unconfirmed" });
        return jsonResponse(200, {
          html: "<html><body>Черновик. Не выпущен. Настройка линии</body></html>",
          fingerprint: previews === 1 ? fingerprint : "b".repeat(64),
        });
      }
      if (path.endsWith("/publish")) {
        if (conflict) return jsonResponse(409, { code: "offer_preview_changed" });
        data.offer = {
          ...data.offer,
          status: "published",
          number: "КП-2026-0042",
          publishedAt: NOW,
          publishedByPlatformUserId: "platform-accountant",
          paidAt: null,
        };
        data.actions.publish = false;
        return jsonResponse(200, { ...data.offer, documents: { revision: 2, documents: [] } });
      }
      if (path.endsWith("/payment")) {
        if (failPayment) return jsonResponse(503, { code: "payment_unavailable" });
        return jsonResponse(200, { paymentId: ID, fulfilments: [] });
      }
      if (path.endsWith("/revise")) {
        if (failRevise) return jsonResponse(503, { code: "offer_unavailable" });
        return jsonResponse(200, data.offer);
      }
      if (path.endsWith("/documents") && method === "POST")
        return jsonResponse(200, { revision: 2, documents: [] });
      if (path.endsWith("/documents")) return jsonResponse(200, data.documents);
      throw new Error(`Unexpected ${method} ${path}`);
    }),
  );
  return calls;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("offers workspace", () => {
  it("sends the next Moscow midnight for the inclusive end date across a year rollover", async () => {
    const calls = install(workspace());
    const user = userEvent.setup();
    const app = renderSaasApp({
      initialEntry: "/offers?createdTo=2026-12-30T23%3A59%3A59.999%2B03%3A00",
    });
    const endDate = await screen.findByRole("button", { name: "Создано по" });
    expect(endDate.textContent).toBe("30 декабря 2026");
    await user.click(endDate);
    await user.click(screen.getByRole("button", { name: /31 декабря 2026/ }));
    await waitFor(() =>
      expect(
        calls.filter((call) => call.path.includes("/offers/registry?")).at(-1)?.path,
      ).toContain("createdTo=2027-01-01T00%3A00%3A00%2B03%3A00"),
    );
    expect(endDate.textContent).toBe("31 декабря 2026");
    app.unmount();
    renderSaasApp({ initialEntry: "/offers?createdTo=2027-01-01T00%3A00%3A00%2B03%3A00" });
    const restored = await screen.findByRole("button", { name: "Создано по" });
    expect(restored.textContent).toBe("31 декабря 2026");
    await user.click(restored);
    await user.click(screen.getByRole("button", { name: /31 декабря 2026/ }));
    expect(restored.textContent).toBe("31 декабря 2026");
  });

  it.each(["pay", "revise"] as const)(
    "preserves the %s attempt across failed workspace refresh and recovery",
    async (action) => {
      const data = workspace();
      data.actions[action] = true;
      const calls = install(data, {
        failPayment: true,
        failRevise: true,
        workspaceStatuses: [200, 503, 200],
      });
      const user = userEvent.setup();
      const app = renderSaasApp({ initialEntry: `/offers/${ID}` });
      const openLabel = action === "pay" ? "Зарегистрировать оплату" : "Создать следующую версию";
      const confirmLabel = action === "pay" ? "Подтвердить оплату" : "Создать версию";
      await user.click(await screen.findByRole("button", { name: openLabel }));
      if (action === "pay")
        await user.type(screen.getByRole("textbox", { name: "Банковский референс" }), "ПП-718");
      await user.click(screen.getByRole("button", { name: confirmLabel }));
      await screen.findByText("Не удалось выполнить действие. Попробуйте ещё раз.");
      await user.click(screen.getByRole("button", { name: "Закрыть" }));
      await act(async () => {
        await app.queryClient.invalidateQueries({
          queryKey: ["platform", "offers", ID, "workspace"],
        });
      });
      await waitFor(() =>
        expect(app.queryClient.getQueryState(["platform", "offers", ID, "workspace"])?.status).toBe(
          "error",
        ),
      );
      expect(screen.getByText("Настройка линии")).toBeDefined();
      await user.click(screen.getByRole("button", { name: "Повторить" }));
      await waitFor(() =>
        expect(app.queryClient.getQueryState(["platform", "offers", ID, "workspace"])?.status).toBe(
          "success",
        ),
      );
      await user.click(screen.getByRole("button", { name: openLabel }));
      if (action === "pay") expect(screen.getByDisplayValue("ПП-718")).toBeDefined();
      await user.click(screen.getByRole("button", { name: confirmLabel }));
      const suffix = action === "pay" ? "/payment" : "/revise";
      await waitFor(() => expect(calls.filter((c) => c.path.endsWith(suffix))).toHaveLength(2));
      const attempts = calls.filter((c) => c.path.endsWith(suffix));
      expect(attempts[1]?.body).toEqual(attempts[0]?.body);
      expect(attempts[1]?.key).toBe(attempts[0]?.key);
    },
  );
  it("keeps the displayed preview paired with its fingerprint through refresh failure and recovery", async () => {
    const calls = install(workspace(), { workspaceStatuses: [200, 503, 200] });
    const user = userEvent.setup();
    const app = renderSaasApp({ initialEntry: `/offers/${ID}` });
    await user.click(await screen.findByRole("button", { name: "Предпросмотр" }));
    const frame = await screen.findByTitle("Предпросмотр предложения");
    await act(async () => {
      await app.queryClient.invalidateQueries({
        queryKey: ["platform", "offers", ID, "workspace"],
      });
    });
    await waitFor(() =>
      expect(app.queryClient.getQueryState(["platform", "offers", ID, "workspace"])?.status).toBe(
        "error",
      ),
    );
    expect(screen.getByTitle("Предпросмотр предложения")).toBe(frame);
    await user.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(app.queryClient.getQueryState(["platform", "offers", ID, "workspace"])?.status).toBe(
        "success",
      ),
    );
    expect(screen.getByTitle("Предпросмотр предложения")).toBe(frame);
    await user.click(screen.getByRole("button", { name: "Выпустить предложение" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Подтвердить выпуск" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/publish"))?.body).toEqual({
        previewFingerprint: fingerprint,
      }),
    );
  });
  it("invalidates the old fingerprint when a refreshed preview fails", async () => {
    install(workspace(), { previewFailsAfterFirst: true });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/offers/${ID}` });
    await user.click(await screen.findByRole("button", { name: "Предпросмотр" }));
    await screen.findByTitle("Предпросмотр предложения");
    await user.click(screen.getByRole("button", { name: "Обновить предпросмотр" }));
    await screen.findByText("Подтвердите реквизиты сторон перед выпуском.");
    expect(
      screen.getByRole("button", { name: "Выпустить предложение" }).hasAttribute("disabled"),
    ).toBe(true);
  });
  it("uses one revision key across an uncertain retry", async () => {
    const data = workspace();
    data.actions.revise = true;
    const calls = install(data, { failRevise: true });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/offers/${ID}` });
    await user.click(await screen.findByRole("button", { name: "Создать следующую версию" }));
    await user.click(screen.getByRole("button", { name: "Создать версию" }));
    await screen.findByText("Не удалось выполнить действие. Попробуйте ещё раз.");
    await user.click(screen.getByRole("button", { name: "Создать версию" }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/revise"))).toHaveLength(2));
    const attempts = calls.filter((c) => c.path.endsWith("/revise"));
    expect(attempts[0]?.body).toHaveProperty("idempotencyKey");
    expect(attempts[1]?.body).toEqual(attempts[0]?.body);
  });
  it("renders historical party facts and hides actions disallowed by the workspace", async () => {
    const data = workspace();
    data.parties.buyer = {
      kind: "legal_entity",
      fullName: "ООО «Исторический покупатель»",
      displayName: "Исторический покупатель",
      inn: "7701234567",
      kpp: null,
      ogrn: null,
      ogrnip: null,
      legalAddressRaw: "Москва, улица Тестовая, 8",
      legalAddress: null,
      actualSameAsLegal: true,
      actualAddressRaw: null,
      actualAddress: null,
      postalSameAsLegal: true,
      postalAddressRaw: null,
      postalAddress: null,
      contact: null,
      revision: 1,
      confirmedAt: NOW,
    };
    data.actions.publish = false;
    const calls = install(data);
    renderSaasApp({ initialEntry: `/offers/${ID}` });
    expect(await screen.findByText("ООО «Исторический покупатель»")).toBeDefined();
    expect(screen.getByText("Москва, улица Тестовая, 8")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Выпустить предложение" })).toBeNull();
    expect(calls.some((c) => c.path.includes("/billing-profile"))).toBe(false);
  });
  it("keeps clean HTML available when PDF failed and confirms a separate signed variant", async () => {
    const data = workspace();
    data.offer = {
      ...data.offer,
      status: "published",
      number: "КП-2026-0042",
      publishedAt: NOW,
      publishedByPlatformUserId: "platform-accountant",
      paidAt: null,
    };
    data.actions = { ...data.actions, publish: false, addSignedVariant: true };
    data.documents = [
      {
        id: ID,
        revision: 2,
        format: "html",
        printVariant: "clean",
        status: "ready",
        contentType: "text/html",
        byteSize: 1200,
        sha256: fingerprint,
        errorCode: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "92111111-1111-4111-8111-111111111111",
        revision: 2,
        format: "pdf",
        printVariant: "clean",
        status: "failed",
        contentType: null,
        byteSize: null,
        sha256: null,
        errorCode: "render_failed",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const calls = install(data);
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/offers/${ID}` });
    expect(await screen.findByRole("button", { name: "Открыть HTML" })).toBeDefined();
    expect(screen.getByText("Не удалось сформировать")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Добавить вариант с подписью и печатью" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/не электронная подпись/)).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Создать вариант" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/documents") && c.method === "POST")?.body).toEqual(
        { printVariant: "signed" },
      ),
    );
    expect(screen.getByRole("button", { name: "Открыть HTML" })).toBeDefined();
  });
  it("shows server names, saved line summary, localized money and server count without row detail requests", async () => {
    const calls = install();
    renderSaasApp({ initialEntry: "/offers" });
    expect(await screen.findByText("Молочная мастерская")).toBeDefined();
    expect(screen.getByText("Настройка линии")).toBeDefined();
    expect(screen.getByText(/12\s500,50/)).toBeDefined();
    expect(screen.queryByText(TENANT_ID)).toBeNull();
    expect(screen.getByText(/68/)).toBeDefined();
    expect(calls.some((c) => /\/offers\/[^/?]+\/(workspace|preview)/.test(c.path))).toBe(false);
  });
  it("debounces server search and retains registry URL after opening and returning", async () => {
    install();
    const user = userEvent.setup();
    const app = renderSaasApp({ initialEntry: "/offers?status=draft&page=2" });
    const search = await screen.findByRole("textbox", { name: "Поиск предложений" });
    await user.type(search, "Молочная");
    await waitFor(() => expect(app.router.state.location.search).toContain("search="));
    expect(app.router.state.location.search).not.toContain("page=2");
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
    const offerLink = screen.getByRole("link", { name: "Черновик" });
    await user.click(offerLink);
    await user.click(await screen.findByRole("link", { name: "К реестру предложений" }));
    expect(app.router.state.location.search).toContain("status=draft");
    expect(app.router.state.location.search).toContain("search=");
  });
  it("loads a sandboxed saved preview without publishing then sends its fingerprint on confirmation", async () => {
    const calls = install();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/offers/${ID}` });
    expect(await screen.findByText("Настройка линии")).toBeDefined();
    expect(screen.getByText("Поставка в течение 14 дней")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Предпросмотр" }));
    const frame = await screen.findByTitle("Предпросмотр предложения");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("Черновик. Не выпущен");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Выпустить предложение" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Подтвердить выпуск" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/publish"))?.body).toEqual({
        previewFingerprint: fingerprint,
      }),
    );
    expect(await screen.findByRole("heading", { name: "КП-2026-0042" })).toBeDefined();
  });
  it("requires a fresh preview after changed inputs before another publish", async () => {
    const calls = install(workspace(), { conflict: true });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/offers/${ID}` });
    await user.click(await screen.findByRole("button", { name: "Предпросмотр" }));
    await screen.findByTitle("Предпросмотр предложения");
    await user.click(screen.getByRole("button", { name: "Выпустить предложение" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Подтвердить выпуск" }),
    );
    expect(await screen.findByText(/Данные изменились/)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Выпустить предложение" }).hasAttribute("disabled"),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Обновить предпросмотр" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Выпустить предложение" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(calls.filter((c) => c.path.endsWith("/preview"))).toHaveLength(2);
  });
  it("keeps the exact payment payload and key after an ambiguous failure", async () => {
    const data = workspace();
    data.offer = {
      ...data.offer,
      status: "published",
      number: "КП-2026-0042",
      publishedAt: NOW,
      publishedByPlatformUserId: "platform-accountant",
      paidAt: null,
    };
    data.actions = { ...data.actions, publish: false, pay: true };
    const calls = install(data, { failPayment: true });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/offers/${ID}` });
    await user.click(await screen.findByRole("button", { name: "Зарегистрировать оплату" }));
    await user.type(screen.getByRole("textbox", { name: "Банковский референс" }), "ПП-718");
    await user.click(screen.getByRole("button", { name: "Подтвердить оплату" }));
    await screen.findByText(/^Повторить с теми же данными/);
    await user.click(screen.getByRole("button", { name: "Подтвердить оплату" }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/payment"))).toHaveLength(2));
    const attempts = calls.filter((c) => c.path.endsWith("/payment"));
    expect(attempts[1]?.body).toEqual({
      amount: "12500.50",
      currency: "RUB",
      bankReference: "ПП-718",
    });
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
  });
});
