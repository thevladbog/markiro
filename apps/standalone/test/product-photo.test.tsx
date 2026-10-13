import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { ProductPhoto } from "../src/host/protocol.js";
import { createOfficeQueryClient, officeKeys } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import {
  PhotoTooLargeError,
  PhotoUnreadableError,
  type PhotoEncoder,
} from "../src/office/products/photo-encode.js";
import { ProductPhotoField } from "../src/office/products/ProductPhotoField.js";
import { fakeOfficeSession, type FakeOfficeSession } from "./support/office.js";

const PRODUCT_ID = "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f";
const NAME = "Пиво светлое 0,5 л";
const ENCODED = { width: 2, height: 1, dataBase64: "/9j/4AAQSkZJRgABAQ==" };
const PHOTO: ProductPhoto = {
  ...ENCODED,
  checksum: "ae0e381fa858d6782d6859eb9337b80e670dc0021361fdd55d49299f1b4c26fd",
  updatedAt: "2026-10-13T09:00:00.000Z",
};

function session(photo: ProductPhoto | null = null): FakeOfficeSession {
  const fake = fakeOfficeSession();
  fake.api.getProductPhoto.mockResolvedValue({ photo });
  return fake;
}

function show(fake: FakeOfficeSession, productId: string | null, encode: PhotoEncoder) {
  const queryClient = createOfficeQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <OfficeSessionProvider value={fake}>
        <ProductPhotoField productId={productId} productName={NAME} encode={encode} />
      </OfficeSessionProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

/** The picker's hidden input. */
function pick(file: File): void {
  const input = screen.getByTestId("file-drop-input");
  fireEvent.change(input, { target: { files: [file] } });
}

const JPEG = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "photo.jpg", {
  type: "image/jpeg",
});

describe("a product's photo in the office (plan ТОВ)", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("asks a new product to be saved first, and reads nothing", () => {
    const fake = session();
    show(fake, null, vi.fn<PhotoEncoder>());
    expect(screen.getByText("Фото можно добавить после сохранения товара")).toBeTruthy();
    expect(screen.queryByTestId("file-drop-input")).toBeNull();
    expect(fake.api.getProductPhoto).not.toHaveBeenCalled();
  });

  it("encodes a picked picture, writes it at once and shows it by the product's name", async () => {
    const fake = session();
    fake.api.putProductPhoto.mockResolvedValue({ photo: PHOTO });
    const encode = vi.fn<PhotoEncoder>(async () => ENCODED);
    const queryClient = show(fake, PRODUCT_ID, encode);
    const choose = await screen.findByRole("button", { name: /Выбрать фото/u });
    expect(choose.tabIndex).toBe(0);
    expect(
      screen.getByText(
        "JPEG, PNG или WebP. Фото уменьшается до 640 точек по большей стороне, сохраняется сразу, без кнопки «Сохранить», и печатается на бланке смены.",
      ),
    ).toBeTruthy();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    pick(JPEG);
    const image = await screen.findByRole("img", { name: `Фото товара ${NAME}` });
    expect(image.getAttribute("src")).toBe(`data:image/jpeg;base64,${PHOTO.dataBase64}`);
    expect(encode).toHaveBeenCalledWith(JPEG);
    expect(fake.api.putProductPhoto).toHaveBeenCalledWith(
      "office-session-token",
      PRODUCT_ID,
      ENCODED,
    );
    // The list's `photoChecksum` changes with it.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: officeKeys.products, exact: true });
    expect(screen.getByRole("button", { name: /Заменить/u })).toBeTruthy();
  });

  it("writes only the latest picked picture when an earlier encode ends later", async () => {
    const fake = session();
    fake.api.putProductPhoto.mockResolvedValue({ photo: PHOTO });
    let finishFirst: (photo: typeof ENCODED) => void = () => undefined;
    const second = { ...ENCODED, width: 1 };
    const encode = vi
      .fn<PhotoEncoder>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => second);
    show(fake, PRODUCT_ID, encode);
    await screen.findByRole("button", { name: /Выбрать фото/u });
    pick(JPEG);
    pick(JPEG);
    await waitFor(() => expect(fake.api.putProductPhoto).toHaveBeenCalledTimes(1));
    await act(async () => {
      finishFirst(ENCODED);
      await Promise.resolve();
    });
    expect(fake.api.putProductPhoto.mock.calls).toEqual([
      ["office-session-token", PRODUCT_ID, second],
    ]);
  });

  it("names its section by its heading", async () => {
    show(session(), PRODUCT_ID, vi.fn<PhotoEncoder>());
    expect(await screen.findByRole("region", { name: "Фото" })).toBeTruthy();
  });

  it("removes the photo and offers to choose one again", async () => {
    const fake = session(PHOTO);
    fake.api.deleteProductPhoto.mockResolvedValue({ photo: null });
    show(fake, PRODUCT_ID, vi.fn<PhotoEncoder>());
    await screen.findByRole("img", { name: `Фото товара ${NAME}` });
    fireEvent.click(screen.getByRole("button", { name: "Удалить фото" }));
    await screen.findByRole("button", { name: /Выбрать фото/u });
    expect(screen.queryByRole("img")).toBeNull();
    expect(fake.api.deleteProductPhoto).toHaveBeenCalledWith("office-session-token", PRODUCT_ID);
    expect(screen.queryByRole("button", { name: "Удалить фото" })).toBeNull();
  });

  it.each([
    [new PhotoUnreadableError(), "Не удалось прочитать картинку"],
    [new PhotoTooLargeError(), "Картинка слишком большая даже после сжатия"],
  ])("says why a picture cannot be a photo: %s", async (error, text) => {
    const fake = session();
    show(
      fake,
      PRODUCT_ID,
      vi.fn<PhotoEncoder>(() => Promise.reject(error)),
    );
    await screen.findByRole("button", { name: /Выбрать фото/u });
    pick(JPEG);
    expect(within(await screen.findByRole("alert")).getByText(text)).toBeTruthy();
    expect(fake.api.putProductPhoto).not.toHaveBeenCalled();
  });

  it("refuses a file of another type unread", async () => {
    const fake = session();
    const encode = vi.fn<PhotoEncoder>(async () => ENCODED);
    show(fake, PRODUCT_ID, encode);
    await screen.findByRole("button", { name: /Выбрать фото/u });
    pick(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
    expect(
      within(await screen.findByRole("alert")).getByText("Не удалось прочитать картинку"),
    ).toBeTruthy();
    expect(encode).not.toHaveBeenCalled();
  });

  it("shows the host's refusal of the write", async () => {
    const fake = session();
    fake.api.putProductPhoto.mockRejectedValue(
      new HostError({ kind: "api", code: "internal", status: 500, message: "x", details: {} }),
    );
    show(
      fake,
      PRODUCT_ID,
      vi.fn<PhotoEncoder>(async () => ENCODED),
    );
    await screen.findByRole("button", { name: /Выбрать фото/u });
    pick(JPEG);
    expect(await screen.findByText("На хосте произошла ошибка. Повторите попытку.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("reaches its buttons with the keyboard", async () => {
    const fake = session(PHOTO);
    show(fake, PRODUCT_ID, vi.fn<PhotoEncoder>());
    await screen.findByRole("img", { name: `Фото товара ${NAME}` });
    const replace = screen.getByRole("button", { name: /Заменить/u });
    const remove = screen.getByRole("button", { name: "Удалить фото" });
    for (const button of [replace, remove]) {
      act(() => button.focus());
      expect(document.activeElement).toBe(button);
    }
    await waitFor(() => expect(fake.api.getProductPhoto).toHaveBeenCalledTimes(1));
  });
});
