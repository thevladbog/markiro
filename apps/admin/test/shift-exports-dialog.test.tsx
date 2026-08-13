import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShiftExportsDialog } from "../src/pages/shifts/ShiftExportsDialog.js";

const SHIFT = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "closed",
  mode: "validation",
  productId: "product-1",
  productName: "Молоко 1л",
  lineId: null,
  lineName: null,
  counterpartyId: null,
  counterpartyName: null,
  labelTemplateId: null,
  labelTemplateName: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  plannedQty: 200,
  plannedDate: "2026-08-13",
  boxCapacity: null,
  palletCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
  openedAt: "2026-08-13T08:00:00.000Z",
  closedAt: "2026-08-13T16:00:00.000Z",
  lateDataAt: null,
  closeReason: "Смена закончена",
  createdAt: "2026-08-13T08:00:00.000Z",
} as const;

const FORMATS = [
  { id: "shift_txt_flat", version: 1, label: "[TXT][Без коробов] Отчет смены", extension: "txt", mimeType: "text/plain; charset=utf-8", boxMode: "flat" },
  { id: "shift_txt_boxes", version: 1, label: "[TXT][С коробами] Отчет смены", extension: "txt", mimeType: "text/plain; charset=utf-8", boxMode: "boxes" },
  { id: "shift_csv_flat", version: 1, label: "[CSV][Без коробов] Отчет смены", extension: "csv", mimeType: "text/csv; charset=utf-8", boxMode: "flat" },
  { id: "shift_csv_boxes", version: 1, label: "[CSV][С коробами] Отчет смены", extension: "csv", mimeType: "text/csv; charset=utf-8", boxMode: "boxes" },
] as const;

const READY_EXPORT = {
  id: "22222222-2222-4222-8222-222222222222",
  shiftId: SHIFT.id,
  formatId: "shift_txt_boxes",
  formatVersion: 1,
  maxLines: 2000,
  status: "ready",
  errorCode: null,
  productNameSnapshot: "Молоко 1л",
  shiftDateSnapshot: "2026-08-13",
  totalCodeCount: 3,
  totalBoxCount: 2,
  createdByUserId: "user-1",
  createdByName: "Иванов Иван",
  sourceSnapshotStartedAt: "2026-08-13T16:00:01.000Z",
  completedAt: "2026-08-13T16:00:03.000Z",
  attemptCount: 1,
  createdAt: "2026-08-13T16:00:00.000Z",
  stale: true,
  artifacts: [
    { id: "part-2", partNumber: 2, physicalLineCount: 1, codeCount: 1, boxCount: 1, filename: "second.txt", mimeType: "text/plain; charset=utf-8", byteSize: 24, sha256: "b".repeat(64) },
    { id: "part-1", partNumber: 1, physicalLineCount: 2, codeCount: 2, boxCount: 1, filename: "first.txt", mimeType: "text/plain; charset=utf-8", byteSize: 42, sha256: "a".repeat(64) },
  ],
} as const;

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ShiftExportsDialog shift={SHIFT} open onClose={() => undefined} /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ShiftExportsDialog", () => {
  it("shows server formats and validates the optional split limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(String(url).includes("/formats") ? FORMATS : [])));
    renderDialog();

    const dialog = await screen.findByRole("dialog", { name: "Отчеты смены" });
    for (const format of FORMATS) {
      expect(await within(dialog).findByRole("radio", { name: format.label })).toBeDefined();
    }
    expect(within(dialog).queryByLabelText("Максимум строк в части")).toBeNull();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Разделить отчет на части" }));
    const limit = within(dialog).getByLabelText("Максимум строк в части") as HTMLInputElement;
    expect(limit.value).toBe("2000");
    fireEvent.change(limit, { target: { value: "1.5" } });
    expect(within(dialog).getByText("Введите целое число от 2 до 1 000 000")).toBeDefined();
    expect(
      (within(dialog).getByRole("button", { name: "Сформировать отчет" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows retained ready history, warns about stale data, and downloads with the server filename", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/formats")) return response(FORMATS);
      if (String(url).endsWith("/exports")) return response([READY_EXPORT]);
      if (String(url).includes("/download")) return response({ url: "https://storage.example.test/download", filename: "first.txt", expiresInSeconds: 300 });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const click = vi.fn();
    const appendChild = vi.spyOn(document.body, "appendChild");
    const removeChild = vi.spyOn(document.body, "removeChild");
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      const element = originalCreateElement(tagName) as HTMLAnchorElement;
      if (tagName === "a") element.click = click;
      return element;
    }) as typeof document.createElement);
    renderDialog();

    const dialog = await screen.findByRole("dialog", { name: "Отчеты смены" });
    expect(await within(dialog).findByText("Готов"));
    expect(within(dialog).getByText("Данные смены изменились — сформируйте новую")).toBeDefined();
    expect(within(dialog).getByText("Иванов Иван")).toBeDefined();
    expect(within(dialog).getByText("3 кодов")).toBeDefined();
    expect(within(dialog).getByText("2 коробов")).toBeDefined();
    expect(within(dialog).getByText("Часть 1")).toBeDefined();
    expect(within(dialog).getByText("2 строк · 2 кодов · 1 коробов · 42 Б")).toBeDefined();

    fireEvent.click(within(dialog).getAllByRole("button", { name: "Скачать" })[0]!);
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const link = appendChild.mock.calls.find(([node]) => node instanceof HTMLAnchorElement)?.[0] as HTMLAnchorElement;
    expect(link.href).toBe("https://storage.example.test/download");
    expect(link.download).toBe("first.txt");
    expect(removeChild).toHaveBeenCalledWith(link);
    createElement.mockRestore();
  });
});
