import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_ADMIN_ME,
  TENANT_DETAIL,
  TENANT_ID,
  jsonResponse,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const AGREEMENT_ID = "3f2a5c9e-1d6b-4a2f-9c31-5b7e8d0a4c11";

const legalEntity = {
  kind: "legal_entity",
  name: "ООО «Атолл»",
  inn: "2304012345",
  kpp: "230401001",
  ogrn: "1022300000000",
  address: "Геленджик, ул. Революционная, 1",
  email: null,
  phone: null,
  bankName: "АО «Банк Точка»",
  bic: "044525104",
  settlementAccount: "40702810000000000001",
  correspondentAccount: "30101810745374525104",
};

function detail(over: Record<string, unknown> = {}) {
  return {
    agreement: {
      id: AGREEMENT_ID,
      number: "MRK-LLC-2026/002",
      status: "signed",
      documentForm: "ru_en",
      counterpartyName: "ООО «Атолл»",
      counterpartyInn: "2304012345",
      conclusionDate: "2026-09-23",
      tenantId: TENANT_ID,
      signedAt: "2026-09-23T12:00:00.000Z",
      createdAt: "2026-09-20T10:00:00.000Z",
      city: null,
      counterparty: legalEntity,
      contractor: { ...legalEntity, kind: "legal_entity" },
      signatory: { position: null, fullName: null, authorityBasis: null },
      terms: { disputeVenue: null, penaltyRatePercent: null, penaltyCapPercent: null },
      terminatedAt: null,
      terminationReason: null,
      editable: false,
      documents: [
        {
          id: "a1d4e0b2-1f3c-4d5e-8a6b-9c0d1e2f3a4b",
          kind: "attachment",
          filename: "Договор_MRK_LLC_2026_001.pdf",
          mediaType: "application/pdf",
          sha256: "a".repeat(64),
          byteSize: 482_000,
          stale: false,
          createdAt: "2026-09-23T10:00:00.000Z",
        },
      ],
      ...over,
    },
  };
}

function stubApi(agreement: ReturnType<typeof detail>, calls: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      const method = init.method ?? "GET";
      if (path.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
      if (path.endsWith(`/api/platform/tenants/${TENANT_ID}`)) {
        return jsonResponse(200, TENANT_DETAIL);
      }
      if (path.endsWith("/tenant-candidates")) {
        return jsonResponse(200, {
          candidates: [{ tenantId: TENANT_ID, name: "Первый завод", inn: "2304012345" }],
        });
      }
      if (method !== "GET") calls.push(`${method} ${path}`);
      if (path.includes("/api/platform/agreements/")) return jsonResponse(200, agreement);
      return jsonResponse(200, {});
    }),
  );
}

async function openDetail() {
  renderSaasApp({ initialEntry: `/agreements/${AGREEMENT_ID}` });
  await screen.findByRole("heading", { level: 1, name: "MRK-LLC-2026/002" }, { timeout: 5_000 });
}

describe("agreement detail page", () => {
  it("shows the tenant by name as a link instead of its id", async () => {
    stubApi(detail());
    await openDetail();
    const links = await screen.findAllByRole("link", { name: "Первый завод" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute("href")).toBe(`/tenants/${TENANT_ID}`);
    expect(screen.queryByText(TENANT_ID)).toBeNull();
    expect(screen.getByRole("link", { name: "Открыть тенанта" }).getAttribute("href")).toBe(
      `/tenants/${TENANT_ID}`,
    );
  });

  it("renders a signed agreement's requisites as read-only text, not inputs", async () => {
    stubApi(detail());
    await openDetail();
    expect(await screen.findByText("Геленджик, ул. Революционная, 1")).toBeDefined();
    expect(screen.queryByLabelText("Наименование")).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить изменения" })).toBeNull();
  });

  it("keeps the termination reason out of the page until the dialog asks for it", async () => {
    const calls: string[] = [];
    stubApi(detail(), calls);
    await openDetail();
    const user = userEvent.setup();
    expect(screen.queryByLabelText("Основание прекращения")).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Прекратить" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Прекратить" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText("Основание прекращения"), "По соглашению");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(confirm);
    await waitFor(() => expect(calls.some((call) => call.endsWith("/transition"))).toBe(true));
  });

  it("asks before unlinking the tenant", async () => {
    const calls: string[] = [];
    stubApi(detail(), calls);
    await openDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Отвязать" }));
    expect(calls).toHaveLength(0);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Отвязать" }));
    await waitFor(() => expect(calls.some((call) => call.startsWith("DELETE"))).toBe(true));
  });

  it("offers an editable form for a draft and a candidate picker without a tenant", async () => {
    stubApi(detail({ status: "draft", editable: true, tenantId: null, documents: [] }));
    await openDetail();
    expect(await screen.findByLabelText("Наименование")).toBeDefined();
    expect(screen.getByText("Тенант не привязан", { selector: "p" })).toBeDefined();
    expect(await screen.findByText("Документов пока нет.")).toBeDefined();
  });

  it("confirms before deleting an attachment", async () => {
    const calls: string[] = [];
    stubApi(detail(), calls);
    await openDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Удалить" }));
    expect(calls).toHaveLength(0);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(calls.some((call) => call.startsWith("DELETE"))).toBe(true));
  });
});

describe("agreements list", () => {
  it("links each tenant by name and mutes the unlinked ones", async () => {
    const { agreement } = detail();
    const summary = (id: string, tenantId: string | null) => ({
      id,
      number: `MRK-${id.slice(0, 1)}`,
      status: agreement.status,
      documentForm: agreement.documentForm,
      counterpartyName: agreement.counterpartyName,
      counterpartyInn: agreement.counterpartyInn,
      conclusionDate: agreement.conclusionDate,
      tenantId,
      signedAt: agreement.signedAt,
      createdAt: agreement.createdAt,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (path.endsWith(`/api/platform/tenants/${TENANT_ID}`)) {
          return jsonResponse(200, TENANT_DETAIL);
        }
        if (path.includes("/api/platform/agreements")) {
          return jsonResponse(200, {
            agreements: [
              summary("a1d4e0b2-1f3c-4d5e-8a6b-9c0d1e2f3a4b", TENANT_ID),
              summary("b1d4e0b2-1f3c-4d5e-8a6b-9c0d1e2f3a4b", null),
            ],
          });
        }
        return jsonResponse(200, {});
      }),
    );
    renderSaasApp({ initialEntry: "/agreements" });
    const link = await screen.findByRole("link", { name: "Первый завод" }, { timeout: 5_000 });
    expect(link.getAttribute("href")).toBe(`/tenants/${TENANT_ID}`);
    expect(screen.getByText("Тенант не привязан")).toBeDefined();
  });
});
