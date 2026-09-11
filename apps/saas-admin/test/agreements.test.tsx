import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ThemeProvider } from "@markiro/ui";
import { AGREEMENT_TRANSITIONS } from "@markiro/platform-contracts";

import {
  AgreementRequisitesForm,
  EMPTY_REQUISITES,
  fromRequisites,
  toRequisitesInput,
  type RequisitesDraft,
} from "../src/pages/agreements/AgreementRequisitesForm";
import "../src/i18n/index";

afterEach(cleanup);

function renderForm(value: RequisitesDraft, disabled = false) {
  const onChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider defaultTheme="light">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AgreementRequisitesForm value={value} onChange={onChange} disabled={disabled} />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return onChange;
}

describe("AgreementRequisitesForm", () => {
  it("keeps a manual edit after a suggestion filled the same field", async () => {
    const onChange = renderForm({ ...EMPTY_REQUISITES, name: "ООО «Из DaData»" });
    const user = userEvent.setup();
    const nameField = screen.getByLabelText("Наименование");
    await user.type(nameField, "!");
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0] as RequisitesDraft;
    expect(last.name).toBe("ООО «Из DaData»!");
  });

  it("shows КПП and ОГРН for an organisation only", () => {
    renderForm({ ...EMPTY_REQUISITES, kind: "legal_entity" });
    expect(screen.getByLabelText("КПП")).toBeDefined();
    expect(screen.getByLabelText("ОГРН")).toBeDefined();
    expect(screen.queryByLabelText("ОГРНИП")).toBeNull();
  });

  it("shows ОГРНИП instead for a sole proprietor", () => {
    renderForm({ ...EMPTY_REQUISITES, kind: "sole_proprietor" });
    expect(screen.queryByLabelText("КПП")).toBeNull();
    expect(screen.getByLabelText("ОГРНИП")).toBeDefined();
  });

  it("disables every control and hides the suggest fields when read-only", () => {
    renderForm({ ...EMPTY_REQUISITES, name: "ООО «Пример»" }, true);
    expect((screen.getByLabelText("Наименование") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("ИНН") as HTMLInputElement).disabled).toBe(true);
    // A signed agreement must not offer a DaData lookup that could refill it.
    expect(screen.queryByLabelText("Поиск организации")).toBeNull();
  });
});

describe("requisites shaping", () => {
  it("drops empty optional fields to null and keeps the discriminant", () => {
    const shaped = toRequisitesInput({
      ...EMPTY_REQUISITES,
      kind: "legal_entity",
      name: "  ООО «Пример»  ",
      inn: "7701234567",
      kpp: "770101001",
      ogrn: "1027700000000",
    }) as Record<string, unknown>;
    expect(shaped.kind).toBe("legal_entity");
    expect(shaped.name).toBe("ООО «Пример»");
    expect(shaped.bic).toBeNull();
    expect(shaped.settlementAccount).toBeNull();
  });

  it("round-trips a stored counterparty back into the draft", () => {
    const draft = fromRequisites({
      kind: "sole_proprietor",
      name: "ИП Иванов",
      inn: "770123456789",
      ogrnip: "312770000000001",
      address: null,
      email: null,
      phone: null,
      bankName: null,
      bic: null,
      settlementAccount: null,
      correspondentAccount: null,
    });
    expect(draft.ogrnip).toBe("312770000000001");
    expect(draft.kpp).toBe("");
    expect(draft.address).toBe("");
  });
});

describe("transition table", () => {
  it("never offers a way back from signed", () => {
    expect(AGREEMENT_TRANSITIONS.signed).toEqual(["terminated"]);
    expect(AGREEMENT_TRANSITIONS.terminated).toEqual([]);
  });

  it("lets the editable statuses move among themselves", () => {
    expect(AGREEMENT_TRANSITIONS.sent).toContain("draft");
    expect(AGREEMENT_TRANSITIONS.sent).toContain("signed");
  });
});
