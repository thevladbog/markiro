import type * as Domain from "@markiro/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildDefaultLabelTemplates, renderMonoLabel } from "@markiro/domain";
import { TemplateThumb } from "../src/pages/labels/TemplateThumb.js";
import { loadCabinetSheetBranding } from "../src/pages/labels/editor/sheet/sheet-branding.js";
import { paintSheetRaster } from "../src/pages/labels/editor/sheet/sheet-preview.js";
const spec = buildDefaultLabelTemplates().find((t) => t.name === "Коробка 100×100")!.spec;
const template = { spec, purpose: "box" };
vi.mock("../src/pages/labels/api.js", () => ({ useLabelTemplate: () => ({ data: template }) }));
vi.mock("@markiro/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof Domain>()),
  renderMonoLabel: vi.fn(async () => ({ width: 1, height: 1 })),
}));
vi.mock("../src/pages/labels/editor/sheet/sheet-branding.js", () => ({
  loadCabinetSheetBranding: vi.fn(),
}));
vi.mock("../src/pages/labels/editor/sheet/sheet-preview.js", () => ({ paintSheetRaster: vi.fn() }));
const branding = {
  organizationName: "Plant",
  logo: {
    width: 1,
    height: 1,
    stride: 1,
    pixels: Uint8Array.of(128),
    digest: "test",
    source: "markiro" as const,
  },
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
function cards(client: QueryClient, ids: string[]) {
  return (
    <QueryClientProvider client={client}>
      {ids.map((id) => (
        <TemplateThumb key={id} id={id} widthMm={100} heightMm={100} />
      ))}
    </QueryClientProvider>
  );
}
function setup() {
  const context = { clearRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
it("shares in-flight and resolved branding across cards, and reloads after profile invalidation", async () => {
  const client = setup();
  let resolve!: (value: typeof branding) => void;
  vi.mocked(loadCabinetSheetBranding)
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValue(branding);
  const view = render(cards(client, ["a", "b"]));
  await waitFor(() => expect(loadCabinetSheetBranding).toHaveBeenCalledTimes(1));
  resolve(branding);
  await waitFor(() => expect(paintSheetRaster).toHaveBeenCalledTimes(2));
  view.rerender(cards(client, ["a", "b", "c"]));
  await waitFor(() => expect(paintSheetRaster).toHaveBeenCalledTimes(3));
  expect(loadCabinetSheetBranding).toHaveBeenCalledTimes(1);
  await client.invalidateQueries({ queryKey: ["org-profile"] });
  view.rerender(cards(client, ["a", "b", "c", "d"]));
  await waitFor(() => expect(paintSheetRaster).toHaveBeenCalledTimes(4));
  expect(loadCabinetSheetBranding).toHaveBeenCalledTimes(2);
  client.clear();
});
it("does not render or paint an unmounted card when its shared branding resolves", async () => {
  const client = setup();
  let resolve!: (value: typeof branding) => void;
  vi.mocked(loadCabinetSheetBranding).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = render(cards(client, ["a", "b"]));
  await waitFor(() => expect(loadCabinetSheetBranding).toHaveBeenCalled());
  view.unmount();
  resolve(branding);
  await new Promise((r) => setTimeout(r, 0));
  expect(renderMonoLabel).not.toHaveBeenCalled();
  expect(paintSheetRaster).not.toHaveBeenCalled();
  client.clear();
});
it("does not reuse branding between identity-owned query clients", async () => {
  const first = setup(),
    second = new QueryClient();
  vi.mocked(loadCabinetSheetBranding).mockResolvedValue(branding);
  const view = render(cards(first, ["a"]));
  await waitFor(() => expect(paintSheetRaster).toHaveBeenCalledTimes(1));
  view.unmount();
  render(cards(second, ["b"]));
  await waitFor(() => expect(paintSheetRaster).toHaveBeenCalledTimes(2));
  expect(loadCabinetSheetBranding).toHaveBeenCalledTimes(2);
  first.clear();
  second.clear();
});
