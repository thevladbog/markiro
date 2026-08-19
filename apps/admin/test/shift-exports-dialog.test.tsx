import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  {
    id: "shift_txt_flat",
    version: 1,
    label: "[TXT][Без коробов] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "flat",
  },
  {
    id: "shift_txt_boxes",
    version: 2,
    label: "[TXT][С коробами] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "boxes",
  },
  {
    id: "shift_csv_flat",
    version: 1,
    label: "[CSV][Без коробов] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "flat",
  },
  {
    id: "shift_csv_boxes",
    version: 2,
    label: "[CSV][С коробами] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "boxes",
  },
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
    {
      id: "part-2",
      partNumber: 2,
      physicalLineCount: 1,
      codeCount: 1,
      boxCount: 1,
      filename: "second.txt",
      mimeType: "text/plain; charset=utf-8",
      byteSize: 24,
      sha256: "b".repeat(64),
    },
    {
      id: "part-1",
      partNumber: 1,
      physicalLineCount: 2,
      codeCount: 2,
      boxCount: 1,
      filename: "first.txt",
      mimeType: "text/plain; charset=utf-8",
      byteSize: 42,
      sha256: "a".repeat(64),
    },
  ],
} as const;

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function renderDialog(onClose = () => undefined) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ShiftExportsDialog shift={SHIFT} open onClose={onClose} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ShiftExportsDialog", () => {
  it("shows server formats and validates the optional split limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => response(String(url).includes("/formats") ? FORMATS : [])),
    );
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
      if (String(url).includes("/download"))
        return response({
          url: "https://storage.example.test/download",
          filename: "first.txt",
          expiresInSeconds: 300,
        });
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const click = vi.fn();
    const appendChild = vi.spyOn(document.body, "appendChild");
    const removeChild = vi.spyOn(document.body, "removeChild");
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
    ) => {
      const element = originalCreateElement(tagName) as HTMLAnchorElement;
      if (tagName === "a") element.click = click;
      return element;
    }) as typeof document.createElement);
    renderDialog();

    const dialog = await screen.findByRole("dialog", { name: "Отчеты смены" });
    expect(await within(dialog).findByText("Готов"));
    expect(
      within(dialog).getByText("Данные смены изменились — сформируйте новый отчет."),
    ).toBeDefined();
    expect(within(dialog).getByText("Иванов Иван")).toBeDefined();
    // READY_EXPORT is a legacy shift_txt_boxes@1 export; the live formats list only
    // advertises shift_txt_boxes@2, so the label lookup misses and the history row
    // falls back to the raw formatId (see ShiftExportsDialog.tsx's `formatLabel ?? item.formatId`).
    expect(within(dialog).getAllByText("[TXT][С коробами] Отчет смены")).toHaveLength(1);
    expect(within(dialog).getByText("shift_txt_boxes")).toBeDefined();
    expect(within(dialog).getByText("3 кодов")).toBeDefined();
    expect(within(dialog).getByText("2 коробов")).toBeDefined();
    expect(within(dialog).getByText("Часть 1")).toBeDefined();
    expect(within(dialog).getByText("2 строк · 2 кодов · 1 коробов · 42 Б")).toBeDefined();

    const downloadButton = within(dialog).getAllByRole("button", { name: "Скачать" })[0];
    if (!downloadButton) throw new Error("download button is missing");
    fireEvent.click(downloadButton);
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const link = appendChild.mock.calls.find(
      ([node]) => node instanceof HTMLAnchorElement,
    )?.[0] as HTMLAnchorElement;
    expect(link.href).toBe("https://storage.example.test/download");
    expect(link.download).toBe("first.txt");
    expect(removeChild).toHaveBeenCalledWith(link);
    createElement.mockRestore();
  });

  it("renders retained statuses, safe failure text, newest-first history, and flat counts without boxes", async () => {
    const failed = {
      ...READY_EXPORT,
      id: "33333333-3333-4333-8333-333333333333",
      formatId: "shift_csv_flat",
      formatVersion: 1,
      status: "failed",
      errorCode: "GENERATION_FAILED",
      artifacts: [],
      totalBoxCount: 0,
      createdAt: "2026-08-13T17:00:00.000Z",
      completedAt: null,
    };
    const processing = {
      ...READY_EXPORT,
      id: "44444444-4444-4444-8444-444444444444",
      formatId: "shift_txt_flat",
      formatVersion: 1,
      status: "processing",
      artifacts: [],
      totalBoxCount: 0,
      createdAt: "2026-08-13T16:30:00.000Z",
      completedAt: null,
    };
    const queued = {
      ...READY_EXPORT,
      id: "55555555-5555-4555-8555-555555555555",
      formatId: "shift_csv_flat",
      formatVersion: 1,
      status: "queued",
      artifacts: [],
      totalBoxCount: 0,
      createdAt: "2026-08-13T16:20:00.000Z",
      completedAt: null,
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/formats")) return response(FORMATS);
      if (String(url).endsWith("/exports")) return response([queued, processing, failed]);
      return response({});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Отчеты смены" });
    expect(await within(dialog).findByText("В очереди")).toBeDefined();
    expect(within(dialog).getByText("Формируется")).toBeDefined();
    expect(within(dialog).getByText("Ошибка")).toBeDefined();
    expect(
      within(dialog).getByText("Не удалось сформировать отчет. Повторите попытку."),
    ).toBeDefined();
    expect(within(dialog).getAllByText("[CSV][Без коробов] Отчет смены")).toHaveLength(3);
    const rows = within(dialog).getAllByRole("article");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Не удалось сформировать отчет");
    const newestRow = rows[0];
    if (!newestRow) throw new Error("newest export row is missing");
    expect(within(newestRow).queryByText("0 коробов")).toBeNull();
    fireEvent.click(within(newestRow).getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/retry"))).toBe(true),
    );
  });

  it("removes all dismiss controls while creation is pending", async () => {
    let release: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const onClose = vi.fn();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/formats")) return response(FORMATS);
      if (String(url).includes("/shifts/") && init?.method === "POST") return pending;
      return response([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDialog(onClose);
    const dialog = await screen.findByRole("dialog", { name: "Отчеты смены" });
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("button", { name: "Сформировать отчет" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Сформировать отчет" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(within(dialog).queryByRole("button", { name: "Закрыть" })).toBeNull(),
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    const overlay = dialog.parentElement;
    if (!overlay) throw new Error("modal overlay is missing");
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    if (!release) throw new Error("pending response resolver is missing");
    release(response({}));
  });

  it("reuses the idempotency key when the first create response is lost", async () => {
    const requests: string[] = [];
    let createAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/formats")) return response(FORMATS);
        if (String(url).includes("/shifts/") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { idempotencyKey: string };
          requests.push(body.idempotencyKey);
          createAttempts += 1;
          if (createAttempts === 1) throw new Error("response lost");
          return response({ ...READY_EXPORT, status: "queued", artifacts: [] });
        }
        return response([]);
      }),
    );
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Отчеты смены" });
    const createButton = within(dialog).getByRole("button", { name: "Сформировать отчет" });
    await waitFor(() => expect((createButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(createButton);
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(createButton);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]).toBe(requests[1]);
  });

  it("sends the selected format's actual advertised version, not a hardcoded one", async () => {
    let capturedBody: { formatId?: string; formatVersion?: number } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/formats")) return response(FORMATS);
        if (String(url).includes("/shifts/") && init?.method === "POST") {
          capturedBody = JSON.parse(String(init.body)) as {
            formatId: string;
            formatVersion: number;
          };
          return response({ ...READY_EXPORT, status: "queued", artifacts: [] });
        }
        return response([]);
      }),
    );
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Отчеты смены" });
    const boxesFormat = FORMATS.find((format) => format.id === "shift_txt_boxes");
    if (!boxesFormat) throw new Error("shift_txt_boxes format is missing from fixture");
    fireEvent.click(await within(dialog).findByRole("radio", { name: boxesFormat.label }));
    const createButton = within(dialog).getByRole("button", { name: "Сформировать отчет" });
    await waitFor(() => expect((createButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(createButton);
    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody?.formatId).toBe("shift_txt_boxes");
    expect(capturedBody?.formatVersion).toBe(2);
  });

  it("rejects empty, fractional, and out-of-range split limits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => response(String(url).includes("/formats") ? FORMATS : [])),
    );
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Отчеты смены" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Разделить отчет на части" }));
    const limit = within(dialog).getByLabelText("Максимум строк в части") as HTMLInputElement;
    for (const value of ["", "1", "1000001", "1.5"]) {
      fireEvent.change(limit, { target: { value } });
      expect(within(dialog).getByText("Введите целое число от 2 до 1 000 000")).toBeDefined();
      expect(
        (within(dialog).getByRole("button", { name: "Сформировать отчет" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    }
    expect(limit.required).toBe(true);
  });
});
