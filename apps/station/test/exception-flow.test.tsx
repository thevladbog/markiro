import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExceptionFlow } from "../src/pages/ExceptionFlow.js";
import type { ScanSource } from "../src/lib/scan-source.js";

function fakeScanSource() {
  let listener: ((raw: string) => void) | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        if (listener === next) listener = null;
      };
    },
  };
  return {
    source,
    emit(raw: string) {
      act(() => listener?.(raw));
    },
    get subscribed() {
      return listener !== null;
    },
  };
}

const BOXES = [
  {
    boxId: "b1",
    sscc: "123456789012345675",
    itemCount: 3,
    closedAt: "2026-07-30T00:00:00.000Z",
  },
];

function renderFlow(overrides: Partial<React.ComponentProps<typeof ExceptionFlow>> = {}) {
  const props: React.ComponentProps<typeof ExceptionFlow> = {
    boxes: BOXES,
    canUndo: true,
    hasOpenBox: true,
    onUndo: vi.fn().mockResolvedValue(undefined),
    onClear: vi.fn().mockResolvedValue(undefined),
    onReprint: vi.fn().mockResolvedValue(undefined),
    onDisassemble: vi.fn().mockResolvedValue(undefined),
    onBack: vi.fn(),
    ...overrides,
  };
  return { ...render(<ExceptionFlow {...props} />), props };
}

