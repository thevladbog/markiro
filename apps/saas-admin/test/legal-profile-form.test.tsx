import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";
import type { BillingProfileInput } from "@markiro/platform-contracts";

import { LegalProfileForm } from "../src/pages/legal/LegalProfileForm";
import "../src/i18n/index";

afterEach(() => cleanup());

function renderForm(
  onSave: Mock<(input: BillingProfileInput) => Promise<void>> = vi.fn(
    async (_input: BillingProfileInput) => undefined,
  ),
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider defaultTheme="light">
      <QueryClientProvider client={queryClient}>
        <LegalProfileForm scope="tenant" profile={null} canWrite onSave={onSave} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return onSave;
}

describe("LegalProfileForm", () => {
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
