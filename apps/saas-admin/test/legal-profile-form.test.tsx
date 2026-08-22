import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";
import type {
  BillingProfileInput,
  DadataAddressSuggestion,
  OperatorBillingProfileInput,
} from "@markiro/platform-contracts";

import { LegalProfileForm } from "../src/pages/legal/LegalProfileForm";
import i18n from "../src/i18n/index";
import { jsonResponse } from "./render";

const ACTUAL_ADDRESS: DadataAddressSuggestion = {
  value: "г Москва, ул Тверская, д 2",
  fiasId: "7710010010000010002",
  kladrId: "77000000000000200",
  postalCode: "125009",
  region: "Москва",
  city: "Москва",
  settlement: null,
  street: "Тверская",
  house: "2",
  block: null,
  flat: null,
  latitude: "55.757",
  longitude: "37.613",
  qualityCode: "0",
  completenessCode: "0",
};

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

function renderForm(
  scope: "operator" | "tenant" = "tenant",
  onSave: Mock<(input: BillingProfileInput | OperatorBillingProfileInput) => Promise<void>> = vi.fn(
    async (_input: BillingProfileInput | OperatorBillingProfileInput) => undefined,
  ),
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider defaultTheme="light">
      <QueryClientProvider client={queryClient}>
        <LegalProfileForm scope={scope} profile={null} canWrite onSave={onSave} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return onSave;
}

describe("LegalProfileForm", () => {
  it("lets an operator save an individual with person labels and no legal-entity identifiers", async () => {
    const save = renderForm("operator");
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Тип плательщика"), "individual");
    expect((screen.getByLabelText("Тип плательщика") as HTMLSelectElement).value).toBe(
      "individual",
    );
    expect(screen.getByLabelText("ФИО")).toBeDefined();
    expect(screen.getByLabelText("Адрес регистрации")).toBeDefined();
    expect(screen.queryByLabelText("КПП")).toBeNull();
    expect(screen.queryByLabelText("ОГРН")).toBeNull();

    await user.type(screen.getByLabelText("ФИО"), "Иванов Иван Иванович");
    await user.type(screen.getByLabelText("Краткое наименование"), "Иванов И. И.");
    await user.type(screen.getByLabelText("Адрес регистрации"), "Москва, Тверская, 1");
    await user.click(screen.getByLabelText("Реквизиты проверены по документам"));
    await user.click(screen.getByRole("button", { name: "Сохранить и подтвердить" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      kind: "individual",
      actualAddress: { sameAsLegal: true },
    });
  });

  it("preserves an actual-address draft across equality and kind changes and maps its selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { status: "ready", items: [ACTUAL_ADDRESS] })),
    );
    const save = renderForm();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Тип плательщика"), "individual");
    await user.type(screen.getByLabelText("ФИО"), "Иванов Иван Иванович");
    await user.type(screen.getByLabelText("Краткое наименование"), "Иванов И. И.");
    await user.type(screen.getByLabelText("Адрес регистрации"), "Москва, Тверская, 1");
    await user.click(screen.getByLabelText("Фактический адрес совпадает с адресом регистрации"));
    await user.type(screen.getByLabelText("Фактический адрес"), "Твер");
    await user.click(await screen.findByRole("option", { name: ACTUAL_ADDRESS.value }));

    await user.selectOptions(screen.getByLabelText("Тип плательщика"), "legal_entity");
    await user.selectOptions(screen.getByLabelText("Тип плательщика"), "individual");
    expect((screen.getByLabelText("Фактический адрес") as HTMLInputElement).value).toBe(
      ACTUAL_ADDRESS.value,
    );

    await user.click(screen.getByLabelText("Фактический адрес совпадает с адресом регистрации"));
    expect(screen.queryByLabelText("Фактический адрес")).toBeNull();
    await user.click(screen.getByLabelText("Фактический адрес совпадает с адресом регистрации"));
    expect((screen.getByLabelText("Фактический адрес") as HTMLInputElement).value).toBe(
      ACTUAL_ADDRESS.value,
    );

    await user.click(screen.getByLabelText("Реквизиты проверены по документам"));
    await user.click(screen.getByRole("button", { name: "Сохранить и подтвердить" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      actualAddress: {
        sameAsLegal: false,
        raw: ACTUAL_ADDRESS.value,
        normalized: ACTUAL_ADDRESS,
      },
      postalAddress: { sameAsLegal: true },
    });
  });

  it("uses English person labels for self-employed and individual kinds", async () => {
    await i18n.changeLanguage("en");
    renderForm();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Payer type"), "self_employed");
    expect(screen.getByLabelText("Full name")).toBeDefined();
    expect(screen.getByLabelText("Registration address")).toBeDefined();
  });

  it("supports every tenant profile kind and requires explicit confirmation before saving", async () => {
    const save = renderForm();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Тип плательщика"), "sole_proprietor");
    expect(screen.getByLabelText("ОГРНИП")).toBeDefined();
    expect(screen.queryByLabelText("КПП")).toBeNull();

    await user.type(screen.getByLabelText("Полное наименование"), "ИП Иванов Иван Иванович");
    await user.type(screen.getByLabelText("Краткое наименование"), "ИП Иванов");
    await user.type(screen.getByLabelText("ИНН"), "123456789012");
    await user.type(screen.getByLabelText("ОГРНИП"), "123456789012345");
    await user.type(screen.getByLabelText("Юридический адрес"), "Москва, Тверская, 1");

    await user.click(screen.getByRole("button", { name: "Сохранить и подтвердить" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Подтвердите корректность реквизитов")).toBeDefined();

    await user.click(screen.getByLabelText("Реквизиты проверены по документам"));
    await user.click(screen.getByRole("button", { name: "Сохранить и подтвердить" }));
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      kind: "sole_proprietor",
      displayName: "ИП Иванов",
      postalAddress: { sameAsLegal: true },
    });
  });
});