describe("ExceptionFlow", () => {
  it("offers all four actions, runs Undo immediately, and confirms Clear without a reason", async () => {
    const onUndo = vi.fn().mockResolvedValue(undefined);
    const undoView = renderFlow({ onUndo });
    expect(screen.getByRole("button", { name: "Отменить последний скан" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Очистить короб" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Перепечатать этикетку" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Расформировать короб" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Отменить последний скан" }));
    await waitFor(() => expect(onUndo).toHaveBeenCalledOnce());
    expect(screen.queryByText("Причина")).toBeNull();
    undoView.unmount();

    const onClear = vi.fn().mockResolvedValue(undefined);
    renderFlow({ onClear });
    fireEvent.click(screen.getByRole("button", { name: "Очистить короб" }));
    expect(screen.getByTestId("exception-stage-confirm")).toBeDefined();
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Причина" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить очистку" }));
    await waitFor(() => expect(onClear).toHaveBeenCalledOnce());
  });

  it("renders only the current action, target, reason, and confirmation stage", () => {
    renderFlow();
    expect(screen.getByTestId("exception-stage-action")).toBeDefined();
    expect(screen.queryByTestId("exception-stage-target")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    expect(screen.getByTestId("exception-stage-target")).toBeDefined();
    expect(screen.queryByTestId("exception-stage-action")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /123456789012345675/ }));
    expect(screen.getByTestId("exception-stage-reason")).toBeDefined();
    expect(screen.queryByTestId("exception-stage-target")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Этикетка повреждена" }));
    expect(screen.getByTestId("exception-stage-confirm")).toBeDefined();
    expect(screen.queryByTestId("exception-stage-reason")).toBeNull();
  });

  it("passes a translated reprint preset as the existing free-text reason without mutating before confirm", async () => {
    const onReprint = vi.fn().mockResolvedValue(undefined);
    renderFlow({ onReprint });

    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    fireEvent.click(screen.getByRole("button", { name: /123456789012345675/ }));
    fireEvent.click(screen.getByRole("button", { name: "Замятие принтера / нет печати" }));
    expect(onReprint).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить перепечатку" }));

    await waitFor(() =>
      expect(onReprint).toHaveBeenCalledWith("b1", "Замятие принтера / нет печати"),
    );
    expect((await screen.findByTestId("exception-stage-result")).textContent).toContain(
      "Действие выполнено",
    );
  });

  it("uses a bounded full-screen Other dialog and trims its value", async () => {
    const onReprint = vi.fn().mockResolvedValue(undefined);
    renderFlow({ onReprint });
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    fireEvent.click(screen.getByRole("button", { name: /123456789012345675/ }));
    fireEvent.click(screen.getByRole("button", { name: "Другая причина" }));

    const dialog = screen.getByRole("dialog", { name: "Другая причина" });
    const input = screen.getByRole("textbox", { name: "Причина" }) as HTMLTextAreaElement;
    expect(dialog.className).toContain("mk-full-screen-dialog");
    expect(input.maxLength).toBe(500);
    fireEvent.change(input, { target: { value: "  Проверка мастером  " } });
    fireEvent.click(screen.getByRole("button", { name: "Использовать причину" }));
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить перепечатку" }));

    await waitFor(() => expect(onReprint).toHaveBeenCalledWith("b1", "Проверка мастером"));
  });

  it("requires an irreversible full-screen confirmation naming the SSCC for disassembly", async () => {
    const onDisassemble = vi.fn().mockResolvedValue(undefined);
    renderFlow({ onDisassemble });
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    fireEvent.click(screen.getByRole("button", { name: /123456789012345675/ }));
    fireEvent.click(screen.getByRole("button", { name: "Неверное количество" }));

    const dialog = screen.getByRole("dialog", { name: "Расформировать короб безвозвратно?" });
    expect(dialog.textContent).toContain("SSCC 123456789012345675");
    expect(dialog.textContent).toContain("нельзя использовать повторно");
    expect(onDisassemble).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Расформировать безвозвратно" }));

    await waitFor(() => expect(onDisassemble).toHaveBeenCalledWith("b1", "Неверное количество"));
  });

  it("Back changes one stage without executing an action", () => {
    const onReprint = vi.fn().mockResolvedValue(undefined);
    renderFlow({ onReprint });
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    fireEvent.click(screen.getByRole("button", { name: /123456789012345675/ }));
    fireEvent.click(screen.getByRole("button", { name: "Этикетка повреждена" }));

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByTestId("exception-stage-reason")).toBeDefined();
    expect(onReprint).not.toHaveBeenCalled();
  });

  it("disables confirmation while applying and prevents duplicate execution", async () => {
    let resolve!: () => void;
    const onReprint = vi.fn(() => new Promise<void>((done) => (resolve = done)));
    renderFlow({ onReprint });
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    fireEvent.click(screen.getByRole("button", { name: /123456789012345675/ }));
    fireEvent.click(screen.getByRole("button", { name: "Этикетка повреждена" }));
    const confirm = screen.getByRole("button", { name: "Подтвердить перепечатку" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onReprint).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("exception-stage-applying")).toBeDefined();
    resolve();
    await screen.findByTestId("exception-stage-result");
  });

  it("selects the box by scanning its SSCC on the target stage and advances to reasons", async () => {
    const scanner = fakeScanSource();
    const onDisassemble = vi.fn().mockResolvedValue(undefined);
    renderFlow({ onDisassemble, scanSource: scanner.source });
    expect(scanner.subscribed).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    expect(scanner.subscribed).toBe(true);
    scanner.emit("00123456789012345675");

    expect(screen.getByTestId("exception-stage-reason")).toBeDefined();
    expect(scanner.subscribed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Неверное количество" }));
    fireEvent.click(screen.getByRole("button", { name: "Расформировать безвозвратно" }));
    await waitFor(() => expect(onDisassemble).toHaveBeenCalledWith("b1", "Неверное количество"));
  });

  it("selects the box by scan on the reprint path exactly like on disassembly", async () => {
    const scanner = fakeScanSource();
    const onReprint = vi.fn().mockResolvedValue(undefined);
    renderFlow({ onReprint, scanSource: scanner.source });

    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    expect(scanner.subscribed).toBe(true);
    scanner.emit("00123456789012345675");

    expect(screen.getByTestId("exception-stage-reason")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Этикетка повреждена" }));
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить перепечатку" }));
    await waitFor(() => expect(onReprint).toHaveBeenCalledWith("b1", "Этикетка повреждена"));
  });

  it("filters the target list by typed SSCC tail digits and keeps scans unfiltered", () => {
    const scanner = fakeScanSource();
    const boxes = [
      { boxId: "b1", sscc: "123456789012345675", itemCount: 3, closedAt: "2026-07-30T00:00:00Z" },
      { boxId: "b2", sscc: "123456789012340019", itemCount: 5, closedAt: "2026-07-30T01:00:00Z" },
      { boxId: "b3", sscc: "123456789012345019", itemCount: 7, closedAt: "2026-07-30T02:00:00Z" },
    ];
    renderFlow({ boxes, scanSource: scanner.source });
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);

    for (const digit of ["0", "1", "9"]) {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    expect(screen.getByTestId("sscc-search-value").textContent).toBe("…019");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByTestId("boxes-found").textContent).toBe("Найдено 2 из 3");
    expect(screen.getByText(/Ещё 1 короб скрыт фильтром/)).toBeDefined();
    // The typed tail is emphasized inside every matching row.
    const marks = screen.getAllByText("019", { selector: "mark" });
    expect(marks).toHaveLength(2);

    // A scan names one exact box and wins regardless of the filter digits.
    scanner.emit("00123456789012345675");
    expect(screen.getByTestId("exception-stage-reason")).toBeDefined();

    // Leaving the target stage forgets the tail: re-entering starts clean.
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByTestId("sscc-search-value").textContent).toBe("Последние цифры SSCC");
  });

  it("erases and clears the typed tail from the pad's own keys", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));

    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    expect(screen.getByTestId("sscc-search-value").textContent).toBe("…99");
    expect(screen.getByText("Нет коробов с такими последними цифрами")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Стереть цифру" }));
    expect(screen.getByTestId("sscc-search-value").textContent).toBe("…9");
    fireEvent.click(screen.getByRole("button", { name: "Стереть цифру" }));

    fireEvent.click(screen.getByRole("button", { name: "7" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    expect(screen.getByTestId("sscc-search-value").textContent).toBe("…75");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    fireEvent.click(screen.getAllByRole("button", { name: "Очистить поиск" })[0]!);
    expect(screen.getByTestId("sscc-search-value").textContent).toBe("Последние цифры SSCC");
  });

  it("titles the flow after the operation and marks disassembly as danger", () => {
    renderFlow();
    expect(screen.getByRole("heading", { name: "Исключения" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    const heading = screen.getByRole("heading", { name: "Расформировать короб" });
    expect(heading.getAttribute("data-danger")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    expect(
      screen.getByRole("heading", { name: "Перепечатать этикетку" }).getAttribute("data-danger"),
    ).toBeNull();
  });

  it("renders the provided window control beside the back button", () => {
    renderFlow({ windowControl: <button type="button">Оконный режим</button> });
    expect(screen.getByRole("button", { name: "Оконный режим" })).toBeDefined();
  });

  it("stays on the target stage with feedback for unknown or non-SSCC scans", () => {
    const scanner = fakeScanSource();
    renderFlow({ scanSource: scanner.source });
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));

    scanner.emit("not-a-code");
    expect(screen.getByTestId("exception-stage-target")).toBeDefined();
    expect(screen.getByText("Это не групповой код")).toBeDefined();

    scanner.emit("00999999999012345679");
    expect(screen.getByTestId("exception-stage-target")).toBeDefined();
    expect(screen.getByText("Короб не найден среди закрытых коробов этой смены")).toBeDefined();

    scanner.emit("00123456789012345675");
    expect(screen.getByTestId("exception-stage-reason")).toBeDefined();
  });

  it("clears scan feedback when re-entering the target stage", () => {
    const scanner = fakeScanSource();
    renderFlow({ scanSource: scanner.source });
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    scanner.emit("not-a-code");
    expect(screen.getByText("Это не групповой код")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(scanner.subscribed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    expect(screen.queryByText("Это не групповой код")).toBeNull();
  });

  it("reports pending for its full lifetime and exposes a recoverable error result", async () => {
    const onPendingChange = vi.fn();
    const view = renderFlow({
      onPendingChange,
      onReprint: vi.fn().mockRejectedValue(new Error("printer offline")),
    });
    expect(onPendingChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    fireEvent.click(screen.getByRole("button", { name: /123456789012345675/ }));
    fireEvent.click(screen.getByRole("button", { name: "Этикетка повреждена" }));
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить перепечатку" }));

    expect(await screen.findByText("Не удалось выполнить действие")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать другое действие" }));
    expect(screen.getByTestId("exception-stage-action")).toBeDefined();
    view.unmount();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });
});
