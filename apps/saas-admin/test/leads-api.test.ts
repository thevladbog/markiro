import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../src/api/client.js";
import {
  anonymizeLead,
  createLeadTenant,
  getLead,
  getLeadSummary,
  leadKeys,
  leadListPath,
  linkLeadTenant,
  listLeads,
  markLeadContacted,
  updateLead,
} from "../src/pages/leads/api.js";
import { leadErrorMessageKey } from "../src/pages/leads/errorMessages.js";
import {
  moscowCivilDate,
  moscowTouchInstant,
  suggestLeadTenantSlug,
} from "../src/pages/leads/leadFormat.js";
import { LEAD_DETAIL, LEAD_ID, LEAD_LIST_ITEM } from "./leads-fixtures.js";
import { jsonResponse, TENANT_ID } from "./render.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof stubFetch>, index = 0) {
  const [input, init] = fetchMock.mock.calls[index] ?? [];
  return {
    url: String(input),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
  };
}

describe("leads API client", () => {
  it("serializes only the given list filters in a fixed order", () => {
    expect(leadListPath({ page: 1, limit: 50 })).toBe("/leads?page=1&limit=50");
    expect(
      leadListPath({
        page: 2,
        limit: 25,
        search: "  пивоварня ",
        status: "contacted",
        kind: "invoice_request",
        from: "2026-10-01",
        to: "2026-10-20",
      }),
    ).toBe(
      "/leads?page=2&limit=25&search=%D0%BF%D0%B8%D0%B2%D0%BE%D0%B2%D0%B0%D1%80%D0%BD%D1%8F&status=contacted&kind=invoice_request&from=2026-10-01&to=2026-10-20",
    );
    expect(() => leadListPath({ page: 1, limit: 50, from: "20.10.2026" })).toThrow();
  });

  it("parses the list, summary and card through the contract", async () => {
    let body: unknown = { items: [LEAD_LIST_ITEM], total: 1, page: 1, limit: 50 };
    const fetchMock = stubFetch(() => jsonResponse(200, body));

    await expect(listLeads({ page: 1, limit: 50 })).resolves.toMatchObject({ total: 1 });
    body = { newCount: 4 };
    await expect(getLeadSummary()).resolves.toEqual({ newCount: 4 });
    body = LEAD_DETAIL;
    await expect(getLead(LEAD_ID)).resolves.toMatchObject({ id: LEAD_ID });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/platform/leads?page=1&limit=50",
      "/api/platform/leads/summary",
      `/api/platform/leads/${LEAD_ID}`,
    ]);
  });

  it("rejects a card that drifted from the contract", async () => {
    stubFetch(() => jsonResponse(200, { ...LEAD_DETAIL, events: "not-a-list" }));

    const error = await getLead(LEAD_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).kind).toBe("contract");
    expect((error as ApiRequestError).issuePath).toEqual(["events"]);
  });

  it("refuses a malformed lead id before any request", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, LEAD_DETAIL));

    await expect(getLead("../tenants")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends each mutation to its own endpoint with a validated body", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, LEAD_DETAIL));

    await updateLead(LEAD_ID, { status: "trial" });
    await updateLead(LEAD_ID, { ownerNote: "  Перезвонить после смены  " });
    await markLeadContacted(LEAD_ID, {});
    await linkLeadTenant(LEAD_ID, { tenantId: TENANT_ID });
    await createLeadTenant(LEAD_ID, {
      tenantName: "ООО «Пивоварня»",
      tenantSlug: "inn-7707083893",
    });
    await anonymizeLead(LEAD_ID);

    expect(fetchMock.mock.calls.map((_, index) => sent(fetchMock, index))).toEqual([
      { url: `/api/platform/leads/${LEAD_ID}`, method: "PATCH", body: { status: "trial" } },
      {
        url: `/api/platform/leads/${LEAD_ID}`,
        method: "PATCH",
        body: { ownerNote: "Перезвонить после смены" },
      },
      { url: `/api/platform/leads/${LEAD_ID}/contacted`, method: "POST", body: {} },
      {
        url: `/api/platform/leads/${LEAD_ID}/link-tenant`,
        method: "POST",
        body: { tenantId: TENANT_ID },
      },
      {
        url: `/api/platform/leads/${LEAD_ID}/create-tenant`,
        method: "POST",
        body: { tenantName: "ООО «Пивоварня»", tenantSlug: "inn-7707083893" },
      },
      { url: `/api/platform/leads/${LEAD_ID}/anonymize`, method: "POST", body: undefined },
    ]);
  });

  it("refuses an empty update locally", async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, LEAD_DETAIL));

    await expect(updateLead(LEAD_ID, {})).rejects.toThrow();
    await expect(
      createLeadTenant(LEAD_ID, { tenantName: "Завод", tenantSlug: "Not A Slug" }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps domain error codes and falls back to a generic message", async () => {
    stubFetch(() => jsonResponse(409, { code: "lead_anonymized" }));
    const anonymized = await updateLead(LEAD_ID, { status: "won" }).catch((e: unknown) => e);
    expect(anonymized).toBeInstanceOf(ApiRequestError);
    expect(leadErrorMessageKey("update", anonymized)).toBe("leads.errors.lead_anonymized");

    stubFetch(() => jsonResponse(404, { code: "lead_tenant_not_found" }));
    const missingTenant = await linkLeadTenant(LEAD_ID, { tenantId: TENANT_ID }).catch(
      (e: unknown) => e,
    );
    expect(leadErrorMessageKey("link", missingTenant)).toBe("leads.errors.lead_tenant_not_found");

    stubFetch(() => jsonResponse(409, { code: "tenant_cabinet_access_mismatch" }));
    const conflict = await createLeadTenant(LEAD_ID, {
      tenantName: "Завод",
      tenantSlug: "zavod",
    }).catch((e: unknown) => e);
    expect(leadErrorMessageKey("createTenant", conflict)).toBe(
      "leads.errors.tenant_cabinet_access_mismatch",
    );

    stubFetch(() => jsonResponse(409, { code: "lead_tenant_slug_taken" }));
    const taken = await createLeadTenant(LEAD_ID, {
      tenantName: "Завод",
      tenantSlug: "zavod",
    }).catch((e: unknown) => e);
    expect(leadErrorMessageKey("createTenant", taken)).toBe("leads.errors.lead_tenant_slug_taken");

    stubFetch(() => jsonResponse(409, { code: "something_new" }));
    const unknown = await anonymizeLead(LEAD_ID).catch((e: unknown) => e);
    expect(leadErrorMessageKey("anonymize", unknown)).toBe("leads.errors.anonymize_failed");
    expect(leadErrorMessageKey("update", new Error("boom"))).toBe("leads.errors.update_failed");
  });

  it("keys every leads query under the platform leads root", () => {
    expect(leadKeys.all).toEqual(["platform", "leads"]);
    expect(leadKeys.summary()).toEqual(["platform", "leads", "summary"]);
    expect(leadKeys.detail(LEAD_ID)).toEqual(["platform", "leads", "detail", LEAD_ID]);
    expect(leadKeys.list({ page: 1, limit: 50 }).slice(0, 3)).toEqual([
      "platform",
      "leads",
      "list",
    ]);
  });
});

describe("lead date and slug helpers", () => {
  it("sends a civil next-touch date as 09:00 in Moscow and reads it back", () => {
    expect(moscowTouchInstant("2026-10-24")).toBe("2026-10-24T06:00:00.000Z");
    expect(moscowCivilDate("2026-10-24T06:00:00.000Z")).toBe("2026-10-24");
    // 23:30 UTC is already the next day in Moscow.
    expect(moscowCivilDate("2026-10-24T23:30:00.000Z")).toBe("2026-10-25");
    expect(moscowCivilDate(null)).toBe("");
  });

  it("prefers the INN for the tenant slug and transliterates the company otherwise", () => {
    expect(suggestLeadTenantSlug("ООО «Пивоварня»", "7707083893")).toBe("inn-7707083893");
    expect(suggestLeadTenantSlug("ООО «Пивоварня Щука»", null)).toBe("pivovarnya-shchuka");
    expect(suggestLeadTenantSlug("АО Сыр & Молоко № 1", null)).toBe("syr-moloko-1");
    expect(suggestLeadTenantSlug("Brewery Ltd.", null)).toBe("brewery-ltd");
    expect(suggestLeadTenantSlug("«»", null)).toBe("");
  });
});
