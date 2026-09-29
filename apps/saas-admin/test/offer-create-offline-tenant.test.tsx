import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  ADDON,
  PLATFORM_ADMIN_ME,
  PUBLISHED_PLAN,
  SERVICE,
  TENANT_DETAIL,
  TENANT_ID,
  jsonResponse,
  renderSaasApp,
} from "./render.js";

const REQUEST_ID = "81111111-1111-4111-8111-111111111111";
const REQUEST_CREATED_AT = "2026-08-21T10:00:00.000Z";

function billingRequestDetail() {
  return {
    id: REQUEST_ID,
    tenantId: TENANT_ID,
    tenantName: "Первый завод",
    number: "BR-42",
    type: "renewal",
    status: "under_review",
    description: "Renew",
    desiredAt: null,
    context: null,
    responsibleSide: "markiro",
    createdAt: REQUEST_CREATED_AT,
    updatedAt: REQUEST_CREATED_AT,
    allowedTransitions: [],
    offerAction: null,
    events: [],
    links: [],
  };
}
const BUTTON = "Создать тенанта без кабинета";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installApi({
  me = PLATFORM_ADMIN_ME,
  createResponse = 201,
  createCode = "tenant_conflict",
}: { me?: Record<string, unknown>; createResponse?: number; createCode?: string } = {}) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
      if (url.endsWith("/api/platform/billing/operator/accounts")) return jsonResponse(200, []);
      if (url.includes("/api/platform/tenants?")) {
        return jsonResponse(200, { items: [], page: 1, limit: 100, total: 0 });
      }
      if (url.endsWith("/api/platform/tenants") && method === "POST") {
        posts.push({ path: url, body: JSON.parse(String(init.body)) });
        if (createResponse !== 201) {
          return jsonResponse(createResponse, { code: createCode });
        }
        return jsonResponse(201, {
          tenantId: TENANT_ID,
          userId: null,
          memberId: null,
          deliveryId: null,
        });
      }
      if (url.endsWith(`/api/platform/tenants/${TENANT_ID}`) && method === "GET") {
        return jsonResponse(200, TENANT_DETAIL);
      }
      if (url.endsWith(`/api/platform/billing/requests/${REQUEST_ID}`) && method === "GET") {
        return jsonResponse(200, billingRequestDetail());
      }
      if (url.endsWith("/api/platform/catalog/items")) {
        return jsonResponse(200, { items: [PUBLISHED_PLAN, ADDON, SERVICE] });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  return { posts: () => structuredClone(posts) };
}

describe("offer editor: tenant without cabinet", () => {
  it("shows the button only with tenants.write and no request binding", async () => {
    installApi({ me: ACCOUNTANT_ME });
    renderSaasApp({ initialEntry: "/offers/new" });
    await screen.findByRole("combobox", { name: "Тенант" });
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
    cleanup();

    installApi();
    renderSaasApp({ initialEntry: "/offers/new" });
    expect(await screen.findByRole("button", { name: BUTTON })).toBeDefined();
    cleanup();

    installApi();
    renderSaasApp({ initialEntry: `/billing-requests/${REQUEST_ID}/offers/new` });
    // The composer is rendered with the request's locked tenant, and the
    // button is absent because the tenant is bound, not because it is loading.
    expect(await screen.findByText(`Тенант заявки · ${TENANT_ID}`)).toBeDefined();
    expect(screen.getByRole("button", { name: "Создать черновик предложения" })).toBeDefined();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  });

  it("creates the tenant without an email and preselects it", async () => {
    const api = installApi();
    const user = userEvent.setup();
    const rendered = renderSaasApp({ initialEntry: "/offers/new" });
    const invalidate = vi.spyOn(rendered.queryClient, "invalidateQueries");

    await user.click(await screen.findByRole("button", { name: BUTTON }));
    await user.type(screen.getByLabelText("Название"), "Первый завод");
    await user.type(screen.getByLabelText("Slug"), "first-factory");
    await user.click(screen.getByRole("button", { name: "Создать тенанта" }));

    await waitFor(() =>
      expect(rendered.router.state.location.pathname + rendered.router.state.location.search).toBe(
        `/offers/new?tenantId=${TENANT_ID}`,
      ),
    );
    expect(api.posts()).toEqual([
      {
        path: "/api/platform/tenants",
        body: { tenantName: "Первый завод", tenantSlug: "first-factory", cabinetAccess: "none" },
      },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["platform", "tenants"] });
  });

  it("keeps the form open and shows the mapped error on conflict", async () => {
    installApi({ createResponse: 409, createCode: "tenant_cabinet_access_mismatch" });
    const user = userEvent.setup();
    const rendered = renderSaasApp({ initialEntry: "/offers/new" });

    const trigger = await screen.findByRole("button", { name: BUTTON });
    await user.click(trigger);
    await user.type(screen.getByLabelText("Название"), "Первый завод");
    await user.type(screen.getByLabelText("Slug"), "first-factory");
    await user.click(screen.getByRole("button", { name: "Создать тенанта" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Тенант с этим slug уже создан с другим режимом доступа в кабинет",
    );
    expect(screen.getByLabelText("Slug")).toBeDefined();
    expect(rendered.router.state.location.search).toBe("");

    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByLabelText("Slug")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
