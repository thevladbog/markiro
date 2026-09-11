import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PLATFORM_ADMIN_ME, jsonResponse, renderSaasApp } from "./render.js";

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const CREATED = {
  agreement: {
    id: "3f2a5c9e-1d6b-4a2f-9c31-5b7e8d0a4c11",
    number: "МКР-2026-0001",
    status: "draft",
    documentForm: "ru_en",
    counterpartyName: "ООО «Пример»",
    counterpartyInn: "7701234567",
    conclusionDate: null,
    tenantId: null,
    signedAt: null,
    createdAt: "2026-09-11T10:00:00.000Z",
    city: null,
    counterparty: {
      kind: "legal_entity",
      name: "ООО «Пример»",
      inn: "7701234567",
      kpp: "770101001",
      ogrn: "1027700000000",
      address: null,
      email: null,
      phone: null,
      bankName: null,
      bic: null,
      settlementAccount: null,
      correspondentAccount: null,
    },
    contractor: {
      kind: "sole_proprietor",
      name: "ИП Богатырев Владислав Сергеевич",
      inn: "233902446763",
      ogrnip: "324237500123456",
      address: null,
      email: null,
      phone: null,
      bankName: null,
      bic: null,
      settlementAccount: null,
      correspondentAccount: null,
    },
    signatory: { position: null, fullName: null, authorityBasis: null },
    terms: { disputeVenue: null, penaltyRatePercent: null, penaltyCapPercent: null },
    terminatedAt: null,
    terminationReason: null,
    editable: true,
    documents: [],
  },
};

describe("creating an agreement", () => {
  it("sends the chosen document form to the platform API", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const method = init.method ?? "GET";
        if (path.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (path.endsWith("/api/platform/agreements") && method === "POST") {
          bodies.push(JSON.parse(String(init.body)));
          return jsonResponse(201, CREATED);
        }
        return jsonResponse(200, {});
      }),
    );

    renderSaasApp({ initialEntry: "/agreements/new" });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Наименование"), "ООО «Пример»");
    await user.type(screen.getByLabelText("ИНН"), "7701234567");
    await user.type(screen.getByLabelText("КПП"), "770101001");
    await user.type(screen.getByLabelText("ОГРН"), "1027700000000");
    await user.selectOptions(screen.getByLabelText("Форма документа"), "ru_en");
    await user.click(screen.getByRole("button", { name: /Создать договор/i }));

    // The page, not just the field: a select whose value never reaches the
    // request body would pass a component test and still ship a broken form.
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ documentForm: "ru_en" });
  });

  it("defaults to the Russian form when the operator does not choose", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input);
        const method = init.method ?? "GET";
        if (path.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (path.endsWith("/api/platform/agreements") && method === "POST") {
          bodies.push(JSON.parse(String(init.body)));
          return jsonResponse(201, { agreement: { ...CREATED.agreement, documentForm: "ru" } });
        }
        return jsonResponse(200, {});
      }),
    );

    renderSaasApp({ initialEntry: "/agreements/new" });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Наименование"), "ООО «Пример»");
    await user.type(screen.getByLabelText("ИНН"), "7701234567");
    await user.type(screen.getByLabelText("КПП"), "770101001");
    await user.type(screen.getByLabelText("ОГРН"), "1027700000000");
    await user.click(screen.getByRole("button", { name: /Создать договор/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ documentForm: "ru" });
  });
});
