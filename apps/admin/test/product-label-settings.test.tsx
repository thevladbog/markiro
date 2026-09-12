import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { ShiftForm } from "../src/pages/shifts/ShiftForm.js";
import type { ProductDto } from "../src/pages/catalog/api.js";

const product: ProductDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Молоко",
  gtin14: "04006381333931",
  printName: null,
  productGroup: "Молочная продукция",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 48,
  unitPrice: null,
  egaisCode: null,
  shelfLifeDays: null,
  externalRef: null,
  status: "active",
  archived: false,
  defaultCounterpartyId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const template = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Внешняя этикетка",
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function choose(label: string, name: string) {
  const trigger = screen.getByRole("combobox", { name: label });
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  if (trigger.classList.contains("mk-combobox__trigger")) fireEvent.click(trigger);
  else
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse",
    });
  fireEvent.click(await screen.findByRole("option", { name }));
}

async function setup() {
  await i18n.changeLanguage("ru");
  const submit = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            String(url).includes("product-label-templates")
              ? { items: [template] }
              : {
                  defaultBoxLabelTemplateId: "22222222-2222-4222-8222-222222222222",
                  defaultSource: "organization",
                  validationPrintProtocol: "validation-dm-duplicate-v1",
                },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ShiftForm
        mode="create"
        products={[
          product,
          { ...product, id: "33333333-3333-4333-8333-333333333333", name: "Сыр" },
        ]}
        lines={[]}
        counterparties={[]}
        formContext={{ labelTemplates: [] }}
        onSubmit={submit}
        onDirtyChange={() => undefined}
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
  await choose("Продукт", "Молоко");
  await waitFor(() =>
    expect(screen.getByLabelText("Дублировать Data Matrix").hasAttribute("disabled")).toBe(false),
  );
  return submit;
}

it("requires explicit template selection and starts with verification required", async () => {
  const submit = await setup();
  expect(screen.getByLabelText("Без печати").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByLabelText("Дублировать Data Matrix"));
  expect(screen.getByLabelText("Обязательная проверка этикетки").getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));
  await screen.findByText("Выберите шаблон этикетки продукции");
  expect(submit).not.toHaveBeenCalled();
  await choose("Шаблон этикетки продукции", "Внешняя этикетка · 58 × 40 мм · 203 dpi");
  fireEvent.click(screen.getByLabelText("Обязательная проверка этикетки"));
  expect(
    screen.getByText("После отправки на принтер можно сканировать следующую единицу"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        validationPrint: { mode: "duplicate_dm", templateId: template.id, verification: "none" },
      }),
    ),
  );
});

it("clears duplicate selection when the product changes", async () => {
  const submit = await setup();
  fireEvent.click(screen.getByLabelText("Дублировать Data Matrix"));
  await choose("Шаблон этикетки продукции", "Внешняя этикетка · 58 × 40 мм · 203 dpi");
  await choose("Продукт", "Сыр");
  expect(
    screen.getByRole("combobox", { name: "Шаблон этикетки продукции" }).textContent,
  ).not.toContain("Внешняя этикетка");
  fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));
  await screen.findByText("Выберите шаблон этикетки продукции");
  expect(submit).not.toHaveBeenCalled();
});

it.each(["Без печати", "Агрегация"])("clears duplicate policy on %s", async (label) => {
  const submit = await setup();
  fireEvent.click(screen.getByLabelText("Дублировать Data Matrix"));
  await choose("Шаблон этикетки продукции", "Внешняя этикетка · 58 × 40 мм · 203 dpi");
  fireEvent.click(screen.getByLabelText(label));
  expect(screen.queryByLabelText("Обязательная проверка этикетки")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ validationPrint: { mode: "none" } }),
    ),
  );
});

it.each(["planned", "active"] as const)(
  "restores a %s policy and freezes the active policy",
  async (status) => {
    await i18n.changeLanguage("ru");
    const submit = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              String(url).includes("product-label-templates")
                ? { items: [template] }
                : {
                    defaultBoxLabelTemplateId: null,
                    defaultSource: null,
                    validationPrintProtocol: "validation-dm-duplicate-v1",
                  },
            ),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ShiftForm
          mode="edit"
          editStatus={status}
          initialValues={{
            productId: product.id,
            mode: "validation",
            validationPrintMode: "duplicate_dm",
            verificationRequired: false,
            productLabelTemplateId: template.id,
            boxLabelTemplateSelection: "none",
            palletLabelTemplateId: "",
            palletsEnabled: false,
          }}
          products={[product]}
          lines={[]}
          counterparties={[]}
          formContext={{ labelTemplates: [] }}
          onSubmit={submit}
          onDirtyChange={() => undefined}
          onClose={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Дублировать Data Matrix").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      screen.getByLabelText("Обязательная проверка этикетки").getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByLabelText("Обязательная проверка этикетки").hasAttribute("disabled")).toBe(
      status === "active",
    );
    if (status === "planned")
      await waitFor(() =>
        expect(
          screen
            .getByRole("combobox", { name: "Шаблон этикетки продукции" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    if (status === "active")
      expect(submit.mock.calls[0]?.[0]).not.toHaveProperty("validationPrint");
    else
      expect(submit.mock.calls[0]?.[0]).toHaveProperty("validationPrint", {
        mode: "duplicate_dm",
        templateId: template.id,
        verification: "none",
      });
  },
);

it("ignores a late template response from the previous product", async () => {
  const submit = await setup();
  const pending = new Map<string, (response: Response) => void>();
  const respond = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const id = new URL(String(url), "http://localhost").searchParams.get("productId") ?? "";
      if (String(url).includes("product-label-templates"))
        return new Promise<Response>((resolve) => {
          pending.set(id, resolve);
        });
      return respond({
        defaultBoxLabelTemplateId: null,
        defaultSource: null,
        validationPrintProtocol: "validation-dm-duplicate-v1",
      });
    }),
  );
  fireEvent.click(screen.getByLabelText("Дублировать Data Matrix"));
  await waitFor(() => expect(pending.has(product.id)).toBe(true));
  await choose("Продукт", "Сыр");
  const nextId = "33333333-3333-4333-8333-333333333333";
  await waitFor(() => expect(pending.has(nextId)).toBe(true));
  await act(async () => {
    pending.get(product.id)?.(respond({ items: [template] }));
  });
  expect(
    screen.getByRole("combobox", { name: "Шаблон этикетки продукции" }).hasAttribute("disabled"),
  ).toBe(true);
  const next = { ...template, id: "55555555-5555-4555-8555-555555555555", name: "Этикетка сыра" };
  await act(async () => {
    pending.get(nextId)?.(respond({ items: [next] }));
  });
  await choose("Шаблон этикетки продукции", "Этикетка сыра · 58 × 40 мм · 203 dpi");
  fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        validationPrint: { mode: "duplicate_dm", templateId: next.id, verification: "required" },
      }),
    ),
  );
});
