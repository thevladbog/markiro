import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { TemplatePicker } from "../src/ui/warehouse-reprint/TemplatePicker.js";
import {
  warehouseBoxTemplate,
  buildWarehouseCodeOnlyLabelTemplate,
  productLabelValueDigest,
  WAREHOUSE_REPRINT_PROTOCOL,
  type WarehouseTemplateCatalog,
} from "@markiro/domain";

vi.mock("../src/lib/rasterizer.js", () => ({
  rasterizeText: vi.fn(async () => ({ base64: "AA==", width: 8, height: 1, bytesPerRow: 1 })),
}));
beforeAll(async () => {
  await i18n.changeLanguage("ru");
});
it("searches enabled templates and refuses a disabled selection and its preview", async () => {
  const boxTemplate = warehouseBoxTemplate();
  const { digest, ...value } = {
    ...boxTemplate,
    id: "00000000-0000-4000-8000-000000000040",
    name: "Только код",
    purpose: "product_duplicate" as const,
    spec: buildWarehouseCodeOnlyLabelTemplate().spec,
  };
  void digest;
  const unitTemplate = { ...value, digest: productLabelValueDigest(value) };
  const catalog: WarehouseTemplateCatalog = {
    protocol: WAREHOUSE_REPRINT_PROTOCOL,
    revision: productLabelValueDigest([unitTemplate, boxTemplate]),
    templates: [unitTemplate, boxTemplate],
  };
  const unit = catalog.templates.find((t) => t.purpose === "product_duplicate");
  const box = catalog.templates.find((t) => t.purpose === "box");
  if (!unit || !box) throw new Error("fixture");
  render(
    <TemplatePicker
      catalog={{ ...catalog, templates: [{ ...unit, enabled: false }, box] }}
      unitTemplate={unit}
      boxTemplate={box}
      onApply={vi.fn()}
      onCancel={vi.fn()}
      unitDpi={null}
      boxDpi={null}
      unitLanguage={null}
      boxLanguage={null}
    />,
  );
  expect(screen.queryByRole("radio", { name: /Только код/ })).toBeNull();
  expect(screen.queryByRole("img", { name: /Только код/ })).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Применить шаблоны" }).disabled,
  ).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Короба · SSCC" })));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "нет такого" } });
  expect(screen.queryByRole("radio")).toBeNull();
});

it("does not apply a box template restored into the unit selection", () => {
  const box = warehouseBoxTemplate();
  const catalog: WarehouseTemplateCatalog = {
    protocol: WAREHOUSE_REPRINT_PROTOCOL,
    revision: productLabelValueDigest([box]),
    templates: [box],
  };
  render(
    <TemplatePicker
      catalog={catalog}
      unitTemplate={box}
      boxTemplate={box}
      onApply={vi.fn()}
      onCancel={vi.fn()}
      unitDpi={null}
      boxDpi={null}
      unitLanguage={null}
      boxLanguage={null}
    />,
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Применить шаблоны" }).disabled,
  ).toBe(true);
});

it("adds the third choice before the session and filters pallet paper by the configured printer", async () => {
  const { thermalChoice, sheetChoice } =
    await import("../../../packages/domain/test/support/pallet-reprint.js");
  const { PALLET_REPRINT_V2_PROTOCOL } = await import("@markiro/domain");
  const box = warehouseBoxTemplate(),
    { digest: discarded, ...body } = box;
  void discarded;
  const unitBody = {
    ...body,
    id: "00000000-0000-4000-8000-000000000040",
    purpose: "product_duplicate" as const,
    spec: buildWarehouseCodeOnlyLabelTemplate().spec,
  };
  const unit = { ...unitBody, digest: productLabelValueDigest(unitBody) };
  const thermal = thermalChoice(),
    sheet = sheetChoice();
  const catalog: WarehouseTemplateCatalog = {
    protocol: WAREHOUSE_REPRINT_PROTOCOL,
    revision: productLabelValueDigest([unit, box]),
    templates: [unit, box],
  };
  const apply = vi.fn();
  render(
    <TemplatePicker
      catalog={catalog}
      unitTemplate={unit}
      boxTemplate={box}
      palletTemplate={null}
      palletCatalog={{ protocol: PALLET_REPRINT_V2_PROTOCOL, templates: [thermal, sheet] }}
      palletPaper="thermal"
      onApply={apply}
      onCancel={vi.fn()}
      unitDpi={203}
      boxDpi={203}
      unitLanguage="tspl"
      boxLanguage="tspl"
    />,
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Палеты · SSCC" })));
  expect(screen.queryByRole("radio", { name: new RegExp(sheet.name) })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(thermal.name) }));
  fireEvent.click(screen.getByRole("button", { name: "Применить шаблоны" }));
  expect(apply).toHaveBeenCalledWith(unit, box, thermal);
});

it("allows the two existing choices when the pallet catalog is unavailable", () => {
  const box = warehouseBoxTemplate();
  const { digest, ...value } = {
    ...box,
    id: "00000000-0000-4000-8000-000000000040",
    name: "Unit",
    purpose: "product_duplicate" as const,
    spec: buildWarehouseCodeOnlyLabelTemplate().spec,
  };
  void digest;
  const unit = { ...value, digest: productLabelValueDigest(value) },
    apply = vi.fn();
  render(
    <TemplatePicker
      catalog={{
        protocol: WAREHOUSE_REPRINT_PROTOCOL,
        revision: productLabelValueDigest([unit, box]),
        templates: [unit, box],
      }}
      unitTemplate={unit}
      boxTemplate={box}
      palletCatalog={null}
      onApply={apply}
      onCancel={vi.fn()}
      unitDpi={203}
      boxDpi={203}
      unitLanguage="tspl"
      boxLanguage="tspl"
    />,
  );
  expect(screen.queryByRole("button", { name: "Палеты · SSCC" })).toBeNull();
  const button = screen.getByRole<HTMLButtonElement>("button", { name: "Применить шаблоны" });
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  expect(apply).toHaveBeenCalledWith(unit, box);
});
