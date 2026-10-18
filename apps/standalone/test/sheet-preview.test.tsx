import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPalletSheetPresets, type MonoBitmap, type MonoRaster } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import { loadBundledMarkiroLogo, logoToWire } from "../src/labels/logo.js";
import { paintMonoRaster, renderSheetRaster } from "../src/labels/sheet-render.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { SheetPreview } from "../src/office/sheets/SheetPreview.js";
import { fakeOfficeSession, ORG_PROFILE, type FakeOfficeSession } from "./support/office.js";

import type * as SheetRenderModule from "../src/labels/sheet-render.js";
import type * as LogoModule from "../src/labels/logo.js";

// The domain renderer needs a canvas and a font: the preview's own wiring is what is tested.
vi.mock("../src/labels/sheet-render.js", async (importActual) => {
  const actual = await importActual<typeof SheetRenderModule>();
  return { ...actual, renderSheetRaster: vi.fn(), paintMonoRaster: vi.fn() };
});
vi.mock("../src/labels/logo.js", async (importActual) => {
  const actual = await importActual<typeof LogoModule>();
  return { ...actual, loadBundledMarkiroLogo: vi.fn() };
});

const [PORTRAIT, LANDSCAPE] = buildPalletSheetPresets();
if (PORTRAIT === undefined || LANDSCAPE === undefined) throw new Error("no stock sheets");

const MARKIRO: MonoBitmap = { width: 8, height: 8, stride: 1, pixels: new Uint8Array(8).fill(1) };
const OWN: MonoBitmap = { width: 16, height: 8, stride: 2, pixels: new Uint8Array(16).fill(0x80) };

function raster(mark: number): MonoRaster {
  return {
    format: "mono-raster-v1",
    widthMm: 210,
    heightMm: 297,
    dpi: 300,
    widthDots: 8,
    heightDots: 8,
    stride: 1,
    requiredBounds: { left: 0, top: 0, right: 8, bottom: 8 },
    pixels: new Uint8Array(8).fill(mark),
  };
}

function session(logo: ReturnType<typeof logoToWire> | null): FakeOfficeSession {
  const fake = fakeOfficeSession();
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.getOrgLogo.mockResolvedValue({
    logo: logo === null ? null : { ...logo, updatedAt: "2026-10-11T09:00:00Z" },
  });
  return fake;
}

