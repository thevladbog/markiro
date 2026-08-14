import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  ADDON,
  PUBLISHED_PLAN,
  SERVICE,
  TENANT_DETAIL,
  TENANT_ID,
  TENANT_LIST_ITEM,
  jsonResponse,
  renderSaasApp,
} from "./render.js";

const OFFER_ID = "81111111-1111-4111-8111-111111111111";
const READ_ONLY_BILLING_ME = {
  ...ACCOUNTANT_ME,
  capabilities: ACCOUNTANT_ME.capabilities.filter((capability) => capability !== "billing.write"),
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installInvoiceEditorApi({
  createStatus = 201,
  tenantItems = [TENANT_LIST_ITEM],
  offer = null,
  me = ACCOUNTANT_ME,
}: {
  createStatus?: number;
  tenantItems?: Array<Record<string, unknown>>;
  offer?: Record<string, unknown> | null;
  me?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
      if (url.endsWith("/api/platform/invoices") && method === "GET") {
        return jsonResponse(200, { items: [] });
      }
      if (url.endsWith("/api/platform/offers") && method === "GET") {
        return jsonResponse(
          200,
          offer
            ? [
                {
                  id: OFFER_ID,
                  tenantId: TENANT_ID,
                  status: "published",
                  total: "1.00",
                },
              ]
            : [],
        );
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
      if (url.endsWith("/api/platform/catalog/items") && method === "GET") {
        return jsonResponse(200, { items: [PUBLISHED_PLAN, ADDON, SERVICE] });
      }
      if (url.endsWith(`/api/platform/offers/${OFFER_ID}`) && method === "GET" && offer) {
        return jsonResponse(200, offer);
      }
      if (url.endsWith("/api/platform/invoices") && method === "POST") {
        const body = JSON.parse(String(init.body));
        calls.push({ method, path: url, body });
        if (createStatus === 400) {
          return jsonResponse(400, { code: "invoice_catalog_version_invalid" });
        }
        return jsonResponse(201, {
          id: "91111111-1111-4111-8111-111111111111",
          number: "INV-000001",
          tenantId: TENANT_ID,
          status: "draft",
          total: "30000.00",
          paidAt: null,
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

describe("invoice editor route", () => {
  it("redirects a direct read-only visit to billing without loading an editable form", async () => {
    installInvoiceEditorApi({ me: READ_ONLY_BILLING_ME });
    renderSaasApp({ initialEntry: "/billing/new" });

    expect(await screen.findByRole("heading", { name: "Счета и платежи" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Создать черновик счёта" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Тенант" })).toBeNull();
  });

  it("opens from billing, preselects the tenant, and sends three literal lines", async () => {
    const api = installInvoiceEditorApi();
    const user = userEvent.setup();
    const billing = renderSaasApp({ initialEntry: "/billing" });

    const createLink = await screen.findByRole("link", { name: "Создать счёт" });
    expect(createLink.getAttribute("href")).toBe("/billing/new");
    expect(api.calls()).toEqual([]);
    billing.unmount();

    renderSaasApp({ initialEntry: `/billing/new?tenantId=${TENANT_ID}` });
    expect((await screen.findByRole("combobox", { name: "Тенант" })).textContent).toContain(
      "Первый завод",
    );

    await addPosition(user, "Базовый", "Базовый · plan-basic · v1");
    await addPosition(user, "Дополнительная", "Дополнительная станция · addon-station · v1");
    await addPosition(user, "Внедрение", "Внедрение · service-implementation · v1");
    await user.type(screen.getByLabelText("Срок оплаты"), "2026-09-01");
    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));

    expect(api.calls()).toEqual([
      {
        method: "POST",
        path: "/api/platform/invoices",
        body: {
          tenantId: TENANT_ID,
          dueDate: "2026-09-01",
          applicationMode: "automatic",
          lines: [
            {
              kind: "plan",
              catalogVersionId: PUBLISHED_PLAN.id,
              nameRu: "Базовый",
              nameEn: "Basic",
              quantity: 1,
              unit: "month",
              agreedUnitPrice: "15000.00",
              vatRateBps: 2000,
              vatIncluded: true,
              activationPolicy: "immediate",
            },
            {
              kind: "addon",
              catalogVersionId: ADDON.id,
              nameRu: "Дополнительная станция",
              nameEn: "Extra station",
              quantity: 1,
              unit: "station",
              agreedUnitPrice: "2500.00",
              vatRateBps: 2000,
              vatIncluded: true,
              activationPolicy: "immediate",
            },
            {
              kind: "service",
              catalogVersionId: SERVICE.id,
              nameRu: "Внедрение",
              nameEn: "Implementation",
              quantity: 1,
              unit: "project",
              agreedUnitPrice: "50000.00",
              vatRateBps: 2000,
              vatIncluded: true,
              activationPolicy: null,
            },
          ],
        },
      },
    ]);
    expect((await screen.findByRole("alert")).textContent).toContain("Счёт создан");
  });

  it("refreshes the catalog and keeps the invoice draft after the API rejects a retired version", async () => {
    installInvoiceEditorApi({ createStatus: 400 });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/billing/new?tenantId=${TENANT_ID}` });

    await screen.findByRole("combobox", { name: "Тенант" });
    await addPosition(user, "Базовый", "Базовый · plan-basic · v1");
    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "одна из выбранных версий больше не опубликована",
    );
    expect(screen.getByRole("combobox", { name: "Тенант" }).textContent).toContain("Первый завод");
    expect(screen.getByDisplayValue("15000.00")).toBeDefined();
  });

  it("fetches and appends a prefilled tenant that is outside the first page", async () => {
    installInvoiceEditorApi({ tenantItems: [] });
    renderSaasApp({ initialEntry: `/billing/new?tenantId=${TENANT_ID}` });

    expect((await screen.findByRole("combobox", { name: "Тенант" })).textContent).toContain(
      "Первый завод",
    );
  });

  it("preserves mismatched and legacy offer snapshots as literal custom invoice lines", async () => {
    const offer = {
      id: OFFER_ID,
      tenantId: TENANT_ID,
      status: "published",
      total: "1.00",
      lines: [
        {
          id: "a1111111-1111-4111-8111-111111111111",
          kind: "plan",
          catalogVersionId: PUBLISHED_PLAN.id,
          nameRu: "Индивидуальный тариф",
          nameEn: "Custom plan",
          descriptionRu: null,
          descriptionEn: null,
          quantity: 3,
          unit: "month",
          catalogUnitPrice: null,
          agreedUnitPrice: "321.00",
          vatRate: "20.00",
          vatIncluded: true,
          activationPolicy: "after_current",
          lineTotal: "963.00",
        },
        {
          id: "b1111111-1111-4111-8111-111111111111",
          kind: "service",
          catalogVersionId: null,
          nameRu: "Архивная настройка",
          nameEn: "Legacy setup",
          descriptionRu: null,
          descriptionEn: null,
          quantity: 2,
          unit: "project",
          catalogUnitPrice: null,
          agreedUnitPrice: "10.00",
          vatRate: "1.13",
          vatIncluded: false,
          activationPolicy: null,
          lineTotal: "20.23",
        },
        {
          id: "c1111111-1111-4111-8111-111111111111",
          kind: "addon",
          catalogVersionId: ADDON.id,
          nameRu: "Архивное дополнение",
          nameEn: "Legacy addon",
          descriptionRu: null,
          descriptionEn: null,
          quantity: 4,
          unit: "station",
          catalogUnitPrice: null,
          agreedUnitPrice: "45.00",
          vatRate: null,
          vatIncluded: false,
          activationPolicy: "immediately",
          lineTotal: "180.00",
        },
      ],
    };
    const api = installInvoiceEditorApi({ offer });
    renderSaasApp({ initialEntry: "/offers" });
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Коммерческие предложения" });
    await user.click(await screen.findByRole("button", { name: TENANT_ID }));
    await user.click(await screen.findByRole("button", { name: "Создать счёт по предложению" }));

    expect(await screen.findByDisplayValue("321.00")).toBeDefined();
    expect(screen.getByDisplayValue("3")).toBeDefined();
    expect(screen.getByDisplayValue("10.00")).toBeDefined();
    expect(screen.getByDisplayValue("45.00")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));

    expect(api.calls()[0]?.body).toEqual({
      tenantId: TENANT_ID,
      dueDate: null,
      applicationMode: "automatic",
      lines: [
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: "Индивидуальный тариф",
          nameEn: "Custom plan",
          descriptionRu: null,
          descriptionEn: null,
          quantity: 3,
          unit: "month",
          catalogUnitPrice: null,
          agreedUnitPrice: "321.00",
          vatRateBps: 2000,
          vatIncluded: true,
          activationPolicy: null,
        },
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: "Архивная настройка",
          nameEn: "Legacy setup",
          descriptionRu: null,
          descriptionEn: null,
          quantity: 2,
          unit: "project",
          catalogUnitPrice: null,
          agreedUnitPrice: "10.00",
          vatRateBps: 113,
          vatIncluded: false,
          activationPolicy: null,
        },
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: "Архивное дополнение",
          nameEn: "Legacy addon",
          descriptionRu: null,
          descriptionEn: null,
          quantity: 4,
          unit: "station",
          catalogUnitPrice: null,
          agreedUnitPrice: "45.00",
          vatRateBps: null,
          vatIncluded: false,
          activationPolicy: null,
        },
      ],
    });
  });
});
