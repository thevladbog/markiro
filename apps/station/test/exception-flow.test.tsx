import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExceptionFlow } from "../src/pages/ExceptionFlow.js";

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