function tree(fake: FakeOfficeSession, spec = PORTRAIT?.spec): ReactElement {
  if (spec === undefined) throw new Error("no spec");
  return (
    <QueryClientProvider client={createOfficeQueryClient()}>
      <OfficeSessionProvider value={fake}>
        <SheetPreview spec={spec} label="Книжный лист" />
      </OfficeSessionProvider>
    </QueryClientProvider>
  );
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

beforeEach(() => {
  vi.mocked(renderSheetRaster).mockReset().mockResolvedValue(raster(1));
  vi.mocked(paintMonoRaster).mockReset();
  vi.mocked(loadBundledMarkiroLogo).mockReset().mockResolvedValue(MARKIRO);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the preview of an A4 sheet", () => {
  it("draws the sheet for the organization's name and INN with the Markiro logo when there is no own logo", async () => {
    render(tree(session(null)));
    const canvas = screen.getByRole("img", { name: "Книжный лист" });
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    expect(paintMonoRaster).toHaveBeenCalledWith(canvas, raster(1), 4);
    expect(renderSheetRaster).toHaveBeenCalledTimes(1);
    const [spec, context] = vi.mocked(renderSheetRaster).mock.calls[0] ?? [];
    expect(spec).toBe(PORTRAIT?.spec);
    expect(context).toMatchObject({
      organizationName: "ООО «Атолл»",
      organizationInn: "7701234567",
      sscc: "199990000000000012",
      logo: { source: "markiro", width: 8, height: 8 },
    });
    expect(context?.logo.pixels).toEqual(MARKIRO.pixels);
  });

  it("draws the organization's own logo and does not load the bundled one", async () => {
    render(tree(session(logoToWire(OWN))));
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    const context = vi.mocked(renderSheetRaster).mock.calls[0]?.[1];
    expect(context?.logo).toMatchObject({ source: "organization", width: 16, height: 8 });
    expect(context?.logo.pixels).toEqual(OWN.pixels);
    expect(loadBundledMarkiroLogo).not.toHaveBeenCalled();
  });

  it("falls back to the Markiro logo for a stored logo this build cannot read", async () => {
    render(tree(session({ width: 16, height: 8, pixelsBase64: "AAAA" })));
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    expect(vi.mocked(renderSheetRaster).mock.calls[0]?.[1].logo.source).toBe("markiro");
  });

  it("waits for the organization and its logo before it draws, and says it is loading", async () => {
    const fake = session(null);
    const org = deferred<typeof ORG_PROFILE>();
    fake.api.getOrg.mockReturnValue(org.promise);
    render(tree(fake));
    expect(await screen.findByText("Загрузка…")).toBeTruthy();
    expect(renderSheetRaster).not.toHaveBeenCalled();
    await act(async () => {
      org.resolve(ORG_PROFILE);
      await org.promise;
    });
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Загрузка…")).toBeNull();
  });

  it("says so when the sheet does not render, and keeps the canvas", async () => {
    vi.mocked(renderSheetRaster).mockRejectedValue(new RangeError("the text does not fit"));
    render(tree(session(null)));
    expect(
      await screen.findByText("Лист не отрисовался: текст не помещается или шрифт не загрузился."),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "Книжный лист" })).toBeTruthy();
    expect(paintMonoRaster).not.toHaveBeenCalled();
  });

  it("says so when the bundled logo cannot be decoded", async () => {
    vi.mocked(loadBundledMarkiroLogo).mockRejectedValue(new Error("no canvas"));
    render(tree(session(null)));
    await screen.findByText("Лист не отрисовался: текст не помещается или шрифт не загрузился.");
    expect(renderSheetRaster).not.toHaveBeenCalled();
  });

  it.each([
    ["the organization", "getOrg"],
    ["its logo", "getOrgLogo"],
  ] as const)(
    "says the preview is unavailable when %s did not load, and draws nothing",
    async (_what, call) => {
      const fake = session(null);
      fake.api[call].mockRejectedValue(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      );
      render(tree(fake));
      expect(
        await screen.findByText(
          "Организация или её логотип не загрузились: просмотр недоступен. Закройте окно и откройте его снова.",
        ),
      ).toBeTruthy();
      expect(renderSheetRaster).not.toHaveBeenCalled();
      expect(screen.queryByText("Загрузка…")).toBeNull();
    },
  );

  it("does not draw again for a render of the same sheet", async () => {
    const fake = session(null);
    const view = render(tree(fake));
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    view.rerender(tree(fake));
    await act(async () => {
      await Promise.resolve();
    });
    expect(renderSheetRaster).toHaveBeenCalledTimes(1);
  });

  it("draws another sheet afresh and drops a slow draw of the earlier one", async () => {
    const fake = session(null);
    const slow = deferred<MonoRaster>();
    vi.mocked(renderSheetRaster).mockReturnValueOnce(slow.promise).mockResolvedValueOnce(raster(2));
    const client = createOfficeQueryClient();
    const element = (spec: typeof PORTRAIT.spec) => (
      <QueryClientProvider client={client}>
        <OfficeSessionProvider value={fake}>
          <SheetPreview spec={spec} label="Лист" />
        </OfficeSessionProvider>
      </QueryClientProvider>
    );
    const view = render(element(PORTRAIT.spec));
    await waitFor(() => expect(renderSheetRaster).toHaveBeenCalledTimes(1));
    view.rerender(element(LANDSCAPE.spec));
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    expect(vi.mocked(renderSheetRaster).mock.calls[1]?.[0]).toBe(LANDSCAPE.spec);
    await act(async () => {
      slow.resolve(raster(1));
      await slow.promise;
    });
    expect(paintMonoRaster).toHaveBeenCalledTimes(1);
    expect(vi.mocked(paintMonoRaster).mock.calls[0]?.[1]).toEqual(raster(2));
  });

  it("paints nothing after it is gone", async () => {
    const slow = deferred<MonoRaster>();
    vi.mocked(renderSheetRaster).mockReturnValueOnce(slow.promise);
    const view = render(tree(session(null)));
    await waitFor(() => expect(renderSheetRaster).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      slow.resolve(raster(1));
      await slow.promise;
    });
    expect(paintMonoRaster).not.toHaveBeenCalled();
  });

  it("does not show a failure of a draw that was replaced", async () => {
    const fake = session(null);
    const failing = deferred<MonoRaster>();
    vi.mocked(renderSheetRaster)
      .mockReturnValueOnce(failing.promise)
      .mockResolvedValueOnce(raster(2));
    const client = createOfficeQueryClient();
    const element = (spec: typeof PORTRAIT.spec) => (
      <QueryClientProvider client={client}>
        <OfficeSessionProvider value={fake}>
          <SheetPreview spec={spec} label="Лист" />
        </OfficeSessionProvider>
      </QueryClientProvider>
    );
    const view = render(element(PORTRAIT.spec));
    await waitFor(() => expect(renderSheetRaster).toHaveBeenCalledTimes(1));
    view.rerender(element(LANDSCAPE.spec));
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    await act(async () => {
      failing.reject(new RangeError("the text does not fit"));
      await failing.promise.catch(() => undefined);
    });
    expect(screen.queryByText(/Лист не отрисовался/)).toBeNull();
  });
});
