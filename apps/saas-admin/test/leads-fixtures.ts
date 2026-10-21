import type { PlatformLeadDetail, PlatformLeadListItem } from "@markiro/platform-contracts";
import { vi } from "vitest";

import type { PlatformPrincipal } from "../src/auth/PlatformAuthBoundary.js";
import { jsonResponse, PLATFORM_ADMIN_ME, TENANT_ID, TENANT_LIST_ITEM } from "./render.js";

export const LEAD_ID = "51111111-1111-4111-8111-111111111151";
export const LEAD_INN = "7707083893";

export const LEAD_LIST_ITEM = {
  id: LEAD_ID,
  company: "ООО «Пивоварня»",
  email: "buyer@pivovarnya.example",
  inn: LEAD_INN,
  status: "new",
  nextTouchAt: "2026-10-24T06:00:00.000Z",
  tariffCode: "start",
  lastEvent: { kind: "invoice_request", createdAt: "2026-10-20T07:30:00.000Z" },
  tenantId: null,
  anonymized: false,
  createdAt: "2026-10-19T07:00:00.000Z",
} satisfies PlatformLeadListItem;

export const LEAD_DETAIL = {
  id: LEAD_ID,
  email: "buyer@pivovarnya.example",
  company: "ООО «Пивоварня»",
  name: "Анна Петрова",
  phone: "+79990001122",
  inn: LEAD_INN,
  productGroup: "Пиво и сидр",
  linesBucket: "2-3",
  locale: "ru",
  status: "new",
  statusChangedAt: "2026-10-19T07:00:00.000Z",
  nextTouchAt: "2026-10-24T06:00:00.000Z",
  ownerNote: null,
  tariffCode: "start",
  firstSourcePath: "/skachat/",
  firstUtm: { source: "yandex", medium: "cpc" },
  firstReferrer: "https://ya.ru/",
  tenant: null,
  anonymizedAt: null,
  createdAt: "2026-10-19T07:00:00.000Z",
  updatedAt: "2026-10-20T07:30:00.000Z",
  events: [
    {
      id: "52111111-1111-4111-8111-111111111152",
      kind: "status_change",
      payload: { from: "new", to: "contacted", nextTouchAt: "2026-10-24T06:00:00.000Z" },
      actor: { id: "user-1", name: "Оператор платформы" },
      createdAt: "2026-10-20T08:00:00.000Z",
    },
    {
      id: "53111111-1111-4111-8111-111111111153",
      kind: "invoice_request",
      payload: {
        sourcePath: "/stoimost/",
        locale: "ru",
        inn: LEAD_INN,
        tariffCode: "start",
        unexpectedKey: { nested: true },
      },
      actor: null,
      createdAt: "2026-10-20T07:30:00.000Z",
    },
    {
      id: "54111111-1111-4111-8111-111111111154",
      kind: "download",
      payload: {
        sourcePath: "/skachat/",
        locale: "ru",
        utm: { source: "yandex", medium: "cpc" },
        productGroup: "Пиво и сидр",
        linesBucket: "2-3",
      },
      actor: null,
      createdAt: "2026-10-19T07:00:00.000Z",
    },
  ],
} satisfies PlatformLeadDetail;

export const ANONYMIZED_LEAD_DETAIL = {
  ...LEAD_DETAIL,
  email: null,
  name: null,
  phone: null,
  status: "lost",
  anonymizedAt: "2026-10-21T03:00:00.000Z",
  events: [
    {
      id: "55111111-1111-4111-8111-111111111155",
      kind: "anonymized",
      payload: { reason: "lost" },
      actor: null,
      createdAt: "2026-10-21T03:00:00.000Z",
    },
  ],
} satisfies PlatformLeadDetail;

export interface LeadApiCall {
  url: string;
  method: string;
  body: unknown;
}

export function installLeadsApi({
  me = PLATFORM_ADMIN_ME,
  summary = { newCount: 3 },
  summaryStatus = 200,
  list = { items: [LEAD_LIST_ITEM], total: 1, page: 1, limit: 50 },
  detail = LEAD_DETAIL,
  mutationStatus = 200,
  mutationError = "lead_anonymized",
}: {
  me?: PlatformPrincipal;
  summary?: unknown;
  summaryStatus?: number;
  list?: unknown;
  detail?: PlatformLeadDetail;
  mutationStatus?: number;
  mutationError?: string;
} = {}) {
  const calls: LeadApiCall[] = [];
  let current: PlatformLeadDetail = detail;
  const mutated = (patch: Partial<PlatformLeadDetail>) => {
    current = { ...current, ...patch };
    return current;
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const path = url.split("?")[0] ?? url;
    if (path === "/api/platform/me") return jsonResponse(200, me);
    if (path === "/api/platform/leads/summary") {
      return summaryStatus === 200
        ? jsonResponse(200, summary)
        : jsonResponse(summaryStatus, { code: "leads_unavailable" });
    }
    if (path === "/api/platform/leads" && method === "GET") return jsonResponse(200, list);
    if (path === "/api/platform/tenants" && method === "GET") {
      return jsonResponse(200, { items: [TENANT_LIST_ITEM], page: 1, limit: 100, total: 1 });
    }
    if (path === `/api/platform/leads/${LEAD_ID}` && method === "GET") {
      return jsonResponse(200, current);
    }
    if (path.startsWith(`/api/platform/leads/${LEAD_ID}`) && method !== "GET") {
      if (mutationStatus !== 200) return jsonResponse(mutationStatus, { code: mutationError });
      const action = path.slice(`/api/platform/leads/${LEAD_ID}`.length);
      const payload = (body ?? {}) as Record<string, unknown>;
      if (action === "" && method === "PATCH") {
        return jsonResponse(200, mutated(payload as Partial<PlatformLeadDetail>));
      }
      if (action === "/contacted" && method === "POST") {
        return jsonResponse(
          200,
          mutated({ status: "contacted", nextTouchAt: "2026-10-27T06:00:00.000Z" }),
        );
      }
      if (action === "/link-tenant" && method === "POST") {
        return jsonResponse(
          200,
          mutated({
            tenant: {
              id: String(payload.tenantId),
              name: "Первый завод",
              cabinetAccess: "enabled",
            },
          }),
        );
      }
      if (action === "/create-tenant" && method === "POST") {
        return jsonResponse(
          200,
          mutated({
            tenant: { id: TENANT_ID, name: String(payload.tenantName), cabinetAccess: "none" },
          }),
        );
      }
      if (action === "/anonymize" && method === "POST") {
        return jsonResponse(
          200,
          mutated({
            email: null,
            name: null,
            phone: null,
            anonymizedAt: "2026-10-21T09:00:00.000Z",
          }),
        );
      }
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    writes: () => calls.filter((call) => call.method !== "GET"),
    fetchMock,
  };
}
