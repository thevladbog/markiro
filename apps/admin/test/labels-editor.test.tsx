/**
 * The `/labels/new` / `/labels/:id` template page after the visual editor's
 * removal (spec 2026-08-20). What is left to cover, and what these tests
 * therefore assert:
 *
 *  - the settings form (size preset / custom size / dpi) really round-trips
 *    into the spec the "Сохранить" button POSTs, and offers NO language
 *    control: a spec is language-neutral, so the panel must not present one
 *    (the station picks its own printer's language at print time);
 *  - IMPORT IS THE ONLY CONTENT PATH: pasted ZPL replaces the whole spec, and
 *    the deleted palette/properties chrome is provably absent;
 *  - shrinking the label re-fits imported elements, and an impossible shrink
 *    surfaces the geometry error instead of silently truncating content;
 *  - the custom width/height inputs are DRAFTED (committed on blur / Enter),
 *    so a multi-digit size can actually be typed, and the two failure modes
 *    stay distinct: an out-of-range/empty entry reports an invalid dimension,
 *    only a valid-but-unfittable one reports "element larger than the label";
 *    both clear once a later valid resize or import succeeds, and the
 *    invalid-dimension message is tracked PER AXIS, so a valid commit on one
 *    axis never leaves the other axis' rejected text on screen unexplained;
 *  - BOTH downloads are always available from the same spec, with no setting
 *    to flip: "Скачать ZPL" and "Скачать TSPL (TSC)" each produce a real,
 *    byte-safe download -- ZPL's Blob text contains `^XA`; TSPL's Blob bytes
 *    preserve an injected raster byte > 0x7F intact (never UTF-8-mangled
 *    into two bytes);
 *  - Save POSTs a `parseLabelTemplate`-valid spec and navigates (create flow)
 *    / PATCHes an existing template (edit flow);
 *  - the dirty-guard confirm modal blocks "back" until confirmed;
 *  - the font-coverage check surfaces two DISTINCT warnings: "no Cyrillic in
 *    this font" (coverage resolves `false`) vs. "could not verify" (coverage
 *    throws/rejects) -- never an unhandled rejection.
 *
 * A fake `rasterizeText` (deterministic single-pixel `RasterResult`) is
 * injected into every render, per the plan's "injectable, default real"
 * hard rule -- this is what lets `generateZpl`/`generateTspl` actually
 * reach their rasterized-fallback branch under jsdom (the REAL rasterizer
 * always throws `RasterUnavailableError` there, see `labels-raster.test.ts`).
 *
 * Every test that needs label CONTENT gets it the same way a user now must:
 * through the import dialog (`importZpl` below). There is no other way to put
 * an element on a label from this page any more.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseLabelTemplate, type RasterResult, type RasterizeTextFn } from "@markiro/domain";

import { buildZplBlob, latin1ToUint8Array } from "../src/pages/labels/editor/download.js";
import { LabelEditorPage } from "../src/pages/labels/editor/index.js";
import { decodeRasterToRgba, rasterDestXPx } from "../src/pages/labels/editor/raster-preview.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/**
 * Deterministic single-pixel, all-WHITE raster (ZPL polarity: bit 0 =
 * white -- see `raster-types.ts`). Chosen specifically for the TSPL
 * byte-safety test below: `invertHexToTsplBytes` XORs every byte with
 * `0xff` for TSPL's opposite polarity, so this all-white `0x00` byte comes
 * out the other side as `0xff` -- a byte > 0x7F, embedded directly in the
 * TSPL document string, exactly the case that would get silently corrupted
 * by handing a plain string straight to `Blob` instead of routing it
 * through `latin1ToUint8Array` first.
 */
const FAKE_RASTER_RESULT: RasterResult = {
  hex: "00",
  totalBytes: 1,
  bytesPerRow: 1,
  width: 8,
  height: 1,
};
const fakeRasterizeText: RasterizeTextFn = async () => ({ ...FAKE_RASTER_RESULT });
const resolveTrueCoverage = async () => true;

function LibraryMarker() {
  return <div>Library page</div>;
}

/** Sentinel for `/labels/:id` in tests that only care THAT navigation
 * happened (create flow), not about re-mounting the real editor a second
 * time against a second fetch mock. */
function EditorRouteMarker() {
  const { id } = useParams<{ id: string }>();
  return <div>Editor route: {id}</div>;
}

