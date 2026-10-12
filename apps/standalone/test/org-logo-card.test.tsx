import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MonoBitmap } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { OrgLogo, OrgLogoState } from "../src/host/protocol.js";
import { decodeLogoFile, LogoDecodeError, logoToWire } from "../src/labels/logo.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

import type * as LogoModule from "../src/labels/logo.js";

// `decodeLogoFile` is the real one unless a test says otherwise: it needs a webview's image
// decoder, which jsdom does not have. Everything it refuses before decoding is exercised for real.
vi.mock("../src/labels/logo.js", async (importActual) => {
  const actual = await importActual<typeof LogoModule>();
  return { ...actual, decodeLogoFile: vi.fn(actual.decodeLogoFile) };
});

const TOKEN = "office-session-token";

/** 16 × 8 dots: the left byte of every row is ink. */
const LEFT_HALF: MonoBitmap = {
  width: 16,
  height: 8,
  stride: 2,
  pixels: Uint8Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? 0xff : 0)),
};
/** 8 × 8 dots, one dot of ink. */
const ONE_DOT: MonoBitmap = {
  width: 8,
  height: 8,
  stride: 1,
  pixels: Uint8Array.from({ length: 8 }, (_, index) => (index === 0 ? 0x80 : 0)),
};
const WHITE: MonoBitmap = { width: 8, height: 8, stride: 1, pixels: new Uint8Array(8) };

const STORED: OrgLogo = { ...logoToWire(LEFT_HALF), updatedAt: "2026-10-11T09:00:00Z" };

const png = (name = "logo.png") =>
  new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 400, message: code, details });
}

function session(logo: OrgLogo | null, user?: FakeOfficeSession["user"]): FakeOfficeSession {
  const fake = fakeOfficeSession(user === undefined ? {} : { user });
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.getOrgLogo.mockResolvedValue({ logo });
  return fake;
}

async function openProfile(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
  await screen.findByRole("heading", { name: "Логотип для печати" });
}

/** The logo picker's hidden input. */
function picker(): HTMLInputElement {
  const input = screen.getByTestId("file-drop-input");
  if (!(input instanceof HTMLInputElement)) throw new Error("the picker is not an input");
  return input;
}

function pick(file: File): void {
  fireEvent.change(picker(), { target: { files: [file] } });
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

/** Records what each canvas is painted with (jsdom has no canvas). */
function recordPaints() {
  vi.stubGlobal("ImageData", FakeImageData);
  const paints: { canvas: HTMLCanvasElement; image: FakeImageData }[] = [];
  const real = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: function getContext(this: HTMLCanvasElement) {
      return { putImageData: (image: FakeImageData) => paints.push({ canvas: this, image }) };
    },
  });
  return {
    paints,
    restore() {
      if (real !== undefined)
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", real);
    },
  };
}

/** How many dots of a painted image are ink. */
function inkOf(image: FakeImageData): number {
  let count = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset] === 0) count += 1;
  }
  return count;
}

