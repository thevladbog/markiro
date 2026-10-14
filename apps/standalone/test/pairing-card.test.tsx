import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PairingCode } from "../src/host/protocol.js";
import { FormPrinterProvider } from "../src/office/forms/form-printer-context.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { PairingCodeDialog } from "../src/office/devices/PairingCodeDialog.js";
import {
  pairingCardData,
  pairingCardPdf,
  pdfOfImage,
  type CardImage,
  type CardRasterizer,
} from "../src/office/devices/pairing-card.js";
import { fakeOfficeSession } from "./support/office.js";

const downloads: { blob: Blob; name: string }[] = [];
vi.mock("../src/office/templates/download.js", () => ({
  downloadFile: (blob: Blob, name: string) => downloads.push({ blob, name }),
}));

const FINGERPRINT = "ab".repeat(32);
const CODE: PairingCode = {
  id: "0f1e2d3c-4b5a-4968-8776-655443322110",
  code: "7K3MQ9XV2D",
  createdAt: "2026-10-14T09:00:00.000Z",
  expiresAt: "2026-10-14T09:10:00.000Z",
  payload: `markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`,
};
const TEN_MINUTES = 600_000;
const IMAGE: CardImage = { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 4, height: 6 };

function bytesToText(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

describe("the pairing card data", () => {
  it("is read from the code on screen: addresses with the port, the fingerprint grouped, ten minutes", () => {
    const data = pairingCardData(CODE, Date.UTC(2026, 9, 14, 11, 35), TEN_MINUTES);
    expect(data).toMatchObject({
      payload: CODE.payload,
      code: "7K3MQ9XV2D",
      addresses: ["10.0.0.5:45710", "192.168.1.10:45710"],
      fingerprint: "ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB",
      validMinutes: 10,
      organizationName: null,
    });
    expect(data?.validUntil).toMatch(/^\d{2}:\d{2}$/u);
  });

  it("is nothing for a payload that cannot be read", () => {
    expect(pairingCardData({ ...CODE, payload: "markiro-host:1?x=1" }, 0, TEN_MINUTES)).toBeNull();
  });
});

describe("the pairing card as a PDF", () => {
  it("is one page of the card's size with the JPEG as its image and a cross-reference table that is exact", () => {
    const pdf = pdfOfImage(IMAGE, 210, 297);
    const text = bytesToText(pdf);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(text).toContain("/Filter /DCTDecode /Length 4");
    expect(text).toContain("/Width 4 /Height 6");
    const startxref = Number(/startxref\n(\d+)\n/u.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gmu)];
    expect(entries).toHaveLength(5);
    entries.forEach((entry, index) => {
      const offset = Number(entry[1]);
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });

  it("sizes the page by A5 too, and draws the card through the rasterizer it is given", async () => {
    const rasterize = vi.fn<CardRasterizer>(async () => IMAGE);
    const data = pairingCardData(CODE, 0, TEN_MINUTES)!;
    const blob = await pairingCardPdf(data, "a5", rasterize);
    expect(rasterize).toHaveBeenCalledWith(data, "a5");
    expect(blob.type).toBe("application/pdf");
    expect(bytesToText(new Uint8Array(await blob.arrayBuffer()))).toContain(
      "/MediaBox [0 0 419.53 595.28]",
    );
  });
});

describe("the pairing card in the pairing dialog", () => {
  beforeEach(() => {
    downloads.length = 0;
    localStorage.clear();
    sessionStorage.clear();
  });

  function show(rasterize: CardRasterizer, print: (html: string) => void) {
    const fake = fakeOfficeSession();
    fake.api.listDevices.mockResolvedValue([]);
    render(
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={fake}>
          <FormPrinterProvider value={print}>
            <PairingCodeDialog
              code={CODE}
              deadline={Date.now() + TEN_MINUTES}
              regenerating={false}
              failure={null}
              onRegenerate={() => undefined}
              onClose={() => undefined}
              rasterize={rasterize}
            />
          </FormPrinterProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    return screen.getByRole("dialog");
  }

  it("prints the card on A4 by default and on A5 when asked: the code, the addresses and the fingerprint on it", () => {
    const print = vi.fn<(html: string) => void>();
    const dialog = show(vi.fn<CardRasterizer>(), print);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    const a4 = print.mock.calls[0]?.[0] ?? "";
    expect(a4).toContain("@page { size: A4 portrait; margin: 0 }");
    expect(a4).toContain("7K3MQ 9XV2D");
    expect(a4).toContain("10.0.0.5:45710<br/>192.168.1.10:45710");
    expect(a4).toContain("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB");
    expect(a4).toContain("10 мин, код одноразовый");
    fireEvent.click(within(dialog).getByRole("radio", { name: "A5" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(print.mock.calls[1]?.[0]).toContain("@page { size: A5 portrait; margin: 0 }");
  });

  it("downloads the card as a PDF file named by its paper, and keeps nothing of the code", async () => {
    const rasterize = vi.fn<CardRasterizer>(async () => IMAGE);
    const dialog = show(rasterize, vi.fn());
    fireEvent.click(within(dialog).getByRole("button", { name: "Скачать PDF" }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]?.name).toBe("Подключение устройства A4.pdf");
    expect(downloads[0]?.blob.type).toBe("application/pdf");
    expect(rasterize).toHaveBeenCalledTimes(1);
    // The one-time code is neither stored nor logged by the card.
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("says so when the PDF cannot be drawn, and leaves the print button working", async () => {
    const print = vi.fn<(html: string) => void>();
    const dialog = show(
      vi.fn<CardRasterizer>(() => Promise.reject(new Error("no canvas"))),
      print,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Скачать PDF" }));
    expect(
      await screen.findByText(
        "Не удалось подготовить PDF. Можно распечатать карточку кнопкой «Печать».",
      ),
    ).toBeTruthy();
    expect(downloads).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("says so when the print cannot be opened", () => {
    const dialog = show(vi.fn<CardRasterizer>(), () => {
      throw new Error("no print");
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    expect(
      screen.getByText("Не удалось открыть печать. Скачайте PDF и распечатайте его."),
    ).toBeTruthy();
  });
});