interface RenderOptions {
  rasterizeText?: RasterizeTextFn;
  checkFamilyCoverage?: (family: "IBM Plex Sans" | "IBM Plex Mono") => Promise<boolean>;
}

function renderCreateFlow(options: RenderOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rasterizeText = options.rasterizeText ?? fakeRasterizeText;
  const checkFamilyCoverage = options.checkFamilyCoverage ?? resolveTrueCoverage;
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/labels/new"]}>
        <Routes>
          <Route path="/labels" element={<LibraryMarker />} />
          <Route
            path="/labels/new"
            element={
              <LabelEditorPage
                rasterizeText={rasterizeText}
                checkFamilyCoverage={checkFamilyCoverage}
              />
            }
          />
          <Route path="/labels/:id" element={<EditorRouteMarker />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderEditFlow(id: string, options: RenderOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rasterizeText = options.rasterizeText ?? fakeRasterizeText;
  const checkFamilyCoverage = options.checkFamilyCoverage ?? resolveTrueCoverage;
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/labels/${id}`]}>
        <Routes>
          <Route path="/labels" element={<LibraryMarker />} />
          <Route
            path="/labels/:id"
            element={
              <LabelEditorPage
                rasterizeText={rasterizeText}
                checkFamilyCoverage={checkFamilyCoverage}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** `@markiro/ui`'s `Select` is a Radix listbox (a `combobox` button + a
 * portalled option list), NOT a native `<select>` -- `userEvent.selectOptions`
 * does not apply. */
async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** The one and only way to put content on a label now: paste code, check it,
 * replace the spec. */
function importZpl(source: string): void {
  fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
  const dialog = screen.getByRole("dialog", { name: "Импорт кода" });
  fireEvent.change(within(dialog).getByLabelText("Код ZPL"), { target: { value: source } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Заменить этикетку" }));
}

/** 58x40mm at 203dpi (the create-flow default size), one literal text line
 * and one `{{qty}}` field. */
const IMPORT_ZPL = [
  "^XA",
  "^PW464",
  "^LL320",
  "^FO40,40^A0N,34,34^FDПартия^FS",
  "^FO40,100^A0N,34,34^FD{{qty}}^FS",
  "^XZ",
].join("\n");

/** ~100x100mm at 203dpi with a short text element near the RIGHT edge --
 * shrinking the label to 58x40 must slide it back inside. */
const WIDE_IMPORT_ZPL = ["^XA", "^PW800", "^LL800", "^FO600,40^A0N,34,34^FDACME^FS", "^XZ"].join(
  "\n",
);

/** A field bound to a Cyrillic sample value (`product.name` -> "Пиво светлое
 * 0,5 л"), which is what makes `needsImageRendering` -- and therefore the
 * rasterized ZPL/TSPL fallback and the font-coverage check -- relevant. */
const CYRILLIC_FIELD_ZPL = [
  "^XA",
  "^PW464",
  "^LL320",
  "^FO40,40^A0N,34,34^FD{{product.name}}^FS",
  "^XZ",
].join("\n");

function stubCreateFetch(id: string) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/label-templates" && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { name: string; spec: unknown };
      return jsonResponse(201, {
        id,
        name: body.name,
        spec: body.spec,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postedSpec<T>(fetchMock: { mock: { calls: unknown[][] } }): T {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  return (JSON.parse(init.body as string) as { spec: T }).spec;
}

describe("Settings form", () => {
  it("shows the empty-state hint until code is imported", () => {
    renderCreateFlow();

    expect(
      screen.getByText("Содержимое этикетки не задано — импортируйте код ZPL или TSPL."),
    ).toBeDefined();

    importZpl(IMPORT_ZPL);

    expect(
      screen.queryByText("Содержимое этикетки не задано — импортируйте код ZPL или TSPL."),
    ).toBeNull();
  });

  it("a dpi change round-trips into the spec Save POSTs", async () => {
    const user = userEvent.setup();
    const fetchMock = stubCreateFetch("new-1");

    renderCreateFlow();

    await chooseOption(user, "DPI", "300");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const spec = postedSpec<{ dpi: number }>(fetchMock);
    expect(spec.dpi).toBe(300);
    expect(() => parseLabelTemplate(spec)).not.toThrow();
    expect(await screen.findByText("Editor route: new-1")).toBeDefined();
  });

  /** A `LabelTemplateSpec` is language-neutral -- the station generates
   * whichever language ITS printer speaks. Offering a per-template «Язык»
   * setting told users the opposite (and had them creating one template per
   * printer brand), so the control must stay gone: the panel states the fact
   * instead, and both downloads are offered unconditionally. */
  it("offers no language setting -- it states that one template covers both printer languages", () => {
    renderCreateFlow();

    expect(screen.queryByRole("combobox", { name: "Язык" })).toBeNull();
    expect(
      screen.getByText(
        "Один шаблон печатается и на Zebra, и на TSC: станция выбирает язык по своему принтеру.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Скачать ZPL" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Скачать TSPL (TSC)" })).toBeDefined();
  });

  it("a size preset round-trips and re-fits imported elements inside the smaller label", async () => {
    const user = userEvent.setup();
    const fetchMock = stubCreateFetch("new-2");

    renderCreateFlow();
    importZpl(WIDE_IMPORT_ZPL);

    // The imported 100x100mm size matches no preset, so the custom inputs show it.
    expect((screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement).value).toBe("100.1");
    await chooseOption(user, "Размер", "58×40");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const spec = postedSpec<{
      widthMm: number;
      heightMm: number;
      elements: Array<{ xMm: number }>;
    }>(fetchMock);
    expect(spec.widthMm).toBe(58);
    expect(spec.heightMm).toBe(40);
    // Imported at 600 dots ~= 75mm, i.e. off the right edge of a 58mm label.
    expect(spec.elements[0]!.xMm).toBeGreaterThanOrEqual(0);
    expect(spec.elements[0]!.xMm).toBeLessThan(58);
    expect(() => parseLabelTemplate(spec)).not.toThrow();
  });

  it("surfaces the geometry error (and keeps the last good spec) when a valid shrink cannot fit an element", () => {
    renderCreateFlow();
    importZpl(IMPORT_ZPL);

    // 10mm is a size the MODEL accepts -- so this really is the "elements do
    // not fit" failure, not an invalid dimension.
    const width = screen.getByLabelText("Ширина этикетки, мм");
    fireEvent.change(width, { target: { value: "10" } });
    fireEvent.blur(width);

    expect(
      screen.getByText("Элемент больше этикетки. Увеличьте этикетку или импортируйте код заново."),
    ).toBeDefined();
    // The rejected width never reached the spec -- the inputs still show 58mm.
    expect((width as HTMLInputElement).value).toBe("58.1");
  });

  it("lets a multi-digit custom size be typed without the field fighting back, and commits it on blur", async () => {
    const user = userEvent.setup();
    const fetchMock = stubCreateFetch("new-4");

    renderCreateFlow();
    await chooseOption(user, "Размер", "Свой размер");
    const width = screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement;

    // The first keystroke of "45" is a 4mm label -- under the old
    // per-keystroke, spec-controlled input this snapped straight back to
    // "58.1" (and raised an error), making 45 unreachable.
    fireEvent.change(width, { target: { value: "4" } });
    expect(width.value).toBe("4");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(width, { target: { value: "45" } });
    fireEvent.blur(width);

    expect(width.value).toBe("45.0");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedSpec<{ widthMm: number }>(fetchMock).widthMm).toBe(45);
  });

  it("commits a custom size on Enter too", async () => {
    const user = userEvent.setup();
    renderCreateFlow();
    await chooseOption(user, "Размер", "Свой размер");
    const height = screen.getByLabelText("Высота этикетки, мм") as HTMLInputElement;

    fireEvent.change(height, { target: { value: "120" } });
    fireEvent.keyDown(height, { key: "Enter" });

    expect(height.value).toBe("120.0");
  });

  it("reports an out-of-range or empty size as an invalid dimension -- never as the too-large geometry error", async () => {
    const user = userEvent.setup();
    renderCreateFlow();
    await chooseOption(user, "Размер", "Свой размер");
    const width = screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement;

    // Below the model's 10mm minimum. The message now appears twice -- once
    // next to the field itself (Fix 4: per-field `error`), once in the
    // summary Alert -- so multi-element queries are used throughout this
    // describe block instead of the single-match `getByText`.
    fireEvent.change(width, { target: { value: "5" } });
    fireEvent.blur(width);
    expect(
      screen.getAllByText("Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах."),
    ).toHaveLength(2);
    expect(
      screen.queryByText(
        "Элемент больше этикетки. Увеличьте этикетку или импортируйте код заново.",
      ),
    ).toBeNull();

    // Cleared field: 0mm is not "an element is too large" either -- this label
    // has no elements at all.
    fireEvent.change(width, { target: { value: "" } });
    fireEvent.blur(width);
    expect(
      screen.getAllByText("Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах."),
    ).toHaveLength(2);
    expect(
      screen.queryByText(
        "Элемент больше этикетки. Увеличьте этикетку или импортируйте код заново.",
      ),
    ).toBeNull();
    // The typed text stays put to be corrected.
    expect(width.value).toBe("");
  });

  it("marks the invalid field itself with aria-invalid and links it to the error text (a screen-reader user focused on the field must hear the reason, not just a summary alert elsewhere on the page)", async () => {
    const user = userEvent.setup();
    renderCreateFlow();
    await chooseOption(user, "Размер", "Свой размер");
    const width = screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement;
    const height = screen.getByLabelText("Высота этикетки, мм") as HTMLInputElement;

    expect(width.getAttribute("aria-invalid")).toBeNull();

    fireEvent.change(width, { target: { value: "5" } });
    fireEvent.blur(width);

    expect(width.getAttribute("aria-invalid")).toBe("true");
    const describedBy = width.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах.",
    );

    // The other axis was never touched, so it must not be flagged.
    expect(height.getAttribute("aria-invalid")).toBeNull();
  });

  it("does not POST when Save is pressed while a size axis is flagged invalid", async () => {
    const user = userEvent.setup();
    const fetchMock = stubCreateFetch("new-5");

    renderCreateFlow();
    await chooseOption(user, "Размер", "Свой размер");
    const width = screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement;

    // Below the model's 10mm minimum -- the width axis stays flagged invalid
    // and its rejected text stays on screen (see the "invalid dimension"
    // test above); Save must not be usable while that is true.
    fireEvent.change(width, { target: { value: "5" } });
    fireEvent.blur(width);
    expect(
      screen.getAllByText("Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах."),
    ).toHaveLength(2);

    const save = screen.getByRole("button", { name: "Сохранить" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(save);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the size error once a subsequent valid size is committed", async () => {
    const user = userEvent.setup();
    renderCreateFlow();
    await chooseOption(user, "Размер", "Свой размер");
    const width = screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement;

    fireEvent.change(width, { target: { value: "900" } });
    fireEvent.blur(width);
    expect(
      screen.getAllByText("Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах."),
    ).toHaveLength(2);

    fireEvent.change(width, { target: { value: "90" } });
    fireEvent.blur(width);

    expect(
      screen.queryAllByText("Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах."),
    ).toHaveLength(0);
    expect(width.value).toBe("90.0");
  });

  it("keeps the invalid-dimension message up when the OTHER axis commits a valid size", async () => {
    const user = userEvent.setup();
    renderCreateFlow();
    await chooseOption(user, "Размер", "Свой размер");
    const width = screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement;
    const height = screen.getByLabelText("Высота этикетки, мм") as HTMLInputElement;

    fireEvent.change(width, { target: { value: "5" } });
    fireEvent.blur(width);
    expect(
      screen.getAllByText("Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах."),
    ).toHaveLength(2);

    // A valid commit on the height must not speak for the width: the rejected
    // "5" is still sitting in the width field, so its error has to stay --
    // and the height field itself must not pick up the flag either.
    fireEvent.change(height, { target: { value: "120" } });
    fireEvent.blur(height);

    expect(height.value).toBe("120.0");
    expect(height.getAttribute("aria-invalid")).toBeNull();
    expect(
      screen.getAllByText("Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах."),
    ).toHaveLength(2);
    expect(width.value).toBe("5");
  });

  it("does not resize or dirty the page when a size field is focused and blurred without typing", async () => {
    const user = userEvent.setup();
    renderCreateFlow();
    await chooseOption(user, "Размер", "Свой размер");
    const width = screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement;

    fireEvent.focus(width);
    fireEvent.blur(width);

    expect(width.value).toBe("58.0");
    expect(screen.queryByRole("alert")).toBeNull();
    // Nothing was dispatched, so the dirty guard must not intercept "back".
    fireEvent.click(screen.getByRole("link", { name: "← Шаблоны" }));
    expect(await screen.findByText("Library page")).toBeDefined();
  });

  it("discards a rejected custom size when a preset is chosen", async () => {
    const user = userEvent.setup();
    renderCreateFlow();
    await chooseOption(user, "Размер", "Свой размер");
    const width = screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement;

    fireEvent.change(width, { target: { value: "5" } });
    fireEvent.blur(width);
    expect(
      screen.getAllByText("Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах."),
    ).toHaveLength(2);

    await chooseOption(user, "Размер", "75×120");

    expect(
      screen.queryAllByText("Размер этикетки — от 10 до 300 мм. Введите значение в этих пределах."),
    ).toHaveLength(0);
    // Back to custom: the draft is gone, the inputs mirror the preset's spec.
    await chooseOption(user, "Размер", "Свой размер");
    expect((screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement).value).toBe("75.0");
  });

  it("clears the geometry error when a later import replaces the spec", () => {
    renderCreateFlow();
    importZpl(IMPORT_ZPL);

    const width = screen.getByLabelText("Ширина этикетки, мм");
    fireEvent.change(width, { target: { value: "10" } });
    fireEvent.blur(width);
    expect(
      screen.getByText("Элемент больше этикетки. Увеличьте этикетку или импортируйте код заново."),
    ).toBeDefined();

    importZpl(WIDE_IMPORT_ZPL);

    expect(
      screen.queryByText(
        "Элемент больше этикетки. Увеличьте этикетку или импортируйте код заново.",
      ),
    ).toBeNull();
  });
});

describe("Import is the only content path", () => {
  it("the deleted canvas-editor chrome is gone", () => {
    renderCreateFlow();

    // Palette buttons, per-element properties and the canvas itself.
    expect(screen.queryByRole("button", { name: "Текст" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Поле" })).toBeNull();
    expect(screen.queryByLabelText("X, мм")).toBeNull();
    expect(screen.queryByText("Выберите элемент на холсте")).toBeNull();

    // What IS offered instead.
    expect(screen.getByRole("button", { name: "Импорт кода" })).toBeDefined();
    expect(screen.getByText("предпросмотр = печать")).toBeDefined();
  });

  it("imported ZPL replaces the spec and Save POSTs it", async () => {
    const fetchMock = stubCreateFetch("new-3");

    renderCreateFlow();
    importZpl(IMPORT_ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const spec = postedSpec<{
      widthMm: number;
      heightMm: number;
      elements: Array<{ kind: string; field?: string }>;
    }>(fetchMock);
    expect(spec.widthMm).toBeCloseTo(58, 0);
    expect(spec.heightMm).toBeCloseTo(40, 0);
    expect(spec.elements).toHaveLength(2);
    expect(spec.elements[0]).toMatchObject({ kind: "text" });
    expect(spec.elements[1]).toMatchObject({ kind: "field", field: "qty" });
    expect(() => parseLabelTemplate(spec)).not.toThrow();
  });

  it("opens a labelled import dialog with every available template field", () => {
    renderCreateFlow();
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));

    expect(screen.getByRole("dialog", { name: "Импорт кода" })).toBeDefined();
    for (const placeholder of [
      "{{product.name}}",
      "{{product.printName}}",
      "{{product.gtin}}",
      "{{km.code}}",
      "{{sscc}}",
      "{{shift.no}}",
      "{{date}}",
      "{{qty}}",
      "{{operator}}",
      "{{counterparty.name}}",
    ]) {
      expect(screen.getByText(placeholder)).toBeDefined();
    }
  });

  it("requires acknowledgement for unsupported source lines and invalidates stale analysis", async () => {
    const user = userEvent.setup();
    renderCreateFlow();
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
    const dialog = screen.getByRole("dialog", { name: "Импорт кода" });
    const source = "^XA\n^PW799\n^LL400\n^FO10,10^FD{{product.name}}^FS\n^GFA,10,10,1,FF\n^XZ";
    fireEvent.change(within(dialog).getByLabelText("Код ZPL"), { target: { value: source } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));

    expect(await within(dialog).findByText("^GFA,10,10,1,FF")).toBeDefined();
    const replace = within(dialog).getByRole("button", { name: "Заменить этикетку" });
    expect(replace.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Удалить неподдерживаемые/ }));
    expect(replace.hasAttribute("disabled")).toBe(false);

    await chooseOption(user, "DPI импорта", "300 DPI");
    expect(replace.hasAttribute("disabled")).toBe(true);
  });

  it("copies an exact field placeholder and leaves the template name alone on replace", () => {
    const clipboard = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
    renderCreateFlow();

    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Новый шаблон");
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
    const dialog = screen.getByRole("dialog", { name: "Импорт кода" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Копировать {{product.name}}" }));
    expect(clipboard).toHaveBeenCalledWith("{{product.name}}");

    fireEvent.change(within(dialog).getByLabelText("Код ZPL"), {
      target: { value: "^XA\n^PW799\n^LL400\n^FO10,10^FD{{product.name}}^FS\n^XZ" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Заменить этикетку" }));

    expect(screen.queryByRole("dialog", { name: "Импорт кода" })).toBeNull();
    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Новый шаблон");
    // Importing marks the page dirty -- "back" is now guarded.
    fireEvent.click(screen.getByRole("link", { name: "← Шаблоны" }));
    expect(screen.getByRole("dialog", { name: "Отменить несохранённые изменения?" })).toBeDefined();
  });

  it("shows imported custom dimensions rounded to one decimal place in the size inputs", async () => {
    const user = userEvent.setup();
    renderCreateFlow();
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
    const dialog = screen.getByRole("dialog", { name: "Импорт кода" });
    fireEvent.change(within(dialog).getByLabelText("Код ZPL"), {
      target: { value: "^XA\n^PW685\n^LL472\n^XZ" },
    });
    await chooseOption(user, "DPI импорта", "300 DPI");
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Заменить этикетку" }));

    expect((screen.getByLabelText("Ширина этикетки, мм") as HTMLInputElement).value).toBe("58.0");
    expect((screen.getByLabelText("Высота этикетки, мм") as HTMLInputElement).value).toBe("40.0");
  });
});

describe("Edit flow (load + PATCH)", () => {
  it("loads an existing template and Save PATCHes it", async () => {
    const existingSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203 as const,
      language: "zpl" as const,
      elements: [],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/label-templates/tpl-9" && (!init || init.method === undefined)) {
        return jsonResponse(200, {
          id: "tpl-9",
          name: "Короб",
          spec: existingSpec,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        });
      }
      if (url === "/api/label-templates/tpl-9" && init?.method === "PATCH") {
        const body = JSON.parse(init.body as string) as { name: string; spec: unknown };
        return jsonResponse(200, {
          id: "tpl-9",
          name: body.name,
          spec: body.spec,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderEditFlow("tpl-9");

    const nameInput = (await screen.findByLabelText("Название")) as HTMLInputElement;
    expect(nameInput.value).toBe("Короб");

    fireEvent.change(nameInput, { target: { value: "Короб v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/label-templates/tpl-9",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    )!;
    const body = JSON.parse((patchCall[1] as RequestInit).body as string) as { name: string };
    expect(body.name).toBe("Короб v2");
    expect(await screen.findByText("Шаблон сохранён")).toBeDefined();
  });
});

describe("decodeRasterToRgba (pure bit-unpacking, no canvas needed)", () => {
  it("unpacks a 2x1 checkerboard (MSB-first, bit 1 = black) into the expected RGBA bytes", () => {
    // 2 pixels wide, 1 tall, 1 byte per row: 0b10000000 = black, white, then 6 padding bits.
    const raster: RasterResult = { hex: "80", totalBytes: 1, bytesPerRow: 1, width: 2, height: 1 };
    const rgba = decodeRasterToRgba(raster);
    expect(Array.from(rgba)).toEqual([
      0,
      0,
      0,
      255, // pixel 0: black, opaque
      255,
      255,
      255,
      255, // pixel 1: white, opaque
    ]);
  });
});

describe("rasterDestXPx (pure align-offset-to-px math, no canvas needed)", () => {
  it("returns xMm*scale unchanged when offsetDots is 0 (left-aligned / no maxWidth)", () => {
    expect(rasterDestXPx(5, 0, 203, 3)).toBe(15);
  });

  it("converts a non-zero dots offset to mm (at the given dpi) before adding and scaling", () => {
    // dotsToMm(203, 203) = 203/203*25.4 = 25.4mm exactly (1 inch at 203dpi).
    // (2mm + 25.4mm) * 3px/mm = 82.2.
    expect(rasterDestXPx(2, 203, 203, 3)).toBeCloseTo(82.2, 10);
  });
});

describe("Download (ZPL/TSPL byte safety)", () => {
  it("latin1ToUint8Array preserves a byte > 0x7F exactly (no UTF-8 mangling)", () => {
    const bytes = latin1ToUint8Array("ÿA");
    expect(Array.from(bytes)).toEqual([0xff, 0x41]);
  });

  it("buildZplBlob keeps a Latin-1 byte in ^FD data single-byte (no UTF-8 re-encoding)", async () => {
    const blob = buildZplBlob("^XA^FDé^FS^XZ");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes)).toContain(0xe9);
    expect(Array.from(bytes)).not.toContain(0xc3); // the UTF-8 lead byte "é" would become if re-encoded
  });

  it("Скачать ZPL produces a Blob whose text contains ^XA (and the raster fallback)", async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      capturedBlob = blob as Blob;
      return "blob:mock-url";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    renderCreateFlow();
    importZpl(CYRILLIC_FIELD_ZPL);

    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));

    await waitFor(() => expect(capturedBlob).toBeDefined());
    const text = await capturedBlob!.text();
    expect(text).toContain("^XA");
    expect(text).toContain("^GFA");
  });

  it("Скачать TSPL (TSC) preserves an injected raster byte > 0x7F intact in the downloaded Blob", async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      capturedBlob = blob as Blob;
      return "blob:mock-url";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    renderCreateFlow();
    importZpl(CYRILLIC_FIELD_ZPL);

    // No language setting is touched first -- the TSPL button generates from
    // the very same spec the ZPL button does.
    fireEvent.click(screen.getByRole("button", { name: "Скачать TSPL (TSC)" }));

    await waitFor(() => expect(capturedBlob).toBeDefined());
    const bytes = new Uint8Array(await capturedBlob!.arrayBuffer());
    // The fake rasterizer's all-white pixel (hex "00") comes out the other
    // side of TSPL's polarity inversion as byte 0xFF -- present here
    // ONLY if it survived as a single raw byte (the Uint8Array path), not
    // re-encoded into UTF-8's two-byte 0xC3 0xBF sequence.
    expect(Array.from(bytes)).toContain(0xff);
  });
});

describe("Dirty guard", () => {
  it("blocks 'back' behind a confirm modal once the spec is dirty, until confirmed", async () => {
    renderCreateFlow();

    importZpl(IMPORT_ZPL);

    fireEvent.click(screen.getByRole("link", { name: "← Шаблоны" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Отменить несохранённые изменения?")).toBeDefined();

    // Still on the editor -- navigation was blocked.
    expect(screen.queryByText("Library page")).toBeNull();

    // "Stay" just closes the modal, no navigation.
    fireEvent.click(within(dialog).getByRole("button", { name: "Остаться" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Library page")).toBeNull();

    // Back again, this time confirm discarding -> navigates away.
    fireEvent.click(screen.getByRole("link", { name: "← Шаблоны" }));
    const dialogAgain = await screen.findByRole("dialog");
    fireEvent.click(within(dialogAgain).getByRole("button", { name: "Отменить изменения" }));

    expect(await screen.findByText("Library page")).toBeDefined();
  });

  it("does not show a confirm modal on 'back' when nothing has changed", async () => {
    renderCreateFlow();

    fireEvent.click(screen.getByRole("link", { name: "← Шаблоны" }));

    expect(await screen.findByText("Library page")).toBeDefined();
  });
});

describe("Font coverage warnings (PreviewPane)", () => {
  it("shows the Cyrillic-missing warning when checkFamilyCoverage resolves false", async () => {
    renderCreateFlow({ checkFamilyCoverage: async () => false });

    importZpl(CYRILLIC_FIELD_ZPL);

    expect(
      await screen.findByText(
        "В выбранном шрифте нет кириллицы — текст напечатается растром. Возможна потеря чёткости.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByText(
        "Не удалось проверить шрифт — текст может напечататься не так, как в предпросмотре.",
      ),
    ).toBeNull();
  });

  it("shows a SEPARATE 'could not verify' warning when checkFamilyCoverage throws -- never an unhandled rejection", async () => {
    renderCreateFlow({
      checkFamilyCoverage: async () => {
        throw new Error("network down");
      },
    });

    importZpl(CYRILLIC_FIELD_ZPL);

    expect(
      await screen.findByText(
        "Не удалось проверить шрифт — текст может напечататься не так, как в предпросмотре.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByText(
        "В выбранном шрифте нет кириллицы — текст напечатается растром. Возможна потеря чёткости.",
      ),
    ).toBeNull();
  });
});
