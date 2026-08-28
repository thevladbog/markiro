import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  ADDON,
  PUBLISHED_PLAN,
  SERVICE,
  SUPPORT_ME,
  TENANT_DETAIL,
  TENANT_ID,
  TENANT_LIST_ITEM,
  jsonResponse,
  renderSaasApp,
} from "./render.js";

const OFFER_ID = "91111111-1111-4111-8111-111111111111";
const REQUEST_ID = "81111111-1111-4111-8111-111111111111";
const OFFER_CREATED_AT = "2026-08-21T10:00:00.000Z";

function offerRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: OFFER_ID,
    tenantId: TENANT_ID,
    familyId: "92111111-1111-4111-8111-111111111111",
    revision: 1,
    previousRevisionId: null,
    number: null,
    status: "draft",
    total: "15000.00",
    expiresAt: null,
    termsMarkdown: null,
    publishedAt: null,
    publishedByPlatformUserId: null,
    paidAt: null,
    createdByPlatformUserId: "platform-accountant",
    createdAt: OFFER_CREATED_AT,
    updatedAt: OFFER_CREATED_AT,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installOfferEditorApi({
  createStatus = 201,
  retireOnRefresh = false,
  failCatalogRefresh = false,
  tenantItems = [TENANT_LIST_ITEM],
  me = ACCOUNTANT_ME,
  offers = [],
  requestDetail = null,
  requestOfferStatuses = [201],
  requestOfferGate,
}: {
  createStatus?: number;
  retireOnRefresh?: boolean;
  failCatalogRefresh?: boolean;
  tenantItems?: Array<Record<string, unknown>>;
  me?: Record<string, unknown>;
  offers?: Array<Record<string, unknown>>;
  requestDetail?: Record<string, unknown> | null;
  requestOfferStatuses?: number[];
  requestOfferGate?: Promise<void>;
} = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let catalogFetches = 0;
  let requestOfferAttempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
      if (url.endsWith("/api/platform/billing/operator/accounts") && method === "GET") {
        return jsonResponse(200, []);
      }
      if (url.endsWith("/api/platform/offers") && method === "GET") {
        return jsonResponse(200, offers);
      }
      if (url.includes("/api/platform/tenants?") && method === "GET") {
        return jsonResponse(200, {
          items: tenantItems,
          page: 1,
          limit: 100,
          total: tenantItems.length,
        });
      }
      if (url.endsWith(`/api/platform/tenants/${TENANT_ID}`) && method === "GET") {
        return jsonResponse(200, TENANT_DETAIL);
      }
      if (
        url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}`) &&
        method === "GET" &&
        requestDetail
      ) {
        return jsonResponse(200, requestDetail);
      }
      if (url.endsWith("/api/platform/catalog/items") && method === "GET") {
        catalogFetches += 1;
        if (failCatalogRefresh && catalogFetches > 1) {
          return jsonResponse(503, { code: "catalog_unavailable" });
        }
        return jsonResponse(200, {
          items: [
            retireOnRefresh && catalogFetches > 1
              ? { ...PUBLISHED_PLAN, status: "retired" }
              : PUBLISHED_PLAN,
            ADDON,
            SERVICE,
          ],
        });
      }
      if (url.endsWith("/api/platform/offers") && method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          lines: Array<{
            kind: "plan" | "addon" | "service";
            catalogVersionId: string;
            nameRu: string;
            nameEn: string;
            quantity: number;
            unit: string;
            agreedUnitPrice: string;
            vatRateBps: number | null;
            vatIncluded: boolean;
            activationPolicy: "immediately" | "after_current" | null;
          }>;
        };
        calls.push({ method, path: url, body });
        if (createStatus === 409) return jsonResponse(409, { code: "offer_conflict" });
        return jsonResponse(
          201,
          offerRecord({
            total: "67500.00",
            lines: body.lines.map(({ vatRateBps, ...line }, index) => ({
              ...line,
              id: `a1111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
              tenantId: TENANT_ID,
              offerId: OFFER_ID,
              position: index + 1,
              descriptionRu: null,
              descriptionEn: null,
              catalogUnitPrice: line.agreedUnitPrice,
              vatRate: vatRateBps === null ? null : `${vatRateBps / 100}.00`,
              priceOverrideReason: null,
              activationPolicy: line.kind === "plan" ? line.activationPolicy : null,
              lineTotal: line.agreedUnitPrice,
              createdAt: OFFER_CREATED_AT,
            })),
          }),
        );
      }
      if (url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}/offer`) && method === "POST") {
        const body = JSON.parse(String(init.body)) as { lines: Array<Record<string, unknown>> };
        calls.push({ method, path: url, body });
        const status = requestOfferStatuses[requestOfferAttempts] ?? 201;
        requestOfferAttempts += 1;
        if (status === 403) return jsonResponse(403, { code: "forbidden" });
        if (status >= 500) return jsonResponse(status, { code: "offer_create_unavailable" });
        if (requestOfferAttempts > 1 && requestOfferGate) await requestOfferGate;
        return jsonResponse(201, {
          requestId: REQUEST_ID,
          tenantId: TENANT_ID,
          offerId: OFFER_ID,
          link: {
            id: "b1111111-1111-4111-8111-111111111111",
            tenantId: TENANT_ID,
            requestId: REQUEST_ID,
            type: "offer",
            targetId: OFFER_ID,
            createdAt: OFFER_CREATED_AT,
          },
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  return { calls: () => structuredClone(calls) };
}

async function addPosition(
  user: ReturnType<typeof userEvent.setup>,
  search: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: "Добавить позицию" }));
  await user.type(screen.getByRole("searchbox"), search);
  await user.click(screen.getByRole("option", { name: new RegExp(`^${option}`) }));
}

describe("offer editor route", () => {
  it("creates a request-bound offer atomically with a locked server tenant", async () => {
    const api = installOfferEditorApi({ requestDetail: billingRequestDetail() });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/billing-requests/${REQUEST_ID}/offers/new` });

    expect(await screen.findByText(`Тенант заявки · ${TENANT_ID}`)).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Тенант" })).toBeNull();
    await addPosition(user, "Базовый", "Базовый · plan-basic · v1");
    await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));

    const call = api.calls()[0];
    expect(call?.path).toBe(`/api/platform/billing/requests/${REQUEST_ID}/offer`);
    expect(call?.body).not.toHaveProperty("tenantId");
    expect(call?.body).toHaveProperty("idempotencyKey");
    expect(await screen.findByRole("heading", { name: "Коммерческие предложения" })).toBeDefined();
  });

  it("latches a forbidden surface when request-bound offer authority is revoked on mutation", async () => {
    const api = installOfferEditorApi({
      requestDetail: billingRequestDetail(),
      requestOfferStatuses: [403],
    });
    const user = userEvent.setup();
    const rendered = renderSaasApp({
      initialEntry: `/billing-requests/${REQUEST_ID}/offers/new`,
    });
    const invalidate = vi.spyOn(rendered.queryClient, "invalidateQueries");

    await screen.findByText(`Тенант заявки · ${TENANT_ID}`);
    await addPosition(user, "Базовый", "Базовый · plan-basic · v1");
    await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));

    expect(
      await screen.findByRole("heading", { name: "Доступ к заявкам ограничен" }),
    ).toBeDefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["platform", "me"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["platform", "billing", "requests"],
    });
    expect(screen.queryByRole("button", { name: "Создать черновик предложения" })).toBeNull();
    expect(api.calls()).toHaveLength(1);
  });

  it("freezes an ambiguous request offer and retries the exact payload and key once", async () => {
    let releaseRetry: (() => void) | undefined;
    const requestOfferGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const api = installOfferEditorApi({
      requestDetail: billingRequestDetail(),
      requestOfferStatuses: [503, 201],
      requestOfferGate,
    });
    const randomUuid = vi.spyOn(crypto, "randomUUID");
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/billing-requests/${REQUEST_ID}/offers/new` });

    await screen.findByText(`Тенант заявки · ${TENANT_ID}`);
    await addPosition(user, "Базовый", "Базовый · plan-basic · v1");
    const price = screen.getByDisplayValue("15000.00");
    await user.clear(price);
    await user.type(price, "17000.00");
    await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));

    const retry = await screen.findByRole("button", { name: "Повторить точно эту попытку" });
    expect(screen.queryByDisplayValue("17000.00")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Добавить позицию" })).toBeNull();
    await user.type(price, "19000.00");
    const uuidCount = randomUuid.mock.calls.length;
    await user.click(retry);
    await waitFor(() => expect(api.calls()).toHaveLength(2));
    await user.click(retry);

    expect(api.calls()).toHaveLength(2);
    expect(api.calls()[1]?.body).toEqual(api.calls()[0]?.body);
    expect(api.calls()[0]?.body).toMatchObject({
      idempotencyKey: expect.any(String),
      lines: [expect.objectContaining({ agreedUnitPrice: "17000.00" })],
    });
    expect(randomUuid).toHaveBeenCalledTimes(uuidCount);
    releaseRetry?.();
    expect(await screen.findByRole("heading", { name: "Коммерческие предложения" })).toBeDefined();
  });
  it("renders an empty offer register without a stale detail loader", async () => {
    installOfferEditorApi();

    renderSaasApp({ initialEntry: "/offers" });

    expect(await screen.findByText("Предложений пока нет")).toBeDefined();
    expect(screen.queryByText("Загружаем раздел")).toBeNull();
  });

  it("rejects a malformed offer success body at the browser boundary", async () => {
    installOfferEditorApi({
      offers: [
        {
          id: "91111111-1111-4111-8111-111111111111",
          tenantId: TENANT_ID,
          status: "draft",
          total: "15000.00",
        },
      ],
    });

    renderSaasApp({ initialEntry: "/offers" });

    expect(await screen.findByText("Не удалось загрузить предложения")).toBeDefined();
    expect(screen.queryByText(TENANT_ID)).toBeNull();
  });

  it("keeps an expired offer visible in the register", async () => {
    installOfferEditorApi({
      offers: [
        offerRecord({
          status: "expired",
          number: "KP-2026-000001",
          publishedAt: OFFER_CREATED_AT,
          publishedByPlatformUserId: "platform-accountant",
        }),
      ],
    });

    renderSaasApp({ initialEntry: "/offers" });

    expect(await screen.findByText(TENANT_ID)).toBeDefined();
    expect(screen.getByText("Коммерческие условия до выставления счёта.")).toBeDefined();
    expect(screen.getByText("Воронка продаж")).toBeDefined();
    expect(screen.getByRole("region", { name: "Реестр предложений" })).toBeDefined();
    expect(screen.getByText("expired")).toBeDefined();
    expect(screen.queryByText("Не удалось загрузить предложения")).toBeNull();
  });

  it("redirects a principal without billing write access without loading an editable form", async () => {
    installOfferEditorApi({ me: SUPPORT_ME });
    renderSaasApp({ initialEntry: "/offers/new" });

    expect(await screen.findByRole("heading", { name: "Коммерческие предложения" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Создать черновик предложения" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Тенант" })).toBeNull();
  });

  it("opens from offers and maps each activation policy at the API boundary", async () => {
    const api = installOfferEditorApi();
    const user = userEvent.setup();
    const offers = renderSaasApp({ initialEntry: "/offers" });

    const createLink = await screen.findByRole("link", { name: "Создать предложение" });
    expect(createLink.getAttribute("href")).toBe("/offers/new");
    offers.unmount();

    renderSaasApp({ initialEntry: `/offers/new?tenantId=${TENANT_ID}` });
    await screen.findByRole("combobox", { name: "Тенант" });
    await addPosition(user, "Базовый", "Базовый · plan-basic · v1");
    await addPosition(user, "Дополнительная", "Дополнительная станция · addon-station · v1");
    await addPosition(user, "Внедрение", "Внедрение · service-implementation · v1");
    await user.type(screen.getByLabelText("Срок действия"), "2026-09-15");
    await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));

    expect(api.calls()).toEqual([
      {
        method: "POST",
        path: "/api/platform/offers",
        body: {
          tenantId: TENANT_ID,
          expiresAt: "2026-09-15",
          lines: [
            {
              kind: "plan",
              catalogVersionId: PUBLISHED_PLAN.id,
              nameRu: "Базовый",
              nameEn: "Basic",
              descriptionRu: "Для одной площадки",
              descriptionEn: "For one site",
              quantity: 1,
              unit: "month",
              agreedUnitPrice: "15000.00",
              priceOverrideReason: null,
              vatRateBps: 2000,
              vatIncluded: true,
              activationPolicy: "immediately",
            },
            {
              kind: "addon",
              catalogVersionId: ADDON.id,
              nameRu: "Дополнительная станция",
              nameEn: "Extra station",
              descriptionRu: null,
              descriptionEn: null,
              quantity: 1,
              unit: "station",
              agreedUnitPrice: "2500.00",
              priceOverrideReason: null,
              vatRateBps: 2000,
              vatIncluded: true,
              activationPolicy: "immediately",
            },
            {
              kind: "service",
              catalogVersionId: SERVICE.id,
              nameRu: "Внедрение",
              nameEn: "Implementation",
              descriptionRu: null,
              descriptionEn: null,
              quantity: 1,
              unit: "project",
              agreedUnitPrice: "50000.00",
              priceOverrideReason: null,
              vatRateBps: 2000,
              vatIncluded: true,
              activationPolicy: null,
            },
          ],
        },
      },
    ]);
    expect((await screen.findByRole("alert")).textContent).toContain("Предложение создано");
  });

  it("refreshes the catalog and keeps the offer draft when a version was retired", async () => {
    const api = installOfferEditorApi({ retireOnRefresh: true });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/offers/new?tenantId=${TENANT_ID}` });

    await screen.findByRole("combobox", { name: "Тенант" });
    await addPosition(user, "Базовый", "Базовый · plan-basic · v1");
    await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "одна из выбранных версий больше не опубликована",
    );
    expect(api.calls()).toEqual([]);
    expect(screen.getByRole("combobox", { name: "Тенант" }).textContent).toContain("Первый завод");
    expect(screen.getByDisplayValue("15000.00")).toBeDefined();
  });

  it("fails closed without posting when the submit-time catalog refresh fails", async () => {
    const api = installOfferEditorApi({ failCatalogRefresh: true });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/offers/new?tenantId=${TENANT_ID}` });

    await screen.findByRole("combobox", { name: "Тенант" });
    await addPosition(user, "Базовый", "Базовый · plan-basic · v1");
    await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Не удалось создать предложение",
    );
    expect(api.calls()).toEqual([]);
    expect(screen.getByDisplayValue("15000.00")).toBeDefined();
  });

  it("fetches and appends a prefilled tenant that is outside the first page", async () => {
    installOfferEditorApi({ tenantItems: [] });
    renderSaasApp({ initialEntry: `/offers/new?tenantId=${TENANT_ID}` });

    expect((await screen.findByRole("combobox", { name: "Тенант" })).textContent).toContain(
      "Первый завод",
    );
  });
});

function billingRequestDetail() {
  return {
    id: REQUEST_ID,
    tenantId: TENANT_ID,
    number: "BR-42",
    type: "renewal",
    status: "under_review",
    description: "Renew",
    desiredAt: null,
    context: null,
    responsibleSide: "markiro",
    createdAt: OFFER_CREATED_AT,
    updatedAt: OFFER_CREATED_AT,
    allowedTransitions: [],
    offerAction: null,
    events: [],
    links: [],
  };
}
