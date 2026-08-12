import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  ADDON,
  PUBLISHED_PLAN,
  SERVICE,
  TENANT_ID,
  TENANT_LIST_ITEM,
  jsonResponse,
  renderSaasApp,
} from "./render.js";

afterEach(() => cleanup());

const OFFER_ID = "a1111111-1111-4111-8111-111111111111";
const OFFER_SUMMARY = {
  id: OFFER_ID,
  tenantId: TENANT_ID,
  status: "published",
  total: "76543.21",
};
const OFFER_DETAIL = {
  ...OFFER_SUMMARY,
  expiresAt: "2026-09-30T00:00:00.000Z",
  lines: [
    {
      id: "a2111111-1111-4111-8111-111111111111",
      position: 1,
      kind: "plan",
      catalogVersionId: PUBLISHED_PLAN.id,
      nameRu: "Согласованный тариф",
      nameEn: "Agreed plan",
      descriptionRu: "Согласованное описание тарифа",
      descriptionEn: "Agreed plan description",
      quantity: 2,
      unit: "лицензия",
      catalogUnitPrice: PUBLISHED_PLAN.unitPrice,
      agreedUnitPrice: "11111.11",
      priceOverrideReason: "Согласованная цена",
      vatRate: "20.00",
      vatIncluded: false,
      activationPolicy: "immediately",
      lineTotal: "26666.66",
    },
    {
      id: "a3111111-1111-4111-8111-111111111111",
      position: 2,
      kind: "addon",
      catalogVersionId: ADDON.id,
      nameRu: "Согласованное дополнение",
      nameEn: "Agreed addon",
      descriptionRu: "Согласованное описание дополнения",
      descriptionEn: "Agreed addon description",
      quantity: 3,
      unit: "станция",
      catalogUnitPrice: ADDON.unitPrice,
      agreedUnitPrice: "2222.22",
      priceOverrideReason: "Согласованная цена",
      vatRate: "20.00",
      vatIncluded: true,
      activationPolicy: null,
      lineTotal: "6666.66",
    },
    {
      id: "a4111111-1111-4111-8111-111111111111",
      position: 3,
      kind: "service",
      catalogVersionId: SERVICE.id,
      nameRu: "Согласованная услуга",
      nameEn: "Agreed service",
      descriptionRu: "Согласованное описание услуги",
      descriptionEn: "Agreed service description",
      quantity: 4,
      unit: "этап",
      catalogUnitPrice: SERVICE.unitPrice,
      agreedUnitPrice: "3333.33",
      priceOverrideReason: "Согласованная цена",
      vatRate: null,
      vatIncluded: false,
      activationPolicy: null,
      lineTotal: "13333.32",
    },
  ],
};

const LEGACY_OFFER_DETAIL = {
  ...OFFER_DETAIL,
  lines: [
    {
      id: "a5111111-1111-4111-8111-111111111111",
      position: 1,
      kind: "service",
      catalogVersionId: null,
      nameRu: "Архивная консультация",
      nameEn: "Archived consulting",
      descriptionRu: "Архивное описание",
      descriptionEn: "Archived description",
      quantity: 5,
      unit: "час",
      catalogUnitPrice: null,
      agreedUnitPrice: "4444.44",
      priceOverrideReason: null,
      vatRate: "10.00",
      vatIncluded: true,
      activationPolicy: null,
      lineTotal: "22222.20",
    },
    {
      id: "a6111111-1111-4111-8111-111111111111",
      position: 2,
      kind: "plan",
      catalogVersionId: "a7111111-1111-4111-8111-111111111111",
      nameRu: "Снятый с публикации тариф",
      nameEn: "Retired plan",
      descriptionRu: null,
      descriptionEn: null,
      quantity: 2,
      unit: "месяц",
      catalogUnitPrice: "5555.55",
      agreedUnitPrice: "5555.55",
      priceOverrideReason: null,
      vatRate: null,
      vatIncluded: false,
      activationPolicy: "after_current",
      lineTotal: "11111.10",
    },
  ],
};

const LITERAL_SNAPSHOT_OFFER_DETAIL = {
  ...OFFER_DETAIL,
  lines: [
    {
      id: "a8111111-1111-4111-8111-111111111111",
      position: 1,
      kind: "plan",
      catalogVersionId: PUBLISHED_PLAN.id,
      nameRu: PUBLISHED_PLAN.nameRu,
      nameEn: PUBLISHED_PLAN.nameEn,
      descriptionRu: "Согласованное описание",
      descriptionEn: "Negotiated description",
      quantity: 2,
      unit: PUBLISHED_PLAN.unit,
      catalogUnitPrice: PUBLISHED_PLAN.unitPrice,
      agreedUnitPrice: "49.50",
      priceOverrideReason: "Пилотный контракт",
      vatRate: null,
      vatIncluded: false,
      activationPolicy: "immediately",
      lineTotal: "99.00",
    },
  ],
};

