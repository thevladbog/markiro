import { expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PALLET_REPRINT_V2_PROTOCOL } from "@markiro/domain";
import {
  a4PalletSource,
  sheetChoice,
} from "../../../packages/domain/test/support/pallet-reprint.js";
import { PalletTemplatePicker } from "../src/ui/warehouse-reprint/PalletTemplatePicker.js";
import i18n from "../src/i18n/index.js";
vi.mock("../src/lib/rasterizer.js", () => ({
  rasterizeDriverText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
}));
vi.mock("../src/ui/LabelRasterPreview.js", () => ({
  LabelRasterPreview: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}));
it("offers original outside the catalog and applies an independent landscape snapshot", async () => {
  await i18n.changeLanguage("ru");
  const source = a4PalletSource(),
    choice = sheetChoice(1),
    onApply = vi.fn(),
    before = JSON.stringify(source);
  const view = render(
    <PalletTemplatePicker
      source={source}
      catalog={{ protocol: PALLET_REPRINT_V2_PROTOCOL, templates: [choice] }}
      choice={null}
      profile={{
        id: "a4",
        name: "Office",
        target: { kind: "usb", printer: "Office" },
        mode: "windows_driver",
        paper: "a4",
        language: "zpl",
        dpi: 300,
      }}
      busy={false}
      onClose={() => {}}
      onApply={onApply}
    />,
  );
  try {
    expect(screen.getByRole("button", { name: /Исходный сохранённый макет/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(choice.name) }));
    await screen.findByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "Применить шаблоны" }));
    expect(onApply).toHaveBeenCalledWith(choice);
    expect(JSON.stringify(source)).toBe(before);
  } finally {
    view.unmount();
  }
});
