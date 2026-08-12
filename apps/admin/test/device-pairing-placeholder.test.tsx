import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import { PairingCodePanel } from "../src/pages/devices/PairingCodePanel.js";
import {
  PAIRING_BARCODE_HEIGHT,
  PAIRING_BARCODE_WIDTH,
} from "../src/pages/kiosks/pairingBarcodeBox.js";

vi.mock("../src/pages/devices/PairingBarcode.js", () => ({
  default: () => {
    throw new Promise<never>(() => {});
  },
}));

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("ru");
});

it("keeps the station barcode placeholder on the opaque scan surface", async () => {
  render(
    <ThemeProvider defaultTheme="dark">
      <PairingCodePanel
        pairing={{ code: "12345678", expiresAt: new Date(Date.now() + 60_000).toISOString() }}
        issuedAt={new Date().toISOString()}
        deviceName="Packing"
        deviceType="station"
        placeName="Розлив"
        organizationName="Markiro"
        regenerating={false}
        onRegenerate={() => {}}
      />
    </ThemeProvider>,
  );

  const label = await screen.findByText("Загрузка штрихкода…");
  const box = label.closest<HTMLElement>("[aria-busy='true']");

  expect(box).not.toBeNull();
  expect(box!.style.width).toBe(`${PAIRING_BARCODE_WIDTH}px`);
  expect(box!.style.height).toBe(`${PAIRING_BARCODE_HEIGHT}px`);
  expect(box!.style.background).toBe("rgb(255, 255, 255)");
  expect(box!.style.padding).toBe("8px");
  expect(box!.style.boxSizing).toBe("content-box");
  expect(box!.style.border).toBe("1px solid var(--line)");
});