function installOfferEditorApi({
  offers = [] as unknown[],
  createStatus = 201,
  offerDetail = OFFER_DETAIL,
}: {
  offers?: unknown[];
  createStatus?: number;
  offerDetail?: unknown;
} = {}) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      requests.push({
        url,
        method,
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
      if (url.endsWith("/api/platform/offers") && method === "GET")
        return jsonResponse(200, offers);
      if (url.endsWith(`/api/platform/offers/${OFFER_ID}`) && method === "GET")
        return jsonResponse(200, offerDetail);
      if (url.includes("/api/platform/tenants?") && method === "GET")
        return jsonResponse(200, { items: [TENANT_LIST_ITEM], page: 1, limit: 100, total: 1 });
      if (url.endsWith("/api/platform/catalog/items") && method === "GET")
        return jsonResponse(200, { items: [PUBLISHED_PLAN, ADDON, SERVICE] });
      if (url.endsWith("/api/platform/offers") && method === "POST")
        return createStatus === 201
          ? jsonResponse(201, { ...OFFER_DETAIL, status: "draft" })
          : jsonResponse(createStatus, { code: "offer_catalog_version_invalid" });
      if (url.endsWith("/api/platform/invoices") && method === "POST")
        return jsonResponse(201, {
          id: "b1111111-1111-4111-8111-111111111111",
          number: "INV-000002",
          tenantId: TENANT_ID,
          status: "draft",
          total: "46666.64",
          paidAt: null,
        });
      if (url.endsWith("/api/platform/invoices") && method === "GET")
        return jsonResponse(200, { items: [] });
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  return requests;
}

async function addPosition(
  user: ReturnType<typeof userEvent.setup>,
  query: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: "Добавить позицию" }));
  await user.type(screen.getByRole("searchbox"), query);
  await user.click(screen.getByRole("option", { name: new RegExp(option, "i") }));
}

