import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";
import type { BillingProfileInput, OperatorBillingProfileInput } from "@markiro/platform-contracts";

import { LegalProfileForm } from "../src/pages/legal/LegalProfileForm";
import "../src/i18n/index";

afterEach(() => cleanup());

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

  it("maps a separate actual address independently from the postal address", async () => {
    const save = renderForm();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("Тип плательщика"), "individual");
    await user.type(screen.getByLabelText("ФИО"), "Иванов Иван Иванович");
    await user.type(screen.getByLabelText("Краткое наименование"), "Иванов И. И.");
    await user.type(screen.getByLabelText("Адрес регистрации"), "Москва, Тверская, 1");
    await user.click(screen.getByLabelText("Фактический адрес совпадает с адресом регистрации"));
    await user.type(screen.getByLabelText("Фактический адрес"), "Москва, Тверская, 2");
    await user.click(screen.getByLabelText("Реквизиты проверены по документам"));
    await user.click(screen.getByRole("button", { name: "Сохранить и подтвердить" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      actualAddress: {
        sameAsLegal: false,
        raw: "Москва, Тверская, 2",
        normalized: null,
      },
      postalAddress: { sameAsLegal: true },
    });

    await user.click(screen.getByLabelText("Фактический адрес совпадает с адресом регистрации"));
    expect(screen.queryByLabelText("Фактический адрес")).toBeNull();
    await user.click(screen.getByLabelText("Реквизиты проверены по документам"));
    await user.click(screen.getByRole("button", { name: "Сохранить и подтвердить" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[0]).toMatchObject({ actualAddress: { sameAsLegal: true } });
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
