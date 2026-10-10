import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { StationClient } from "../src/lib/api-client.js";
import { DEFAULT_HARDWARE_CONFIG, type HardwareConfig } from "../src/lib/hardware-config.js";
import { NewShift, type NewShiftDraft } from "../src/pages/NewShift.js";

beforeAll(async () => i18n.changeLanguage("en"));
const draft: NewShiftDraft = {
  product: {
    id: "11111111-1111-4111-8111-111111111111",
    gtin14: "04600000000015",
    name: "Cola",
    boxCapacity: 12,
    palletBoxCapacity: 20,
  },
  productionDate: "",
  printEnabled: false,
  verificationRequired: true,
  productTemplateId: null,
  productTemplates: [],
  createdPrintShift: null,
};
const options = Array.from({ length: 8 }, (_, index) => ({
  id: `22222222-2222-4222-8222-22222222222${index}`,
  name: `Label ${index + 1}`,
  widthMm: 60,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
}));
const spec = { widthMm: 60, heightMm: 40, dpi: 203, language: "zpl", elements: [] };
type Purpose = "box" | "pallet" | "product_duplicate";

function deferred() {
  let resolve: (result: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setup(
  preview?: (query: URLSearchParams) => Promise<unknown>,
  isCurrent?: () => boolean,
  hardwareConfig?: HardwareConfig,
) {
  const previewReads: URLSearchParams[] = [];
  const get = vi.fn(async (path: string) => {
    const url = new URL(path, "https://api.example.test");
    if (url.pathname === "/shifts/label-template-preview") {
      previewReads.push(url.searchParams);
      if (preview) return preview(url.searchParams);
      const option = options.find(
        (candidate) => candidate.id === url.searchParams.get("templateId"),
      );
      return { id: option?.id, name: option?.name, purpose: url.searchParams.get("purpose"), spec };
    }
    if (url.pathname === "/shifts/planning-config")
      return { validationPrintProtocol: "validation-dm-duplicate-v1" };
    if (url.pathname.endsWith("product-label-templates"))
      return {
        items: options.map(({ id, name, widthMm, heightMm, dpi }) => ({
          id,
          name,
          widthMm,
          heightMm,
          dpi,
        })),
      };
    return {
      items: options,
      defaultBoxLabelTemplateId: options[0]?.id,
      defaultPalletLabelTemplateId: options[0]?.id,
    };
  });
  const post = vi.fn(async () => {
    throw new Error("Preview must not create or open shifts");
  });
  const client = { get, post } as unknown as StationClient;
  const props = {
    client,
    source: { start: () => () => undefined },
    initialDraft: draft,
    onStarted: vi.fn(),
    onBack: vi.fn(),
    ...(isCurrent ? { isCurrent } : {}),
    ...(hardwareConfig ? { hardwareConfig } : {}),
  };
  return { ...render(<NewShift {...props} />), props, client, get, post, previewReads };
}

async function openPicker(purpose: Purpose) {
  if (purpose === "product_duplicate") {
    fireEvent.click(screen.getByRole("button", { name: "Label printing: No printing" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Print duplicate Data Matrix").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
    fireEvent.click(screen.getByRole("button", { name: "Select a template" }));
    fireEvent.click(await screen.findByRole("button", { name: /Label 1/ }));
  } else {
    fireEvent.click(screen.getByRole("button", { name: "Aggregation" }));
    if (purpose === "pallet") fireEvent.click(screen.getByRole("button", { name: "With pallets" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByRole("button", { name: /Label 1/ });
    if (purpose === "pallet") {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await screen.findByText("Pallet label template");
    }
  }
}

describe("NewShift shared label selection and preview", () => {
  it("keeps a pending preview across parent rerenders with new ownership callback identities", async () => {
    const pending = deferred();
    const h = setup(
      () => pending.promise,
      () => true,
    );
    await openPicker("box");
    expect(h.previewReads).toHaveLength(1);
    h.rerender(<NewShift {...h.props} isCurrent={() => true} />);
    h.rerender(<NewShift {...h.props} isCurrent={() => true} />);
    expect(h.previewReads).toHaveLength(1);
    await act(async () =>
      pending.resolve({ id: options[0]?.id, name: "Stable preview", purpose: "box", spec }),
    );
    await screen.findByRole("img", { name: /Stable preview/ });
    expect(h.previewReads).toHaveLength(1);
  });

  it("uses the latest ownership callback to reject a pending preview after retirement", async () => {
    const pending = deferred();
    const h = setup(
      () => pending.promise,
      () => true,
    );
    await openPicker("box");
    h.rerender(<NewShift {...h.props} isCurrent={() => false} />);
    await act(async () =>
      pending.resolve({ id: options[0]?.id, name: "Retired response", purpose: "box", spec }),
    );
    expect(screen.queryByRole("img", { name: /Retired response/ })).toBeNull();
    expect(h.previewReads).toHaveLength(1);
  });
  it("retries a failed preview without altering the selected template or creating a shift", async () => {
    let failures = 1;
    const h = setup(async () => {
      if (failures-- > 0) throw new TypeError("Preview offline");
      return { id: options[0]?.id, name: "Recovered preview", purpose: "box", spec };
    });
    await openPicker("box");
    fireEvent.click(await screen.findByRole("button", { name: "Retry preview" }));
    await screen.findByRole("img", { name: /Recovered preview/ });
    expect(h.previewReads).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Label 1/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(h.post).not.toHaveBeenCalled();
  });

  it("renders the preview with the selected printer language and DPI", async () => {
    setup(undefined, undefined, {
      ...DEFAULT_HARDWARE_CONFIG,
      printer: { kind: "usb", printer: "Label printer" },
      printerDpi: 300,
      printerLanguage: "tspl",
    });
    await openPicker("box");
    const image = await screen.findByRole("img", { name: /Label 1/ });
    expect(image.getAttribute("data-dpi")).toBe("300");
    expect(image.getAttribute("data-language")).toBe("tspl");
    expect(image.getAttribute("viewBox")).toBe("0 0 709 472");
  });

  it.each(["box", "pallet", "product_duplicate"] as const)(
    "previews %s labels and exposes the entire searchable list without paging",
    async (purpose) => {
      const h = setup();
      await openPicker(purpose);
      expect(screen.getByRole("button", { name: /Label 8/ })).toBeDefined();
      await screen.findByRole("img", { name: /Label 1/ });
      const latest = h.previewReads.at(-1);
      expect(latest?.get("productId")).toBe(draft.product.id);
      expect(latest?.get("templateId")).toBe(options[0]?.id);
      expect(latest?.get("purpose")).toBe(purpose);
      expect(h.get).toHaveBeenCalledWith(
        expect.stringContaining("/shifts/label-template-preview?"),
        { displayOnly: true },
      );
      fireEvent.change(screen.getByLabelText("Search templates"), { target: { value: "Label 8" } });
      expect(screen.queryByRole("button", { name: /Label 1/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Label 8/ }));
      const image = await screen.findByRole("img", { name: /Label 8/ });
      expect(image.getAttribute("viewBox")).toBe("0 0 480 320");
      expect(screen.queryByRole("img", { name: /Label 1/ })).toBeNull();
      expect(h.post).not.toHaveBeenCalled();
    },
  );

  it("ignores an older selection response that resolves after the current preview", async () => {
    const first = deferred();
    const h = setup(async (query) =>
      query.get("templateId") === options[0]?.id
        ? first.promise
        : { id: options[1]?.id, name: "Current label", purpose: "box", spec },
    );
    await openPicker("box");
    fireEvent.click(screen.getByRole("button", { name: /Label 2/ }));
    await screen.findByRole("img", { name: /Current label/ });
    await act(async () =>
      first.resolve({ id: options[0]?.id, name: "Old label", purpose: "box", spec }),
    );
    expect(screen.queryByRole("img", { name: /Old label/ })).toBeNull();
    expect(screen.getByRole("img", { name: /Current label/ })).toBeDefined();
    expect(h.post).not.toHaveBeenCalled();
  });

  it.each(["back", "retired", "client"] as const)(
    "ignores a pending preview after %s changes its owner",
    async (change) => {
      let current = true;
      const pending = deferred();
      const h = setup(
        () => pending.promise,
        () => current,
      );
      await openPicker("box");
      if (change === "back") fireEvent.click(screen.getByRole("button", { name: "Back" }));
      if (change === "retired") current = false;
      if (change === "client")
        h.rerender(
          <NewShift
            {...h.props}
            client={{
              ...h.client,
              get: async <T,>() =>
                ({ id: options[0]?.id, name: "New client label", purpose: "box", spec }) as T,
            }}
          />,
        );
      await act(async () =>
        pending.resolve({ id: options[0]?.id, name: "Retired label", purpose: "box", spec }),
      );
      expect(screen.queryByRole("img", { name: /Retired label/ })).toBeNull();
      if (change === "client") await screen.findByRole("img", { name: /New client label/ });
    },
  );

  it.each([
    { id: options[1]?.id, purpose: "box", spec },
    { id: options[0]?.id, purpose: "pallet", spec },
    { id: options[0]?.id, purpose: "box", spec: { ...spec, dpi: 150 } },
  ])(
    "refuses mismatched or invalid preview response %# without changing selection",
    async (response) => {
      setup(async () => ({ name: "Rejected label", ...response }));
      await openPicker("box");
      await screen.findByText("Could not render the label sample");
      expect(screen.queryByRole("img")).toBeNull();
      expect(screen.getByRole("button", { name: /Label 1/ }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(screen.getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(false);
    },
  );
});