describe("offer editor routes", () => {
  it("maps plan and fixed add-on policies in an exact multi-line offer payload", async () => {
    const user = userEvent.setup();
    const requests = installOfferEditorApi();
    renderSaasApp({ initialEntry: `/offers/new?tenantId=${TENANT_ID}` });

    const tenant = await screen.findByRole("combobox", { name: "Тенант" });
    await waitFor(() => expect(tenant.textContent).toContain("Первый завод"));
    await addPosition(user, "plan-basic", "Базовый");
    await addPosition(user, "addon-station", "Дополнительная станция");
    await addPosition(user, "service-implementation", "Внедрение");
    const planRow = screen
      .getByText("Базовый", { selector: ".document-line__name" })
      .closest("tr")!;
    await user.click(within(planRow).getByRole("combobox", { name: /Правило применения/i }));
    await user.click(screen.getByRole("option", { name: "После текущей подписки" }));
    await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));

    expect(await screen.findByText("Предложение создано")).toBeDefined();
    const post = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/api/platform/offers"),
    );
    expect(post?.body).toEqual({
      tenantId: TENANT_ID,
      expiresAt: null,
      lines: [
        expect.objectContaining({
          kind: "plan",
          catalogVersionId: PUBLISHED_PLAN.id,
          priceOverrideReason: null,
          activationPolicy: "after_current",
        }),
        expect.objectContaining({
          kind: "addon",
          catalogVersionId: ADDON.id,
          priceOverrideReason: null,
          activationPolicy: null,
        }),
        expect.objectContaining({
          kind: "service",
          catalogVersionId: SERVICE.id,
          priceOverrideReason: null,
          activationPolicy: null,
        }),
      ],
    });
    expect(
      requests.some(
        (request) => request.method === "GET" && request.url.includes("/api/platform/offers/"),
      ),
    ).toBe(false);
  });

  it("retains an offer draft after a handled 409", async () => {
    const user = userEvent.setup();
    const requests = installOfferEditorApi({ createStatus: 409 });
    renderSaasApp({ initialEntry: `/offers/new?tenantId=${TENANT_ID}` });

    await screen.findByRole("combobox", { name: "Тенант" });
    await addPosition(user, "plan-basic", "Базовый");
    const price = screen.getByRole("textbox", { name: /Цена.*Базовый/i });
    await user.clear(price);
    await user.type(price, "9999.99");
    await user.type(
      screen.getByRole("textbox", { name: /Причина изменения цены.*Базовый/i }),
      "Согласованная скидка",
    );
    await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));

    expect(
      await screen.findByText("Не удалось создать предложение. Проверьте позиции и повторите."),
    ).toBeDefined();
    expect((price as HTMLInputElement).value).toBe("9999.99");
    expect(screen.getByText("Базовый", { selector: ".document-line__name" })).toBeDefined();
    const post = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/api/platform/offers"),
    );
    expect(post?.body).toMatchObject({
      lines: [
        {
          agreedUnitPrice: "9999.99",
          priceOverrideReason: "Согласованная скидка",
        },
      ],
    });
  });

  it("maps changed published-catalog offer snapshots to custom invoice lines", async () => {
    const user = userEvent.setup();
    const requests = installOfferEditorApi({ offers: [OFFER_SUMMARY] });
    renderSaasApp({ initialEntry: "/offers" });

    await user.click(await screen.findByRole("button", { name: TENANT_ID }));
    await user.click(screen.getByRole("link", { name: "Создать счёт" }));

    expect(await screen.findByText("Согласованный тариф")).toBeDefined();
    expect(screen.getByText("Согласованное дополнение")).toBeDefined();
    expect(screen.getByText("Согласованная услуга")).toBeDefined();
    expect(
      requests.filter(
        (request) => request.method === "GET" && request.url.endsWith(`/offers/${OFFER_ID}`),
      ),
    ).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));
    await screen.findByText("Счёт создан");
    const post = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/api/platform/invoices"),
    );
    expect(post?.body).toEqual({
      tenantId: TENANT_ID,
      dueDate: null,
      applicationMode: "automatic",
      lines: [
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: "Согласованный тариф",
          nameEn: "Agreed plan",
          descriptionRu: "Согласованное описание тарифа",
          descriptionEn: "Agreed plan description",
          quantity: 2,
          unit: "лицензия",
          catalogUnitPrice: PUBLISHED_PLAN.unitPrice,
          agreedUnitPrice: "11111.11",
          vatRateBps: 2000,
          vatIncluded: false,
          activationPolicy: null,
        },
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: "Согласованное дополнение",
          nameEn: "Agreed addon",
          descriptionRu: "Согласованное описание дополнения",
          descriptionEn: "Agreed addon description",
          quantity: 3,
          unit: "станция",
          catalogUnitPrice: ADDON.unitPrice,
          agreedUnitPrice: "2222.22",
          vatRateBps: 2000,
          vatIncluded: true,
          activationPolicy: null,
        },
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: "Согласованная услуга",
          nameEn: "Agreed service",
          descriptionRu: "Согласованное описание услуги",
          descriptionEn: "Agreed service description",
          quantity: 4,
          unit: "этап",
          catalogUnitPrice: SERVICE.unitPrice,
          agreedUnitPrice: "3333.33",
          vatRateBps: null,
          vatIncluded: false,
          activationPolicy: null,
        },
      ],
    });
  });

  it("copies catalog-less and retired offer snapshots into supported custom invoice lines", async () => {
    const user = userEvent.setup();
    const requests = installOfferEditorApi({
      offers: [OFFER_SUMMARY],
      offerDetail: LEGACY_OFFER_DETAIL,
    });
    renderSaasApp({ initialEntry: "/offers" });

    await user.click(await screen.findByRole("button", { name: TENANT_ID }));
    await user.click(screen.getByRole("link", { name: "Создать счёт" }));
    expect(await screen.findByText("Архивная консультация")).toBeDefined();
    expect(screen.getByText("Снятый с публикации тариф")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));
    await screen.findByText("Счёт создан");

    const post = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/api/platform/invoices"),
    );
    expect(post?.body).toEqual({
      tenantId: TENANT_ID,
      dueDate: null,
      applicationMode: "automatic",
      lines: [
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: "Архивная консультация",
          nameEn: "Archived consulting",
          descriptionRu: "Архивное описание",
          descriptionEn: "Archived description",
          quantity: 5,
          unit: "час",
          catalogUnitPrice: null,
          agreedUnitPrice: "4444.44",
          vatRateBps: 1000,
          vatIncluded: true,
          activationPolicy: null,
        },
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: "Снятый с публикации тариф",
          nameEn: "Retired plan",
          descriptionRu: null,
          descriptionEn: null,
          quantity: 2,
          unit: "месяц",
          catalogUnitPrice: "5555.55",
          agreedUnitPrice: "5555.55",
          vatRateBps: null,
          vatIncluded: false,
          activationPolicy: null,
        },
      ],
    });
  });

  it("keeps distinct descriptions and explicit null VAT as a literal custom invoice snapshot", async () => {
    const user = userEvent.setup();
    const requests = installOfferEditorApi({
      offers: [OFFER_SUMMARY],
      offerDetail: LITERAL_SNAPSHOT_OFFER_DETAIL,
    });
    renderSaasApp({ initialEntry: "/offers" });

    await user.click(await screen.findByRole("button", { name: TENANT_ID }));
    await user.click(screen.getByRole("link", { name: "Создать счёт" }));
    expect(await screen.findByText(PUBLISHED_PLAN.nameRu)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));
    await screen.findByText("Счёт создан");

    const post = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/api/platform/invoices"),
    );
    expect(post?.body).toEqual({
      tenantId: TENANT_ID,
      dueDate: null,
      applicationMode: "automatic",
      lines: [
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: PUBLISHED_PLAN.nameRu,
          nameEn: PUBLISHED_PLAN.nameEn,
          descriptionRu: "Согласованное описание",
          descriptionEn: "Negotiated description",
          quantity: 2,
          unit: PUBLISHED_PLAN.unit,
          catalogUnitPrice: PUBLISHED_PLAN.unitPrice,
          agreedUnitPrice: "49.50",
          vatRateBps: null,
          vatIncluded: false,
          activationPolicy: null,
        },
      ],
    });
  });
});
