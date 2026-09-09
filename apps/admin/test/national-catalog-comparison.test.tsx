import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import "../src/i18n/index.js";
import { ImportReview } from "../src/pages/catalog/national-catalog/ImportReview.js";
import { id, previewFixture } from "./national-catalog-fixtures.js";

afterEach(cleanup);

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
  await user.click(screen.getByRole("button", { name: "Просмотреть фото" }));
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
