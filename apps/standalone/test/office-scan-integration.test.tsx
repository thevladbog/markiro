import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createComScanSource,
  createKeyboardWedgeSource,
  mergeScanSources,
} from "../src/floor/scan-source.js";
import type { OfficeWarehousePalletDetail } from "../src/host/office-pallet-create.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeOfficeSession, renderOffice } from "./support/office.js";
import { manualRuntime } from "./support/printing.js";

const PALLET: OfficeWarehousePalletDetail = {
  demo: false,
  id: "a1000000-0000-4000-8000-000000000001",
  sscc: "146006820000000409",
  source: "cabinet",
  createdByName: "Анна",
  deviceName: "Офис",
  productId: "b1000000-0000-4000-8000-000000000001",
  productName: "Молоко",
  gtin14: "04600682000013",
  shelfLifeDays: 5,
  openedAt: "2026-10-30T06:00:00Z",
  closedAt: "2026-10-30T06:00:00Z",
  disassembledAt: null,
  boxes: 0,
  units: 0,
  organization: { name: "Завод", inn: "7707083893", timeZone: "Europe/Moscow" },
  members: [],
};

async function mount() {
  const session = fakeOfficeSession();
  session.api.listLines.mockResolvedValue([
    { id: "line-1", name: "Линия 1", archived: false, rev: 1 },
  ]);
  session.api.getWarehousePallet.mockResolvedValue(PALLET);
  session.api.searchOffice.mockResolvedValue({
    truncated: false,
    items: [
      {
        id: PALLET.id,
        label: "Складской палет",
        detail: null,
        target: { kind: "warehouse_pallet", id: PALLET.id },
      },
    ],
  });
  const shell = fakeHardware();
  const listeners = new Set<(raw: string) => void>();
  const source = mergeScanSources(
    createKeyboardWedgeSource(),
    createComScanSource(async (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  );
  const ui = renderOffice(session, {
    initialPath: "/lines",
    scanner: {
      source,
      local: openLocalDb().executor,
      hardware: shell.hardware,
      printing: manualRuntime(shell.hardware).runtime,
    },
  });
  await screen.findByRole("heading", { name: "Линии", level: 1 });
  await act(async () => undefined);
  return {
    ...ui,
    session,
    com: (raw: string) =>
      act(() => {
        for (const listener of listeners) listener(raw);
      }),
  };
}
function wedge(raw: string) {
  const target = document.activeElement ?? document.body;
  for (const key of raw) fireEvent.keyDown(target, { key });
  fireEvent.keyDown(target, { key: "Enter" });
}

describe("Office shell scanner integration", () => {
  it.each([
    { width: 1440, collapsed: false },
    { width: 1280, collapsed: true },
  ])(
    "places an accessible search trigger before the first sidebar link at $width px",
    async ({ width, collapsed }) => {
      const original = window.innerWidth;
      try {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
        await mount();
        const nav = screen.getByRole("navigation", { name: "Разделы офиса" });
        expect(nav.classList.contains("office-menu--collapsed")).toBe(collapsed);
        const trigger = within(nav).getByRole("button", { name: "Поиск по системе" });
        const firstLink = within(nav).getAllByRole("link")[0];
        if (!firstLink) throw new Error("sidebar has no navigation links");
        expect(
          trigger.compareDocumentPosition(firstLink) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        if (!collapsed) expect(trigger.textContent).toContain("Поиск");
        expect(within(screen.getByRole("banner")).queryByRole("textbox")).toBeNull();
        fireEvent.click(trigger);
        const dialog = await screen.findByRole("dialog", { name: "Поиск по системе" });
        const input = within(dialog).getByRole("textbox", { name: "Поиск по системе" });
        await waitFor(() => expect(document.activeElement).toBe(input));
        expect(within(dialog).getByRole("button", { name: "Найти" })).toBeTruthy();
      } finally {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
      }
    },
  );

  it("opens and focuses the modal with Ctrl+K after navigation", async () => {
    const { com } = await mount();
    act(() => screen.getByRole("main").focus());
    com("(00)146006820000000409");
    await screen.findByRole("heading", { name: "Палет (00)146006820000000409" });
    expect(within(screen.getByRole("banner")).queryByRole("textbox")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Поиск по системе" });
    const input = within(dialog).getByRole("textbox", { name: "Поиск по системе" });
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("shows ambiguous scan results in the system-search modal without navigating", async () => {
    const { session, com } = await mount();
    session.api.searchOffice.mockResolvedValue({
      truncated: false,
      items: [
        {
          id: "first",
          label: "Первый палет",
          detail: null,
          target: { kind: "warehouse_pallet", id: PALLET.id },
        },
        {
          id: "second",
          label: "Второй палет",
          detail: null,
          target: { kind: "warehouse_pallet", id: "a1000000-0000-4000-8000-000000000002" },
        },
      ],
    });
    com("(00)146006820000000409");
    const dialog = await screen.findByRole("dialog", { name: "Поиск по системе" });
    expect(await within(dialog).findByRole("button", { name: "Первый палет" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Второй палет" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Линии", level: 1 })).toBeTruthy();
    expect(session.api.getWarehousePallet).not.toHaveBeenCalled();
  });

  it.each(["keyboard", "com"] as const)(
    "opens the unique warehouse pallet from a %s scan on a non-form page",
    async (channel) => {
      const { session, com } = await mount();
      if (channel === "keyboard") wedge("(00)146006820000000409");
      else com("(00)146006820000000409");
      await screen.findByRole("heading", { name: "Палет (00)146006820000000409" });
      expect(session.api.searchOffice).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
        kind: "sscc",
        sscc: "146006820000000409",
      });
      expect(session.api.getWarehousePallet).toHaveBeenCalledWith(expect.any(String), PALLET.id);
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("ignores keyboard and COM scans in a focused form and throughout its dialog, then resumes after close", async () => {
    const { session, com } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    const dialog = await screen.findByRole("dialog");
    const input = screen.getByRole("textbox", { name: "Название линии" });
    act(() => input.focus());
    wedge("(00)146006820000000409");
    com("(00)146006820000000409");
    expect(session.api.searchOffice).not.toHaveBeenCalled();
    const cancel = screen.getByRole("button", { name: "Отмена" });
    act(() => cancel.focus());
    wedge("(00)146006820000000409");
    com("(00)146006820000000409");
    expect(session.api.searchOffice).not.toHaveBeenCalled();
    expect(dialog).toBeTruthy();
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    com("(00)146006820000000409");
    await screen.findByRole("heading", { name: "Палет (00)146006820000000409" });
    expect(session.api.searchOffice).toHaveBeenCalledTimes(1);
  });
});
