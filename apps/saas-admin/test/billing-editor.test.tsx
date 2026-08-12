import { cleanup, screen, waitFor } from "@testing-library/react";
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

afterEach(() => cleanup());

const CREATED_INVOICE = {
  id: "91111111-1111-4111-8111-111111111111",
  number: "INV-000001",
  tenantId: TENANT_ID,
  status: "draft",
  total: "82500.00",
  paidAt: null,
};

function installBillingEditorApi({ createStatus = 201, tenants = [TENANT_LIST_ITEM] } = {}) {
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
      if (url.endsWith("/api/platform/invoices") && method === "GET")
        return jsonResponse(200, { items: [] });
      if (url.includes("/api/platform/tenants?") && method === "GET")
        return jsonResponse(200, { items: tenants, page: 1, limit: 100, total: tenants.length });
      if (url.endsWith(`/api/platform/tenants/${TENANT_ID}`) && method === "GET")
        return jsonResponse(200, TENANT_DETAIL);
      if (url.endsWith("/api/platform/catalog/items") && method === "GET")
        return jsonResponse(200, { items: [PUBLISHED_PLAN, ADDON, SERVICE] });
      if (url.endsWith("/api/platform/invoices") && method === "POST")
        return createStatus === 201
          ? jsonResponse(201, CREATED_INVOICE)
          : jsonResponse(createStatus, { code: "invoice_catalog_version_invalid" });
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

describe("invoice editor routes", () => {
  it("offers invoice creation from the billing header", async () => {
    installBillingEditorApi();
    renderSaasApp({ initialEntry: "/billing" });

    expect((await screen.findByRole("link", { name: "Создать счёт" })).getAttribute("href")).toBe(
      "/billing/new",
    );
    expect(screen.queryByText("ID тенанта")).toBeNull();
  });

  it("offers both document actions from tenant detail", async () => {
    installBillingEditorApi();
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });

    expect((await screen.findByRole("link", { name: "Создать счёт" })).getAttribute("href")).toBe(
      `/billing/new?tenantId=${TENANT_ID}`,
    );
    expect(screen.getByRole("link", { name: "Создать предложение" }).getAttribute("href")).toBe(
      `/offers/new?tenantId=${TENANT_ID}`,
    );
  });

  it("prefills a tenant, posts three literal lines, and returns with a success notice", async () => {
    const user = userEvent.setup();
    const requests = installBillingEditorApi();
    renderSaasApp({ initialEntry: `/billing/new?tenantId=${TENANT_ID}` });

    const tenant = await screen.findByRole("combobox", { name: "Тенант" });
    await waitFor(() => expect(tenant.textContent).toContain("Первый завод"));
    await addPosition(user, "plan-basic", "Базовый");
    await addPosition(user, "addon-station", "Дополнительная станция");
    await addPosition(user, "service-implementation", "Внедрение");

    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));

    expect(await screen.findByText("Счёт создан")).toBeDefined();
    const post = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/api/platform/invoices"),
    );
    expect(post?.body).toEqual({
      tenantId: TENANT_ID,
      dueDate: null,
      applicationMode: "automatic",
      lines: [
        {
          kind: "plan",
          catalogVersionId: PUBLISHED_PLAN.id,
          nameRu: PUBLISHED_PLAN.nameRu,
          nameEn: PUBLISHED_PLAN.nameEn,
          quantity: 1,
          unit: PUBLISHED_PLAN.unit,
          agreedUnitPrice: PUBLISHED_PLAN.unitPrice,
          vatRateBps: 2000,
          vatIncluded: true,
          activationPolicy: "immediate",
        },
        {
          kind: "addon",
          catalogVersionId: ADDON.id,
          nameRu: ADDON.nameRu,
          nameEn: ADDON.nameEn,
          quantity: 1,
          unit: ADDON.unit,
          agreedUnitPrice: ADDON.unitPrice,
          vatRateBps: 2000,
          vatIncluded: true,
          activationPolicy: "immediate",
        },
        {
          kind: "service",
          catalogVersionId: SERVICE.id,
          nameRu: SERVICE.nameRu,
          nameEn: SERVICE.nameEn,
          quantity: 1,
          unit: SERVICE.unit,
          agreedUnitPrice: SERVICE.unitPrice,
          vatRateBps: 2000,
          vatIncluded: true,
          activationPolicy: null,
        },
      ],
    });
  });

  it("loads a prefilled tenant omitted from page one and retains the draft after a 409", async () => {
    const user = userEvent.setup();
    const requests = installBillingEditorApi({ createStatus: 409, tenants: [] });
    renderSaasApp({ initialEntry: `/billing/new?tenantId=${TENANT_ID}` });

    const tenant = await screen.findByRole("combobox", { name: "Тенант" });
    await waitFor(() => expect(tenant.textContent).toContain("Первый завод"));
    expect(requests.some((request) => request.url.endsWith(`/tenants/${TENANT_ID}`))).toBe(true);
    await addPosition(user, "plan-basic", "Базовый");
    const price = screen.getByRole("textbox", { name: /Цена.*Базовый/i });
    await user.clear(price);
    await user.type(price, "12345.67");
    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));

    expect(
      await screen.findByText("Не удалось создать счёт. Проверьте позиции и повторите."),
    ).toBeDefined();
    expect((price as HTMLInputElement).value).toBe("12345.67");
    expect(screen.getByText("Базовый", { selector: ".document-line__name" })).toBeDefined();
  });
});
