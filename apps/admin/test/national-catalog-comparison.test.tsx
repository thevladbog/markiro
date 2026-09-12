import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import "../src/i18n/index.js";
import { ImportReview } from "../src/pages/catalog/national-catalog/ImportReview.js";
import { id, previewFixture } from "./national-catalog-fixtures.js";

afterEach(cleanup);

it.each([
  [
    "attribute_not_importable",
    "Для этого поля не настроен перенос из Честного знака. Значение можно посмотреть в карточке и заполнить в Markiro вручную.",
  ],
  [
    "compatible_schema_required",
    "Перенос характеристик недоступен: нужна категория с настроенным сопоставлением Честного знака.",
  ],
])("explains the actual import restriction for %s", (reason, message) => {
  const { props, preview } = review(false);
  preview.fields.push({
    id: id(42),
    label: "Код продукции в ЕГАИС",
    before: null,
    after: "0300005753630000036",
    applicable: false,
    reason,
    source: "national_catalog",
    selectedByDefault: false,
    requiresEntryIds: [],
  });
  render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const field = screen.getByRole("group", { name: "Код продукции в ЕГАИС" });
  expect(within(field).getByText(message)).toBeDefined();
  expect(within(field).getByText("0300005753630000036")).toBeDefined();
  expect(screen.queryByText("Поле пока недоступно. Проверьте категорию и значение.")).toBeNull();
});

function review(existing = true) {
  const data = structuredClone(previewFixture);
  const preview = data.items[0]!;
  preview.productId = existing ? id(21) : null;
  preview.fields[0]!.before = existing ? "Молоко фермерское" : null;
  const onApply = vi.fn();
  const props = {
    sessionId: id(1),
    data,
    canWrite: true,
    busy: false,
    onPrepare: vi.fn(),
    onApply,
    onPhoto: vi.fn(),
    onRetry: vi.fn(),
  };
  return { props, preview, onApply };
}

it("chooses either whole value cell without writing until Apply", async () => {
  const { props, onApply } = review();
  render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const user = userEvent.setup();
  const row = screen.getByRole("group", { name: "Название товара" });
  const current = within(row).getByRole("radio", {
    name: /Сейчас в Markiro/,
    description: /Молоко фермерское/,
  });
  const proposed = within(row).getByRole("radio", { name: /Предлагаемое значение/ });
  expect((current as HTMLInputElement).checked).toBe(true);
  await user.click(within(row).getByText("Молоко", { exact: true }));
  expect((proposed as HTMLInputElement).checked).toBe(true);
  expect((current as HTMLInputElement).checked).toBe(false);
  expect(onApply).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
  expect(onApply.mock.calls[0]?.[0][0].acceptedEntryIds).toEqual([id(13)]);
  await user.click(within(row).getByText("Молоко фермерское"));
  await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
  expect(onApply.mock.calls[1]?.[0][0].acceptedEntryIds).toEqual([]);
});

