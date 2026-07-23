/**
 * Plan 04 Task 10: label editor chrome -- palette, properties, preview,
 * save/export. Covers the plan brief's explicit test list:
 *
 *  - palette click adds an element (centered, auto-selected);
 *  - a properties-panel X change round-trips into the spec the "Save"
 *    button POSTs;
 *  - a dpi/language change (label-level) round-trips the same way;
 *  - "Скачать ZPL"/"Скачать TSPL" produce a real, byte-safe download --
 *    ZPL's Blob text contains `^XA`; TSPL's Blob bytes preserve an injected
 *    raster byte > 0x7F intact (never UTF-8-mangled into two bytes);
 *  - Save POSTs a `parseLabelTemplate`-valid spec and navigates
 *    (create flow) / PATCHes an existing template (edit flow);
 *  - the dirty-guard confirm modal blocks "back" until confirmed;
 *  - the font-coverage check surfaces two DISTINCT warnings: "no
 *    Cyrillic in this font" (coverage resolves `false`) vs. "could not
 *    verify" (coverage throws/rejects) -- never an unhandled rejection.
 *
 * A fake `rasterizeText` (deterministic single-pixel `RasterResult`) is
 * injected into every render, per the plan's "injectable, default real"
 * hard rule -- this is what lets `generateZpl`/`generateTspl` actually
 * reach their rasterized-fallback branch under jsdom (the REAL rasterizer
 * always throws `RasterUnavailableError` there, see `labels-raster.test.ts`).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseLabelTemplate, type RasterResult, type RasterizeTextFn } from "@markiro/domain";

import { buildZplBlob, latin1ToUint8Array } from "../src/pages/labels/editor/download.js";
import { LabelEditorPage } from "../src/pages/labels/editor/index.js";
import { decodeRasterToRgba, rasterDestXPx } from "../src/pages/labels/editor/raster-preview.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

describe("Palette", () => {
  it("clicking a palette button adds an element centered on the label and selects it", async () => {
    renderCreateFlow();

    fireEvent.click(screen.getByRole("button", { name: "Текст" }));

    expect(await screen.findByText("Выбрано: Текст")).toBeDefined();
    // Default create spec is 100x100mm -> center is (50, 50).
    expect((screen.getByLabelText("X, мм") as HTMLInputElement).value).toBe("50");
    expect((screen.getByLabelText("Y, мм") as HTMLInputElement).value).toBe("50");
  });
});

describe("PropertiesPanel + Save (round-trip into the POSTed spec)", () => {
  it("an X change round-trips into the spec Save POSTs", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/label-templates" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { name: string; spec: unknown };
        return jsonResponse(201, {
          id: "new-1",
          name: body.name,
          spec: body.spec,
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCreateFlow();

    fireEvent.click(screen.getByRole("button", { name: "Текст" }));
    fireEvent.change(screen.getByLabelText("X, мм"), { target: { value: "77" } });

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      name: string;
      spec: { elements: Array<{ xMm: number }> };
    };
    expect(body.spec.elements[0]?.xMm).toBe(77);
    expect(() => parseLabelTemplate(body.spec)).not.toThrow();
  });

  it("a dpi/language change (label-level) round-trips into the POSTed spec", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/label-templates" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { name: string; spec: unknown };
        return jsonResponse(201, {
          id: "new-1",
          name: body.name,
          spec: body.spec,
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCreateFlow();

    fireEvent.change(screen.getByLabelText("DPI"), { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText("Язык"), { target: { value: "tspl" } });

    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      spec: { dpi: number; language: string };
    };
    expect(body.spec.dpi).toBe(300);
    expect(body.spec.language).toBe("tspl");
  });

  it("Save POSTs a parseable spec and navigates to /labels/:id (create flow)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/label-templates" && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { name: string; spec: unknown };
        return jsonResponse(201, {
          id: "brand-new-id",
          name: body.name,
          spec: body.spec,
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCreateFlow();
    fireEvent.click(screen.getByRole("button", { name: "Текст" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Editor route: brand-new-id")).toBeDefined();
  });

  it("loads an existing template (edit mode) and Save PATCHes it", async () => {
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
          updatedAt: "2026-07-23T00:00:00.000Z",
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

  it("Скачать ZPL produces a Blob whose text contains ^XA", async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      capturedBlob = blob as Blob;
      return "blob:mock-url";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    renderCreateFlow();
    // A field element bound to a Cyrillic sample value so generateZpl
    // actually exercises the rasterized-fallback (`^GFA`) branch too.
    fireEvent.click(screen.getByRole("button", { name: "Поле" }));

    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));

    await waitFor(() => expect(capturedBlob).toBeDefined());
    const text = await capturedBlob!.text();
    expect(text).toContain("^XA");
    expect(text).toContain("^GFA");
  });

  it("Скачать TSPL preserves an injected raster byte > 0x7F intact in the downloaded Blob", async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      capturedBlob = blob as Blob;
      return "blob:mock-url";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    renderCreateFlow();
    fireEvent.click(screen.getByRole("button", { name: "Поле" }));
    fireEvent.change(screen.getByLabelText("Язык"), { target: { value: "tspl" } });

    fireEvent.click(screen.getByRole("button", { name: "Скачать TSPL" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Текст" }));

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

describe("Zoom captions (LabelCanvas + PreviewPane)", () => {
  it("shows each canvas's own zoom caption (LabelCanvas 4px/mm, PreviewPane 3px/mm)", () => {
    renderCreateFlow();

    expect(screen.getByText("масштаб 4 px/мм")).toBeDefined();
    expect(screen.getByText("масштаб 3 px/мм")).toBeDefined();
  });
});

describe("Font coverage warnings (PreviewPane)", () => {
  it("shows the Cyrillic-missing warning when checkFamilyCoverage resolves false", async () => {
    renderCreateFlow({ checkFamilyCoverage: async () => false });

    // A field bound to a Cyrillic sample value triggers needsImageRendering,
    // which is what makes the coverage check relevant at all.
    fireEvent.click(screen.getByRole("button", { name: "Поле" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Поле" }));

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