beforeEach(() => {
  localStorage.removeItem("markiro.theme");
  vi.mocked(decodeLogoFile).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the organization's print logo", () => {
  it("says the Markiro logo prints when there is none, and offers the upload to an administrator", async () => {
    await openProfile(session(null));
    expect(screen.getByText("Логотип не загружен — печатается логотип Маркиро.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Загрузить логотип" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Убрать логотип" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Логотип для печати" })).toBeNull();
  });

  it("shows the stored logo as it prints, and offers to replace or remove it", async () => {
    const recorder = recordPaints();
    try {
      await openProfile(session(STORED));
      const canvas = await screen.findByRole("img", { name: "Логотип для печати" });
      await waitFor(() =>
        expect(recorder.paints.some((paint) => paint.canvas === canvas)).toBe(true),
      );
      const painted = recorder.paints.find((paint) => paint.canvas === canvas);
      // 16 × 8 dots, the left byte of each row: half the dots are ink.
      expect(painted && inkOf(painted.image)).toBe(64);
      expect(screen.getByRole("button", { name: "Заменить логотип" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Убрать логотип" })).toBeTruthy();
    } finally {
      recorder.restore();
    }
  });

  it("says a stored logo this build cannot read is unreadable, and still lets the administrator replace it", async () => {
    await openProfile(session({ ...STORED, pixelsBase64: "AAAA" }));
    expect(
      await screen.findByText(
        "Сохранённый логотип не читается этой версией. Загрузите его заново.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Логотип для печати" })).toBeNull();
    expect(screen.getByTestId("file-drop-input")).toBeTruthy();
  });

  it("shows a technologist the logo and no way to change it", async () => {
    await openProfile(session(STORED, TECHNOLOGIST));
    expect(await screen.findByRole("img", { name: "Логотип для печати" })).toBeTruthy();
    expect(screen.queryByTestId("file-drop-input")).toBeNull();
    expect(screen.queryByRole("button", { name: "Убрать логотип" })).toBeNull();
    expect(screen.getByText("Изменять логотип может только администратор.")).toBeTruthy();
  });

  it("explains a logo that did not load and reads it again", async () => {
    const fake = session(null);
    fake.api.getOrgLogo
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      )
      .mockResolvedValueOnce({ logo: null });
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
    await screen.findByText(
      "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    );
    // The profile loaded, so the logo's retry is the only one on screen.
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    expect(
      await screen.findByText("Логотип не загружен — печатается логотип Маркиро."),
    ).toBeTruthy();
  });
});

describe("picking a logo file", () => {
  it("refuses a file of another type before it is read, in words", async () => {
    await openProfile(session(null));
    pick(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByText("Подойдут файлы PNG, JPEG, WebP и SVG.")).toBeTruthy();
    expect(decodeLogoFile).not.toHaveBeenCalled();
  });

  it("refuses a file over 4 MiB unread, through the real guard of the decoder", async () => {
    const fake = session(null);
    await openProfile(fake);
    pick(new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    expect(await screen.findByText("Файл больше 4 МБ: выберите файл поменьше.")).toBeTruthy();
    expect(decodeLogoFile).toHaveBeenCalledTimes(1);
    expect(fake.api.putOrgLogo).not.toHaveBeenCalled();
  });

  it.each([
    ["too_large", "Файл больше 4 МБ: выберите файл поменьше."],
    ["unsupported_type", "Подойдут файлы PNG, JPEG, WebP и SVG."],
    [
      "decode_failed",
      "Картинку не удалось прочитать: файл повреждён или не является изображением.",
    ],
    ["empty", "У картинки нет размера: выберите другой файл."],
    [
      "canvas_unavailable",
      "Окно приложения не может подготовить картинку для печати. Перезапустите приложение.",
    ],
  ] as const)("words the decoder's refusal %s", async (code, text) => {
    const fake = session(null);
    vi.mocked(decodeLogoFile).mockRejectedValueOnce(new LogoDecodeError(code));
    await openProfile(fake);
    pick(png());
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Новый логотип для печати" })).toBeNull();
    expect(fake.api.putOrgLogo).not.toHaveBeenCalled();
  });

  it("says a failure of the webview that is no decoder code is a picture it could not read", async () => {
    vi.mocked(decodeLogoFile).mockRejectedValueOnce(new RangeError("boom"));
    await openProfile(session(null));
    pick(png());
    expect(await screen.findByText("Картинку не удалось прочитать.")).toBeTruthy();
  });

  it("refuses a picture that is all white once turned black and white", async () => {
    const fake = session(null);
    vi.mocked(decodeLogoFile).mockResolvedValueOnce(WHITE);
    await openProfile(fake);
    pick(png());
    expect(
      await screen.findByText(/После перевода в чёрно-белое на картинке ничего не осталось/),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Новый логотип для печати" })).toBeNull();
    expect(fake.api.putOrgLogo).not.toHaveBeenCalled();
  });

  it("shows the black and white dots first and saves nothing until the administrator says so", async () => {
    const recorder = recordPaints();
    try {
      const fake = session(null);
      fake.api.putOrgLogo.mockResolvedValue({
        logo: { ...logoToWire(ONE_DOT), updatedAt: STORED.updatedAt },
      });
      vi.mocked(decodeLogoFile).mockResolvedValueOnce(ONE_DOT);
      await openProfile(fake);
      const file = png();
      pick(file);
      const staged = await screen.findByRole("img", { name: "Новый логотип для печати" });
      expect(vi.mocked(decodeLogoFile).mock.calls[0]?.[0]).toBe(file);
      // What is drawn is the thresholded bits: one ink dot, not the picture.
      await waitFor(() =>
        expect(recorder.paints.some((paint) => paint.canvas === staged)).toBe(true),
      );
      const painted = recorder.paints.find((paint) => paint.canvas === staged);
      expect(painted && inkOf(painted.image)).toBe(1);
      expect(fake.api.putOrgLogo).not.toHaveBeenCalled();
      expect(screen.getByText(/Так логотип напечатается/)).toBeTruthy();
    } finally {
      recorder.restore();
    }
  });

  it("saves the dots with the host's wire shape, keeps the answer without reading again, and drops the preview", async () => {
    const fake = session(null);
    const answer: OrgLogoState = {
      logo: { ...logoToWire(ONE_DOT), updatedAt: "2026-10-12T08:00:00Z" },
    };
    fake.api.putOrgLogo.mockResolvedValue(answer);
    vi.mocked(decodeLogoFile).mockResolvedValueOnce(ONE_DOT);
    await openProfile(fake);
    pick(png());
    await screen.findByRole("img", { name: "Новый логотип для печати" });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить логотип" }));
    expect(
      await screen.findByText(
        "Логотип сохранён. Новые смены напечатают его; открытые смены печатают прежний.",
      ),
    ).toBeTruthy();
    expect(fake.api.putOrgLogo).toHaveBeenCalledTimes(1);
    expect(fake.api.putOrgLogo).toHaveBeenCalledWith(TOKEN, {
      width: 8,
      height: 8,
      pixelsBase64: "gAAAAAAAAAA=",
    });
    expect(screen.queryByRole("img", { name: "Новый логотип для печати" })).toBeNull();
    expect(await screen.findByRole("img", { name: "Логотип для печати" })).toBeTruthy();
    expect(fake.api.getOrgLogo).toHaveBeenCalledTimes(1);
  });

  it("sends the logo once when «Сохранить логотип» is pressed twice at once", async () => {
    const fake = session(null);
    const slow = deferred<OrgLogoState>();
    fake.api.putOrgLogo.mockReturnValue(slow.promise);
    vi.mocked(decodeLogoFile).mockResolvedValueOnce(ONE_DOT);
    await openProfile(fake);
    pick(png());
    await screen.findByRole("img", { name: "Новый логотип для печати" });
    const save = screen.getByRole("button", { name: "Сохранить логотип" });
    await act(async () => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(fake.api.putOrgLogo).toHaveBeenCalledTimes(1);
    await act(async () => {
      slow.resolve({ logo: { ...logoToWire(ONE_DOT), updatedAt: STORED.updatedAt } });
      await slow.promise;
    });
    await screen.findByText(/Логотип сохранён/);
  });

  it("keeps the preview when the host refuses the logo, words the refusal, and sends again on a retry", async () => {
    const fake = session(null);
    fake.api.putOrgLogo
      .mockRejectedValueOnce(api("validation_failed", { field: "pixelsBase64" }))
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      )
      .mockResolvedValueOnce({ logo: { ...logoToWire(ONE_DOT), updatedAt: STORED.updatedAt } });
    vi.mocked(decodeLogoFile).mockResolvedValueOnce(ONE_DOT);
    await openProfile(fake);
    pick(png());
    await screen.findByRole("img", { name: "Новый логотип для печати" });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить логотип" }));
    expect(await screen.findByText("Хост не принял логотип. Выберите другой файл.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Новый логотип для печати" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить логотип" }));
    expect(
      await screen.findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Хост не принял логотип. Выберите другой файл.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить логотип" }));
    await screen.findByText(/Логотип сохранён/);
    expect(fake.api.putOrgLogo).toHaveBeenCalledTimes(3);
  });

  it("drops the preview on «Не сохранять» and sends nothing", async () => {
    const fake = session(null);
    vi.mocked(decodeLogoFile).mockResolvedValueOnce(ONE_DOT);
    await openProfile(fake);
    pick(png());
    await screen.findByRole("img", { name: "Новый логотип для печати" });
    fireEvent.click(screen.getByRole("button", { name: "Не сохранять" }));
    expect(screen.queryByRole("img", { name: "Новый логотип для печати" })).toBeNull();
    expect(fake.api.putOrgLogo).not.toHaveBeenCalled();
  });

  it("keeps the file picked last when an earlier one is still being read", async () => {
    const fake = session(null);
    fake.api.putOrgLogo.mockResolvedValue({
      logo: { ...logoToWire(ONE_DOT), updatedAt: STORED.updatedAt },
    });
    const first = deferred<MonoBitmap>();
    const second = deferred<MonoBitmap>();
    vi.mocked(decodeLogoFile)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await openProfile(fake);
    pick(png("first.png"));
    pick(png("second.png"));
    await act(async () => {
      second.resolve(ONE_DOT);
      await second.promise;
    });
    await screen.findByRole("img", { name: "Новый логотип для печати" });
    await act(async () => {
      first.resolve(LEFT_HALF);
      await first.promise;
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить логотип" }));
    await screen.findByText(/Логотип сохранён/);
    expect(fake.api.putOrgLogo).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ width: 8 }));
  });

  it("does not show the refusal of a file that was replaced by a later pick", async () => {
    const fake = session(null);
    const first = deferred<MonoBitmap>();
    vi.mocked(decodeLogoFile).mockReturnValueOnce(first.promise).mockResolvedValueOnce(ONE_DOT);
    await openProfile(fake);
    pick(png("first.png"));
    pick(png("second.png"));
    await screen.findByRole("img", { name: "Новый логотип для печати" });
    await act(async () => {
      first.reject(new LogoDecodeError("decode_failed"));
      await first.promise.catch(() => undefined);
    });
    expect(
      screen.queryByText(
        "Картинку не удалось прочитать: файл повреждён или не является изображением.",
      ),
    ).toBeNull();
    expect(screen.getByRole("img", { name: "Новый логотип для печати" })).toBeTruthy();
  });

  it("clears an earlier message as soon as another file is picked, before it is read", async () => {
    const fake = session(null);
    const slow = deferred<MonoBitmap>();
    vi.mocked(decodeLogoFile)
      .mockRejectedValueOnce(new LogoDecodeError("empty"))
      .mockReturnValueOnce(slow.promise);
    await openProfile(fake);
    pick(png("one.png"));
    await screen.findByText("У картинки нет размера: выберите другой файл.");
    pick(png("two.png"));
    await waitFor(() =>
      expect(screen.queryByText("У картинки нет размера: выберите другой файл.")).toBeNull(),
    );
    await act(async () => {
      slow.resolve(ONE_DOT);
      await slow.promise;
    });
    await screen.findByRole("img", { name: "Новый логотип для печати" });
  });

  it("drops a file still being read when a file of another type is picked after it", async () => {
    const fake = session(null);
    const slow = deferred<MonoBitmap>();
    vi.mocked(decodeLogoFile).mockReturnValueOnce(slow.promise);
    await openProfile(fake);
    pick(png("slow.png"));
    pick(new File(["x"], "notes.txt", { type: "text/plain" }));
    await screen.findByText("Подойдут файлы PNG, JPEG, WebP и SVG.");
    await act(async () => {
      slow.resolve(ONE_DOT);
      await slow.promise;
    });
    expect(screen.queryByRole("img", { name: "Новый логотип для печати" })).toBeNull();
    expect(screen.getByText("Подойдут файлы PNG, JPEG, WebP и SVG.")).toBeTruthy();
  });

  it("clears an earlier preview and message when another file is picked", async () => {
    const fake = session(null);
    vi.mocked(decodeLogoFile)
      .mockResolvedValueOnce(ONE_DOT)
      .mockRejectedValueOnce(new LogoDecodeError("empty"));
    await openProfile(fake);
    pick(png("one.png"));
    await screen.findByRole("img", { name: "Новый логотип для печати" });
    pick(png("two.png"));
    await screen.findByText("У картинки нет размера: выберите другой файл.");
    expect(screen.queryByRole("img", { name: "Новый логотип для печати" })).toBeNull();
  });
});

describe("removing the logo", () => {
  it("asks first, says what happens, and removes nothing on «Отмена»", async () => {
    const fake = session(STORED);
    await openProfile(fake);
    fireEvent.click(await screen.findByRole("button", { name: "Убрать логотип" }));
    const dialog = await screen.findByRole("dialog", { name: "Убрать логотип?" });
    expect(
      within(dialog).getByText(/Новые смены будут печатать встроенный логотип Маркиро/),
    ).toBeTruthy();
    expect(fake.api.deleteOrgLogo).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog", { name: "Убрать логотип?" })).toBeNull();
    expect(fake.api.deleteOrgLogo).not.toHaveBeenCalled();
  });

  it("removes the logo after the confirmation and says the Markiro logo prints now", async () => {
    const fake = session(STORED);
    fake.api.deleteOrgLogo.mockResolvedValue({ logo: null });
    await openProfile(fake);
    fireEvent.click(await screen.findByRole("button", { name: "Убрать логотип" }));
    const dialog = await screen.findByRole("dialog", { name: "Убрать логотип?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Убрать" }));
    expect(
      await screen.findByText("Логотип убран: новые смены напечатают логотип Маркиро."),
    ).toBeTruthy();
    expect(fake.api.deleteOrgLogo).toHaveBeenCalledTimes(1);
    expect(fake.api.deleteOrgLogo).toHaveBeenCalledWith(TOKEN);
    expect(screen.queryByRole("dialog", { name: "Убрать логотип?" })).toBeNull();
    expect(screen.getByText("Логотип не загружен — печатается логотип Маркиро.")).toBeTruthy();
    expect(fake.api.getOrgLogo).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open and says why when the host does not answer, and removes once on a retry", async () => {
    const fake = session(STORED);
    fake.api.deleteOrgLogo
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      )
      .mockResolvedValueOnce({ logo: null });
    await openProfile(fake);
    fireEvent.click(await screen.findByRole("button", { name: "Убрать логотип" }));
    const dialog = await screen.findByRole("dialog", { name: "Убрать логотип?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Убрать" }));
    expect(
      await within(dialog).findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Убрать логотип?" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Убрать" }));
    await screen.findByText("Логотип убран: новые смены напечатают логотип Маркиро.");
    expect(fake.api.deleteOrgLogo).toHaveBeenCalledTimes(2);
  });

  it("drops a preview waiting to be saved when the logo is removed", async () => {
    const fake = session(STORED);
    fake.api.deleteOrgLogo.mockResolvedValue({ logo: null });
    vi.mocked(decodeLogoFile).mockResolvedValueOnce(ONE_DOT);
    await openProfile(fake);
    pick(png());
    await screen.findByRole("img", { name: "Новый логотип для печати" });
    fireEvent.click(screen.getByRole("button", { name: "Убрать логотип" }));
    const dialog = await screen.findByRole("dialog", { name: "Убрать логотип?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Убрать" }));
    await screen.findByText("Логотип убран: новые смены напечатают логотип Маркиро.");
    expect(screen.queryByRole("img", { name: "Новый логотип для печати" })).toBeNull();
  });
});
