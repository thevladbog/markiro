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
