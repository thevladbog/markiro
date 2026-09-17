import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { ProductForm, type ProductFormValues } from "../src/pages/catalog/ProductForm.js";

const values: ProductFormValues = {
  gtin: "04006381333931",
  name: "Молоко",
  printName: "",
  chzProductGroupCode: "8",
  boxCapacity: "12",
  palletBoxCapacity: "48",
  unitPrice: "",
  egaisCode: "",
  shelfLifeDays: "30",
  defaultCounterpartyId: "",
  archived: false,
};

function mount(onRegulatoryBlockChange = vi.fn()) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AccessProvider
        value={{
          roles: ["manager"],
          capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
        }}
      >
        <MemoryRouter>
          <ProductForm
            mode="edit"
            initialValues={values}
            counterparties={[]}
            regulatoryContent={<h3>Данные карточки ЧЗ</h3>}
            onRegulatoryBlockChange={onRegulatoryBlockChange}
            onSubmit={vi.fn()}
            onClose={vi.fn()}
          />
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onRegulatoryBlockChange };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("keeps basic and Chestny ZNAK fields in separate accessible tabs", async () => {
  const { user } = mount();
  expect(screen.getByRole("tab", { name: "Основное" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("heading", { name: "Данные карточки ЧЗ" })).toBeNull();

  await user.click(screen.getByRole("tab", { name: "Честный знак" }));

  expect(screen.getByRole("heading", { name: "Данные карточки ЧЗ" })).toBeDefined();
  expect(screen.queryByRole("textbox", { name: "Название" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
});

it("blocks regulatory editing only after GTIN or product group changes", async () => {
  const onRegulatoryBlockChange = vi.fn();
  const { user } = mount(onRegulatoryBlockChange);

  await user.clear(screen.getByLabelText("Название"));
  await user.type(screen.getByLabelText("Название"), "Молоко новое");
  expect(onRegulatoryBlockChange).toHaveBeenLastCalledWith(false);

  await user.clear(screen.getByLabelText("ГТИН"));
  await user.type(screen.getByLabelText("ГТИН"), "04680089900024");
  expect(onRegulatoryBlockChange).toHaveBeenLastCalledWith(true);
});
