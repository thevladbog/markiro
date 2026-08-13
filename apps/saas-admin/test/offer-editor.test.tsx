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

const READ_ONLY_BILLING_ME = {
  ...ACCOUNTANT_ME,
  capabilities: ACCOUNTANT_ME.capabilities.filter((capability) => capability !== "billing.write"),
};

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
}: {
  createStatus?: number;
  retireOnRefresh?: boolean;
  failCatalogRefresh?: boolean;
  tenantItems?: Array<Record<string, unknown>>;
  me?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let catalogFetches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
      if (url.endsWith("/api/platform/offers") && method === "GET") return jsonResponse(200, []);
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
        return jsonResponse(201, {
          id: "91111111-1111-4111-8111-111111111111",
          tenantId: TENANT_ID,
          status: "draft",
          total: "67500.00",
          lines: body.lines.map((line, index) => ({
            ...line,
            id: `a1111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
            vatRate: line.vatRateBps === null ? null : `${line.vatRateBps / 100}.00`,
            lineTotal: line.agreedUnitPrice,
          })),
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
  it("redirects a direct read-only visit to offers without loading an editable form", async () => {
    installOfferEditorApi({ me: READ_ONLY_BILLING_ME });
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
