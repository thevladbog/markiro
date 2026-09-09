import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import "../src/i18n/index.js";
import { ImportReview } from "../src/pages/catalog/national-catalog/ImportReview.js";
import { id, previewFixture } from "./national-catalog-fixtures.js";

afterEach(cleanup);

function setup() {
  const data = structuredClone(previewFixture);
  data.items[0]!.productId = id(21);
  data.items[0]!.photos = [true, false].map((primary, index) => ({
    candidateId: id(30 + index),
    state: "pending",
    previewPath: null,
    primary,
    selectedByDefault: false,
    automaticWorkPending: primary,
    reason: null,
  }));
  const props = {
    sessionId: id(1),
    data,
    canWrite: true,
    busy: false,
    canPreparePhotos: true,
    onPrepare: vi.fn(),
    onApply: vi.fn(),
    onPhoto: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  return { data, props, view, user: userEvent.setup() };
}

it("shows preparation only for a queued photo and starts an idle alternative explicitly", async () => {
  const { data, props, view, user } = setup();
  expect(screen.getAllByText("Фото готовится")).toHaveLength(1);
  expect(screen.getByText("Фото не загружено")).toBeDefined();
  const buttons = screen.getAllByRole("button", { name: "Подготовить альтернативное фото" });
  expect(buttons).toHaveLength(1);
  await user.click(buttons[0]!);
  expect(props.onPhoto).toHaveBeenCalledWith(id(12), id(31));
  data.items[0]!.photos[1]!.automaticWorkPending = true;
  view.rerender(<ImportReview {...props} data={structuredClone(data)} />);
  expect(screen.getAllByText("Фото готовится")).toHaveLength(2);
  expect(screen.queryByText("Фото не загружено")).toBeNull();
  expect(screen.queryByRole("button", { name: "Подготовить альтернативное фото" })).toBeNull();
});

it("displays the prepared main photo automatically while keeping the current photo selected", async () => {
  const { data, props, view, user } = setup();
  data.items[0]!.photos[0]!.state = "ready";
  data.items[0]!.photos[0]!.automaticWorkPending = false;
  view.rerender(<ImportReview {...props} data={structuredClone(data)} />);
  const image = screen.getByRole("img", { name: "Подготовленное фото товара" });
  expect(image.getAttribute("src")).toBe(
    `/api/national-catalog/import-sessions/${id(1)}/images/${id(30)}`,
  );
  fireEvent.load(image);
  expect(
    screen.getByRole("radio", { name: "Сохранить текущее фото" }).getAttribute("aria-checked"),
  ).toBe("true");
  await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
  expect(props.onApply.mock.calls[0]?.[0][0].photo).toEqual({ kind: "keep" });
});

it.each(["main-first", "alternative-first"])(
  "records the explicitly inspected photo independently of %s image load order",
  async (order) => {
    const { data, props, view, user } = setup();
    for (const photo of data.items[0]!.photos) {
      photo.state = "ready";
      photo.automaticWorkPending = false;
    }
    view.rerender(<ImportReview {...props} data={structuredClone(data)} />);
    const images = screen.getAllByRole("img", { name: "Подготовленное фото товара" });
    const main = images[0]!;
    const alternative = images[1]!;
    if (order === "alternative-first") fireEvent.load(alternative);
    fireEvent.load(main);
    await user.click(screen.getAllByRole("radio", { name: "Выбрать это фото" })[0]!);
    if (order === "main-first") fireEvent.load(alternative);
    await user.click(screen.getByRole("radio", { name: "Сохранить текущее фото" }));
    await user.click(screen.getByRole("button", { name: "Применить выбранное" }));
    expect(props.onApply.mock.calls[0]?.[0][0].photo).toEqual({
      kind: "keep",
      reviewedCandidateId: id(30),
    });
  },
);