it("clears dependent proposed cells when retaining the current category", async () => {
  const { props, preview, onApply } = review();
  preview.fields.push(
    {
      ...preview.fields[0]!,
      id: id(40),
      label: "Категория",
      labelKey: "category",
      selectedByDefault: false,
      before: null,
      after: "Молочная продукция",
    },
    {
      ...preview.fields[0]!,
      id: id(41),
      label: "Жирность",
      before: null,
      after: "3,2 %",
      requiresEntryIds: [id(40)],
    },
  );
  delete preview.fields[2]!.labelKey;
  render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const user = userEvent.setup();
  const category = screen.getByRole("group", { name: "Категория" });
  const fat = screen.getByRole("group", { name: "Жирность" });
  const incoming = within(fat).getByRole("radio", { name: /Предлагаемое значение/ });
  expect(incoming.hasAttribute("disabled")).toBe(true);
  expect(within(fat).getByText(/Сначала выберите/)).toBeTruthy();
  await user.click(within(category).getByRole("radio", { name: /Предлагаемое значение/ }));
  await user.click(incoming);
  await user.click(within(category).getByRole("radio", { name: /Сейчас в Markiro/ }));
  expect(
    (within(fat).getByRole("radio", { name: /Сейчас в Markiro/ }) as HTMLInputElement).checked,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
  expect(onApply.mock.calls[0]?.[0][0].acceptedEntryIds).toEqual([]);
});

it("preserves required-name validation for a new product and read-only restrictions", async () => {
  const { props } = review(false);
  const view = render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const current = screen.getByRole("radio", { name: /Название товара.*Сейчас в Markiro/ });
  await userEvent.setup().click(current);
  expect(screen.getByRole("button", { name: "Применить выбранное" }).hasAttribute("disabled")).toBe(
    true,
  );
  view.rerender(<ImportReview {...props} canWrite={false} />);
  for (const radio of screen.getAllByRole("radio"))
    expect(radio.hasAttribute("disabled")).toBe(true);
});

it("keeps photo viewing separate from selection and retains the viewed-photo receipt", async () => {
  const { props, preview, onApply } = review();
  preview.photos = [
    {
      candidateId: id(30),
      state: "ready",
      previewPath: null,
      primary: true,
      selectedByDefault: true,
      reason: null,
    },
  ];
  render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const user = userEvent.setup();
  const keep = screen.getByRole("radio", { name: "Сохранить текущее фото" });
  expect((keep as HTMLInputElement).checked).toBe(true);
  fireEvent.load(screen.getByRole("img", { name: "Подготовленное фото товара" }));
  expect((keep as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole("radio", { name: "Выбрать это фото" }));
  await user.click(keep);
  await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
  expect(onApply.mock.calls[0]?.[0][0].photo).toEqual({
    kind: "keep",
    reviewedCandidateId: id(30),
  });
});

it("reviews one product at a time and applies choices from every tab", async () => {
  const { props, preview, onApply } = review();
  const second = structuredClone(preview);
  second.id = id(50);
  second.itemId = id(51);
  second.productId = null;
  second.identity.name = "Кефир";
  second.fields[0]!.id = id(52);
  second.fields[0]!.after = "Кефир";
  props.data.items.push(second);
  render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const user = userEvent.setup();
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  expect(screen.queryByRole("group", { name: /· Кефир/ })).toBeNull();
  await user.click(screen.getByRole("radio", { name: /Название товара.*Предлагаемое/ }));
  await user.click(screen.getByRole("tab", { name: /Кефир/ }));
  expect(screen.queryByRole("group", { name: /· Молоко/ })).toBeNull();
  await user.click(screen.getByRole("radio", { name: /Название товара.*Сейчас/ }));
  await user.click(screen.getByRole("tab", { name: /Молоко/ }));
  expect(
    screen
      .getByRole("radio", { name: /Название товара.*Предлагаемое/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByRole("tab", { name: /Кефир.*Требует выбора/ })).toBeDefined();
  expect(screen.getByRole("button", { name: "Применить выбранное" }).hasAttribute("disabled")).toBe(
    true,
  );
  await user.click(screen.getByRole("tab", { name: /Кефир/ }));
  await user.click(screen.getByRole("radio", { name: /Название товара.*Предлагаемое/ }));
  await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
  expect(onApply).toHaveBeenCalledWith([
    {
      previewId: id(12),
      acceptedEntryIds: [id(13)],
      linkAction: "attach",
      photo: { kind: "keep" },
    },
    {
      previewId: id(50),
      acceptedEntryIds: [id(52)],
      linkAction: "attach",
      photo: { kind: "keep" },
    },
  ]);
});

it("keeps tab, drafts and matching choices through a new preparation without submitting stale IDs", async () => {
  const { props, preview, onApply } = review();
  preview.linkAction = "replace";
  preview.categoryOptions = [{ optionId: id(40), label: "Молочная продукция", selected: false }];
  preview.photos = [
    {
      candidateId: id(30),
      state: "ready",
      previewPath: null,
      primary: true,
      selectedByDefault: true,
      reason: null,
    },
  ];
  const second = structuredClone(preview);
  second.id = id(50);
  second.itemId = id(51);
  second.identity.name = "Кефир";
  second.linkAction = "attach";
  second.fields[0]!.id = id(52);
  props.data.items.push(second);
  const view = render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: /Название товара.*Предлагаемое/ }));
  await user.click(screen.getByRole("checkbox", { name: /Подтверждаю замену/ }));
  await user.click(screen.getByRole("radio", { name: "Сохранить текущее фото" }));
  await user.type(screen.getByLabelText("Название вручную"), "Моё название");
  await user.click(screen.getByRole("combobox", { name: "Начальная категория" }));
  await user.type(screen.getByRole("searchbox", { name: "Поиск категории" }), "Молочная");
  await user.click(screen.getByRole("option", { name: "Молочная продукция" }));
  await user.click(screen.getByRole("tab", { name: /Кефир/ }));
  const refreshed = structuredClone(props.data);
  refreshed.preparation.id = id(60);
  refreshed.items[0]!.id = id(61);
  refreshed.items[0]!.fields[0]!.id = id(62);
  refreshed.items[1]!.id = id(63);
  refreshed.items[1]!.fields[0]!.id = id(64);
  view.rerender(<ImportReview {...props} data={refreshed} />);
  expect(screen.getByRole("tab", { name: /Кефир/ }).getAttribute("aria-selected")).toBe("true");
  await user.click(screen.getByRole("tab", { name: /Молоко/ }));
  expect((screen.getByLabelText("Название вручную") as HTMLInputElement).value).toBe(
    "Моё название",
  );
  expect(screen.getByRole("combobox", { name: "Начальная категория" }).textContent).toContain(
    "Молочная продукция",
  );
  expect(
    screen.getByRole("checkbox", { name: /Подтверждаю замену/ }).getAttribute("aria-checked"),
  ).toBe("false");
  expect(screen.getByRole("button", { name: "Применить выбранное" }).hasAttribute("disabled")).toBe(
    true,
  );
  await user.click(screen.getByRole("checkbox", { name: /Подтверждаю замену/ }));
  await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
  expect(onApply).toHaveBeenCalledWith([
    {
      previewId: id(61),
      acceptedEntryIds: [id(62)],
      linkAction: "replace",
      photo: { kind: "keep" },
    },
    { previewId: id(63), acceptedEntryIds: [], linkAction: "attach", photo: { kind: "keep" } },
  ]);
});

it("does not carry accepted values or photo receipts onto changed provider data", async () => {
  const { props, preview, onApply } = review();
  preview.photos = [
    {
      candidateId: id(30),
      state: "ready",
      previewPath: null,
      primary: true,
      selectedByDefault: true,
      reason: null,
    },
  ];
  const view = render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const user = userEvent.setup();
  await user.click(screen.getByRole("radio", { name: /Название товара.*Предлагаемое/ }));
  fireEvent.load(screen.getByRole("img", { name: "Подготовленное фото товара" }));
  await user.click(screen.getByRole("radio", { name: "Выбрать это фото" }));
  const refreshed = structuredClone(props.data);
  refreshed.preparation.id = id(60);
  refreshed.items[0]!.id = id(61);
  refreshed.items[0]!.fields[0]!.id = id(62);
  refreshed.items[0]!.fields[0]!.after = "Другое название";
  refreshed.items[0]!.photos[0]!.candidateId = id(63);
  view.rerender(<ImportReview {...props} data={refreshed} />);
  expect(
    screen.getByRole("radio", { name: /Название товара.*Сейчас/ }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByRole("radio", { name: "Сохранить текущее фото" }).getAttribute("aria-checked"),
  ).toBe("true");
  await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
  expect(onApply).toHaveBeenCalledWith([
    { previewId: id(61), acceptedEntryIds: [], linkAction: "attach", photo: { kind: "keep" } },
  ]);
});

it("filters only unmapped fields across tabs without changing the batch decisions", async () => {
  const { props, preview, onApply } = review();
  preview.categoryOptions = [{ optionId: id(40), label: "Молочная продукция", selected: false }];
  preview.fields.push({
    id: id(41),
    label: "Несопоставленная характеристика",
    before: null,
    after: "Значение из ЧЗ",
    applicable: false,
    reason: "attribute_not_importable",
    source: "national_catalog",
    selectedByDefault: false,
    requiresEntryIds: [],
  });
  const second = structuredClone(preview);
  second.id = id(50);
  second.itemId = id(51);
  second.identity.name = "Кефир";
  second.fields[0]!.id = id(52);
  second.fields[1]!.id = id(53);
  props.data.items.push(second);
  render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const user = userEvent.setup();
  const filter = screen.getByRole("checkbox", { name: "Отображать только сопоставимые поля" });
  expect(filter.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("group", { name: "Несопоставленная характеристика" })).toBeDefined();
  await user.click(screen.getByRole("radio", { name: /Название товара.*Предлагаемое/ }));
  await user.click(filter);
  expect(screen.queryByRole("group", { name: "Несопоставленная характеристика" })).toBeNull();
  expect(screen.getByLabelText("Название вручную")).toBeDefined();
  expect(screen.getByLabelText("Начальная категория")).toBeDefined();
  expect(screen.getByRole("radio", { name: "Сохранить текущее фото" })).toBeDefined();
  await user.click(screen.getByRole("tab", { name: /Кефир/ }));
  expect(screen.queryByRole("group", { name: "Несопоставленная характеристика" })).toBeNull();
  await user.click(filter);
  expect(screen.getByRole("group", { name: "Несопоставленная характеристика" })).toBeDefined();
  await user.click(screen.getByRole("tab", { name: /Молоко/ }));
  expect(
    screen
      .getByRole("radio", { name: /Название товара.*Предлагаемое/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
  expect(onApply).toHaveBeenCalledWith([
    {
      previewId: id(12),
      acceptedEntryIds: [id(13)],
      linkAction: "attach",
      photo: { kind: "keep" },
    },
    { previewId: id(50), acceptedEntryIds: [], linkAction: "attach", photo: { kind: "keep" } },
  ]);
});
