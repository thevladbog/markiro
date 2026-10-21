import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router";
import i18n from "../src/i18n/index.js";
import { LeadJournal } from "../src/pages/leads/LeadJournal.js";

const TENANT_ID = "81111111-1111-4111-8111-111111111111";
const SITE_ID = "a1111111-1111-4111-8111-111111111111";
const actor = { id: "platform-admin", name: "Оператор платформы" };

afterEach(() => cleanup());

describe("lead journal: the activation request of a site (spec 2026-10-20 §15.6)", () => {
  it("names the activation request and the automatic link and status, with no raw keys", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <LeadJournal
            events={[
              {
                id: "e1",
                kind: "status_change",
                payload: { from: "new", to: "trial", via: "activation_request" },
                actor,
                createdAt: "2026-10-21T09:00:00.000Z",
              },
              {
                id: "e2",
                kind: "activation_request",
                payload: {
                  tenantId: TENANT_ID,
                  siteId: SITE_ID,
                  hostId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
                  intent: "create",
                },
                actor,
                createdAt: "2026-10-21T09:00:00.000Z",
              },
              {
                id: "e3",
                kind: "linked_tenant",
                payload: {
                  tenantId: TENANT_ID,
                  created: false,
                  previousTenantId: null,
                  via: "activation_request",
                },
                actor,
                createdAt: "2026-10-21T09:00:00.000Z",
              },
            ]}
          />
        </MemoryRouter>
      </I18nextProvider>,
    );
    const entries = within(screen.getByRole("list", { name: "Журнал заявки" })).getAllByRole(
      "listitem",
    );
    expect(entries[0]?.textContent).toContain("Новая → Пробный период");
    expect(entries[0]?.textContent).toContain("Автоматически по запросу активации площадки.");
    expect(entries[1]?.textContent).toContain("Запрос активации");
    expect(entries[1]?.textContent).toContain("Площадка зарегистрирована из запроса активации.");
    expect(
      within(entries[1] as HTMLElement)
        .getByRole("link", { name: "Открыть клиента" })
        .getAttribute("href"),
    ).toBe(`/tenants/${TENANT_ID}`);
    expect(entries[2]?.textContent).toContain("Автоматически по запросу активации площадки.");
    for (const entry of entries) {
      expect(entry.textContent).not.toMatch(/via|siteId|hostId|intent|activation_request/u);
    }
  });
});
