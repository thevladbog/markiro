import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import { TECHNOLOGIST, type FakeOfficeSession } from "./support/office.js";
import {
  ACTIVE,
  expectFocusedNotice,
  freezeToday,
  openShifts,
  PLANNED,
  shiftRow,
  shiftsSession,
  WATER,
} from "./support/shifts.js";

const TOKEN = "office-session-token";

const REASON_WORDS = "Опишите причину: от 3 до 500 символов";
const CONTROL_WORDS = "Уберите табуляцию, перенос строки или другой служебный символ";
// A lost answer (`unreachable`) and a refused role (`forbidden`), as `errors.*` words them
// (the alert puts an icon glyph before the words).
const LOST_WORDS = "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.";
const FORBIDDEN_WORDS = "Недостаточно прав для этого действия.";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

function lost(): HostError {
  return new HostError({ kind: "transport", code: "unreachable", message: "x" });
}

function dialog(name: string): HTMLElement {
  return screen.getByRole("dialog", { name });
}

async function openDelete(session: FakeOfficeSession): Promise<HTMLElement> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Удалить смену OCT26-005" }));
  return screen.findByRole("dialog", { name: "Удалить смену OCT26-005?" });
}

async function openClose(session: FakeOfficeSession): Promise<HTMLElement> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Закрыть смену OCT26-004" }));
  return screen.findByRole("dialog", { name: "Закрыть смену OCT26-004" });
}

function reason(): HTMLTextAreaElement {
  const field = within(dialog("Закрыть смену OCT26-004")).getByLabelText("Причина закрытия");
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("no reason field");
  return field;
}

/** The note under the reason, by its `aria-describedby`. */
function reasonNote(): string | null | undefined {
  const id = reason().getAttribute("aria-describedby");
  return id === null ? undefined : document.getElementById(id)?.textContent;
}

/** The note under the reason, as an element. */
function reasonNoteElement(): HTMLElement {
  const id = reason().getAttribute("aria-describedby");
  const note = id === null ? null : document.getElementById(id);
  if (note === null) throw new Error("no note");
  return note;
}

function closeButton(): HTMLButtonElement {
  const button = within(dialog("Закрыть смену OCT26-004")).getByRole("button", {
    name: "Закрыть смену",
  });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no button");
  return button;
}

function closeShift(): void {
  fireEvent.click(closeButton());
}

/** Types `text` as the reason and submits it. */
function giveReason(text: string): void {
  fireEvent.change(reason(), { target: { value: text } });
  closeShift();
}

function deleteButton(confirm: HTMLElement): HTMLButtonElement {
  const button = within(confirm).getByRole("button", { name: "Удалить" });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no button");
  return button;
}

function cancelButton(name: string): HTMLButtonElement {
  const button = within(dialog(name)).getByRole("button", { name: "Отмена" });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no button");
  return button;
}

/** A write that stays in flight until the test settles it. */
function pending<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const CLOSED_ACTIVE: OfficeShift = {
  ...ACTIVE,
  status: "closed",
  closedAt: "2026-10-09T10:00:00Z",
  closeReasonText: "Станция линии 2 вышла из строя",
  rev: 99,
};

/** A second planned shift of water, to tell which row's dialog was opened. */
const PLANNED_2: OfficeShift = {
  ...PLANNED,
  id: "3e1b7a5d-9f4a-4c6b-8d1e-5a8f0b4c7d9e",
  number: "OCT26-006",
  rev: 73,
};

describe("office shifts: deleting a planned shift", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks first, naming the shift and its product, then deletes it, says so and reads the list again", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockResolvedValue(undefined);
    const confirm = await openDelete(session);
    expect(
      within(confirm).getByText(
        "Смена OCT26-005 («Вода 0,5 л») будет удалена без возможности восстановления. Её номер больше не выдаётся.",
      ),
    ).toBeTruthy();
    // Asking does not delete.
    expect(session.api.deleteShift).not.toHaveBeenCalled();
    const submit = within(confirm).getByRole("button", { name: "Удалить" });
    expect(submit.className).toContain("mk-btn--destructive");
    fireEvent.click(submit);
    await screen.findByText("Смена OCT26-005 удалена.");
    expect(session.api.deleteShift).toHaveBeenCalledTimes(1);
    expect(session.api.deleteShift).toHaveBeenCalledWith(TOKEN, PLANNED.id);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("moves the focus to the notice once the shift is deleted, though the button that opened the dialog is gone", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockResolvedValue(undefined);
    // The list behind no longer has the row.
    const confirm = await openDelete(session);
    session.api.listShifts.mockResolvedValue([ACTIVE]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    await expectFocusedNotice("Смена OCT26-005 удалена.");
    await waitFor(() => expect(screen.queryByText("OCT26-005")).toBeNull());
    await expectFocusedNotice("Смена OCT26-005 удалена.");
  });

  it("takes a shift already gone as deleted", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockRejectedValue(api("not_found"));
    const confirm = await openDelete(session);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    await screen.findByText("Смена OCT26-005 удалена.");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("says a shift a station opened meanwhile cannot be deleted, keeps the dialog and reads the list again", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockRejectedValue(
      api("conflict", { constraint: "shift_status", status: "active" }),
    );
    const confirm = await openDelete(session);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    expect(
      await within(confirm).findByText(
        "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("switches «Удалить» off once the shift is out of reach, offers to load the list and closes on it", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockRejectedValue(
      api("conflict", { constraint: "shift_status", status: "closed" }),
    );
    const confirm = await openDelete(session);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    expect(await within(confirm).findByText(/Смена уже закрыта/)).toBeTruthy();
    expect(screen.queryByText("Смена OCT26-005 удалена.")).toBeNull();
    await waitFor(() => expect(deleteButton(confirm).disabled).toBe(true));
    // Sent again it would be refused the same way: one request only.
    fireEvent.click(deleteButton(confirm));
    expect(session.api.deleteShift).toHaveBeenCalledTimes(1);
    fireEvent.click(within(confirm).getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listShifts.mock.calls.length).toBeGreaterThan(1));
  });

  it("explains a lost answer, reads the list again to show whether the shift went and deletes on the second try", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockRejectedValueOnce(lost());
    const confirm = await openDelete(session);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    expect((await within(confirm).findByRole("alert")).textContent).toContain(LOST_WORDS);
    // The host may have deleted the shift before the answer was lost: the list behind says so.
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    // Still asking, and not stuck: «Удалить» works again.
    await waitFor(() => expect(deleteButton(confirm).disabled).toBe(false));
    session.api.deleteShift.mockResolvedValueOnce(undefined);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    await screen.findByText("Смена OCT26-005 удалена.");
    expect(session.api.deleteShift).toHaveBeenCalledTimes(2);
    expect(session.api.deleteShift).toHaveBeenLastCalledWith(TOKEN, PLANNED.id);
  });

  it("takes the failure away when the next try starts", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockRejectedValueOnce(lost());
    const confirm = await openDelete(session);
    fireEvent.click(deleteButton(confirm));
    expect((await within(confirm).findByRole("alert")).textContent).toContain(LOST_WORDS);
    await waitFor(() => expect(deleteButton(confirm).disabled).toBe(false));
    const write = pending<undefined>();
    session.api.deleteShift.mockReturnValueOnce(write.promise);
    fireEvent.click(deleteButton(confirm));
    await waitFor(() => expect(within(confirm).queryByRole("alert")).toBeNull());
    await act(async () => {
      write.resolve(undefined);
      await Promise.resolve();
    });
    await screen.findByText("Смена OCT26-005 удалена.");
  });

  it("explains a refusal of the role as an alert and keeps the dialog", async () => {
    const session = shiftsSession();
    session.api.deleteShift.mockRejectedValue(api("forbidden"));
    const confirm = await openDelete(session);
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    expect((await within(confirm).findByRole("alert")).textContent).toContain(FORBIDDEN_WORDS);
    expect(screen.getByRole("dialog")).toBe(confirm);
    // An answer of the host that deleted nothing leaves the list alone.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
  });

  it("names the shift of the row it was opened from and deletes that one", async () => {
    const session = shiftsSession([PLANNED, PLANNED_2, ACTIVE]);
    session.api.deleteShift.mockResolvedValue(undefined);
    await openShifts(session);
    fireEvent.click(screen.getByRole("button", { name: "Удалить смену OCT26-006" }));
    const confirm = await screen.findByRole("dialog", { name: "Удалить смену OCT26-006?" });
    expect(within(confirm).getByText(/^Смена OCT26-006 /)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    await screen.findByText("Смена OCT26-006 удалена.");
    expect(session.api.deleteShift).toHaveBeenCalledWith(TOKEN, PLANNED_2.id);
    expect(session.api.deleteShift).toHaveBeenCalledTimes(1);
  });

  it("shows a product named with markup as text", async () => {
    const session = shiftsSession();
    const name = "<img src=x onerror=alert(1)> Вода";
    session.api.listProducts.mockResolvedValue([{ ...WATER, name }]);
    const confirm = await openDelete(session);
    expect(confirm.textContent).toContain(`Смена OCT26-005 («${name}») будет удалена`);
    expect(confirm.querySelector("img")).toBeNull();
  });

  it("holds «Удалить» and «Отмена» while the delete is on its way and sends it once", async () => {
    const session = shiftsSession();
    const write = pending<undefined>();
    session.api.deleteShift.mockReturnValueOnce(write.promise);
    const confirm = await openDelete(session);
    // Two clicks in one moment are one delete.
    act(() => {
      fireEvent.click(deleteButton(confirm));
      fireEvent.click(deleteButton(confirm));
    });
    await waitFor(() => expect(cancelButton("Удалить смену OCT26-005?").disabled).toBe(true));
    fireEvent.click(cancelButton("Удалить смену OCT26-005?"));
    expect(screen.getByRole("dialog")).toBe(confirm);
    expect(session.api.deleteShift).toHaveBeenCalledTimes(1);
    await act(async () => {
      write.resolve(undefined);
      await Promise.resolve();
    });
    await screen.findByText("Смена OCT26-005 удалена.");
    expect(session.api.deleteShift).toHaveBeenCalledTimes(1);
  });

  it("deletes nothing when the dialog is cancelled", async () => {
    const session = shiftsSession();
    await openDelete(session);
    fireEvent.click(cancelButton("Удалить смену OCT26-005?"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(session.api.deleteShift).not.toHaveBeenCalled();
    expect(screen.queryByText("Смена OCT26-005 удалена.")).toBeNull();
  });

  it("is offered to both roles for a planned shift only, never for an active or closed one", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const session = shiftsSession(undefined, user);
      session.api.deleteShift.mockResolvedValue(undefined);
      const view = await openShifts(session);
      expect(screen.getAllByRole("button", { name: /^Удалить смену / })).toHaveLength(1);
      expect(within(shiftRow("OCT26-004")).queryByRole("button", { name: /Удалить/ })).toBeNull();
      expect(within(shiftRow("OCT26-001/S")).queryAllByRole("button")).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Удалить смену OCT26-005" }));
      fireEvent.click(
        within(await screen.findByRole("dialog", { name: "Удалить смену OCT26-005?" })).getByRole(
          "button",
          { name: "Удалить" },
        ),
      );
      await screen.findByText("Смена OCT26-005 удалена.");
      expect(session.api.deleteShift).toHaveBeenCalledWith(TOKEN, PLANNED.id);
      view.unmount();
    }
  });
});

describe("office shifts: closing an active shift", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the reason in words and sends it trimmed with the loaded revision, then says so", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockResolvedValue(CLOSED_ACTIVE);
    const confirm = await openClose(session);
    expect(within(confirm).getByText(/только если станция её уже не закончит/)).toBeTruthy();
    expect(reasonNote()).toBe(
      "От 3 до 500 символов, одной строкой. Её увидят в списке смен и в журнале действий.",
    );
    expect(reason().getAttribute("aria-invalid")).toBeNull();
    expect(reasonNoteElement().className).toBe("shift-note");
    // The note changes in place, so a screen reader is told.
    expect(reasonNoteElement().getAttribute("aria-live")).toBe("polite");
    const submit = within(confirm).getByRole("button", { name: "Закрыть смену" });
    expect(submit.className).toContain("mk-btn--destructive");
    fireEvent.change(reason(), { target: { value: "  Станция линии 2 вышла из строя  " } });
    closeShift();
    await screen.findByText("Смена OCT26-004 закрыта.");
    expect(session.api.closeShift).toHaveBeenCalledTimes(1);
    expect(session.api.closeShift).toHaveBeenCalledWith(TOKEN, ACTIVE.id, {
      reason: "Станция линии 2 вышла из строя",
      expectedRev: 71,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("counts the reason in characters as the host does: two emoji are too short, three are enough", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockResolvedValue({ ...ACTIVE, status: "closed" });
    await openClose(session);
    for (const text of ["", "аб", "😀😀"]) {
      fireEvent.change(reason(), { target: { value: text } });
      closeShift();
      await waitFor(() => expect(reasonNote()).toBe("Опишите причину: от 3 до 500 символов"));
      expect(reason().getAttribute("aria-invalid")).toBe("true");
      expect(reasonNoteElement().className).toBe("shift-note shift-note--error");
      await waitFor(() =>
        expect(
          within(dialog("Закрыть смену OCT26-004"))
            .getByRole("button", { name: "Закрыть смену" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
    }
    expect(session.api.closeShift).not.toHaveBeenCalled();
    fireEvent.change(reason(), { target: { value: "😀😀😀" } });
    closeShift();
    await screen.findByText("Смена OCT26-004 закрыта.");
    expect(session.api.closeShift).toHaveBeenCalledWith(TOKEN, ACTIVE.id, {
      reason: "😀😀😀",
      expectedRev: 71,
    });
  });

  it.each([
    ["two letters", "аб", null],
    ["two letters between blanks", "   аб   ", null],
    ["three letters", "абв", "абв"],
    ["three letters between blanks", "   абв \t ", "абв"],
    ["500 letters", "ю".repeat(500), "ю".repeat(500)],
    ["501 letters", "ю".repeat(501), null],
    ["500 emoji (1000 UTF-16 units)", "😀".repeat(500), "😀".repeat(500)],
    ["501 emoji", "😀".repeat(501), null],
    ["500 letters between blanks", `  ${"ю".repeat(500)}  `, "ю".repeat(500)],
    ["a line break at the end", "Станция сломалась\n", "Станция сломалась"],
  ])("takes the length of %s as the host does", async (_what, typed, sent) => {
    const session = shiftsSession();
    session.api.closeShift.mockResolvedValue(CLOSED_ACTIVE);
    await openClose(session);
    giveReason(typed);
    if (sent === null) {
      await waitFor(() => expect(reasonNote()).toBe(REASON_WORDS));
      expect(session.api.closeShift).not.toHaveBeenCalled();
    } else {
      await screen.findByText("Смена OCT26-004 закрыта.");
      expect(session.api.closeShift).toHaveBeenCalledWith(TOKEN, ACTIVE.id, {
        reason: sent,
        expectedRev: 71,
      });
    }
  });

  it("lets Enter and Shift+Enter put no line break in the reason, and every other key through", async () => {
    const session = shiftsSession();
    await openClose(session);
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    // `fireEvent` answers `false` when the default of the key was prevented.
    expect(fireEvent.keyDown(reason(), { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(reason(), { key: "Enter", shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(reason(), { key: "a" })).toBe(true);
    expect(fireEvent.keyDown(reason(), { key: "Tab" })).toBe(true);
    // An Enter that confirms a word of an input method is the method's, not a line break.
    expect(fireEvent.keyDown(reason(), { key: "Enter", isComposing: true })).toBe(true);
    // Enter writes nothing and sends nothing.
    expect(reason().value).toBe("Станция сломалась");
    expect(session.api.closeShift).not.toHaveBeenCalled();
  });

  it.each([
    ["a line break inside", "Станция\nсломалась"],
    ["a tab inside", "Станция\tсломалась"],
    ["a carriage return inside", "Станция\rсломалась"],
    ["an unpaired surrogate", "Станция \ud800 сломалась"],
  ])("refuses %s in words of its own and sends nothing", async (_what, typed) => {
    const session = shiftsSession();
    await openClose(session);
    giveReason(typed);
    await waitFor(() => expect(reasonNote()).toBe(CONTROL_WORDS));
    expect(reason().getAttribute("aria-invalid")).toBe("true");
    expect(session.api.closeShift).not.toHaveBeenCalled();
    // Mended, it goes out.
    session.api.closeShift.mockResolvedValue(CLOSED_ACTIVE);
    await waitFor(() => expect(closeButton().disabled).toBe(false));
    giveReason("Станция сломалась");
    await screen.findByText("Смена OCT26-004 закрыта.");
    expect(session.api.closeShift).toHaveBeenCalledTimes(1);
  });

  it("puts the focus on the reason when it is refused and shows the hint again once it is mended", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockResolvedValue(CLOSED_ACTIVE);
    await openClose(session);
    giveReason("аб");
    await waitFor(() => expect(reasonNote()).toBe(REASON_WORDS));
    await waitFor(() => expect(document.activeElement).toBe(reason()));
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    closeShift();
    await screen.findByText("Смена OCT26-004 закрыта.");
  });

  it("puts the host's refusal of the reason under it, with the focus", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValue(api("validation_failed", { field: "reason" }));
    await openClose(session);
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    reason().blur();
    closeShift();
    await waitFor(() => expect(reasonNote()).toBe("Опишите причину: от 3 до 500 символов"));
    expect(reason().getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(reason()));
    // What was typed stays.
    expect(reason().value).toBe("Станция сломалась");
    expect(screen.queryByText("Смена OCT26-004 закрыта.")).toBeNull();
  });

  it("offers to load the list again after a stale close, which closes the dialog", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValue(api("stale_revision", { currentRev: 80 }));
    const confirm = await openClose(session);
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    closeShift();
    fireEvent.click(await within(confirm).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    // Never retried with the revision the host named.
    expect(session.api.closeShift).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Смена OCT26-004 закрыта.")).toBeNull();
  });

  it.each([
    [
      "closed meanwhile",
      api("conflict", { constraint: "shift_status", status: "closed" }),
      "Смена уже закрыта. Список смен обновлён.",
    ],
    [
      "not open yet",
      api("conflict", { constraint: "shift_status", status: "planned" }),
      "Смена ещё не открыта на станции. Список смен обновлён.",
    ],
    ["gone", api("not_found"), "Этой смены больше нет: её удалили. Список смен обновлён."],
  ])("says a shift %s, keeps the dialog and reads the list again", async (_what, refusal, text) => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValue(refusal);
    const confirm = await openClose(session);
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    closeShift();
    expect(await within(confirm).findByText(text)).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    // Refused, not closed: the dialog stays and says nothing of a closed shift.
    expect(screen.getByRole("dialog")).toBe(confirm);
    expect(screen.queryByText("Смена OCT26-004 закрыта.")).toBeNull();
  });

  it("switches «Закрыть смену» off once the shift is out of reach, keeps what was typed and closes on the reload button", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValue(
      api("conflict", { constraint: "shift_status", status: "closed" }),
    );
    const confirm = await openClose(session);
    giveReason("Станция сломалась");
    expect(await within(confirm).findByText(/Смена уже закрыта/)).toBeTruthy();
    await waitFor(() => expect(closeButton().disabled).toBe(true));
    expect(reason().value).toBe("Станция сломалась");
    // Sent again it would be refused the same way: one request only.
    fireEvent.click(closeButton());
    expect(session.api.closeShift).toHaveBeenCalledTimes(1);
    fireEvent.click(within(confirm).getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listShifts.mock.calls.length).toBeGreaterThan(1));
  });

  it("explains a failed request, keeps the reason and closes on the second try with the same revision", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValueOnce(lost());
    const confirm = await openClose(session);
    giveReason("Станция сломалась");
    expect((await within(confirm).findByRole("alert")).textContent).toContain(LOST_WORDS);
    // The host may have closed the shift before the answer was lost: the list behind says so.
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    expect(reason().value).toBe("Станция сломалась");
    await waitFor(() => expect(closeButton().disabled).toBe(false));
    session.api.closeShift.mockResolvedValueOnce(CLOSED_ACTIVE);
    closeShift();
    await screen.findByText("Смена OCT26-004 закрыта.");
    expect(session.api.closeShift).toHaveBeenCalledTimes(2);
    expect(session.api.closeShift).toHaveBeenNthCalledWith(2, TOKEN, ACTIVE.id, {
      reason: "Станция сломалась",
      expectedRev: 71,
    });
  });

  it("moves the focus to the notice once the shift is closed", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockResolvedValue(CLOSED_ACTIVE);
    await openClose(session);
    giveReason("Станция сломалась");
    await expectFocusedNotice("Смена OCT26-004 закрыта.");
  });

  it("leaves the list alone after an answer of the host that closed nothing", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValue(api("forbidden"));
    const confirm = await openClose(session);
    giveReason("Станция сломалась");
    expect((await within(confirm).findByRole("alert")).textContent).toContain(FORBIDDEN_WORDS);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
  });

  it("takes the failure away when the next try starts", async () => {
    const session = shiftsSession();
    session.api.closeShift.mockRejectedValueOnce(lost());
    const confirm = await openClose(session);
    giveReason("Станция сломалась");
    expect((await within(confirm).findByRole("alert")).textContent).toContain(LOST_WORDS);
    await waitFor(() => expect(closeButton().disabled).toBe(false));
    const write = pending<OfficeShift>();
    session.api.closeShift.mockReturnValueOnce(write.promise);
    closeShift();
    await waitFor(() => expect(within(confirm).queryByRole("alert")).toBeNull());
    await act(async () => {
      write.resolve(CLOSED_ACTIVE);
      await Promise.resolve();
    });
    await screen.findByText("Смена OCT26-004 закрыта.");
  });

  it("holds the reason and «Отмена» while the close is on its way and sends it once", async () => {
    const session = shiftsSession();
    const write = pending<OfficeShift>();
    session.api.closeShift.mockReturnValueOnce(write.promise);
    const confirm = await openClose(session);
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    // Two clicks in one moment are one close.
    act(() => {
      fireEvent.click(closeButton());
      fireEvent.click(closeButton());
    });
    await waitFor(() => expect(cancelButton("Закрыть смену OCT26-004").disabled).toBe(true));
    expect(reason().readOnly).toBe(true);
    fireEvent.click(cancelButton("Закрыть смену OCT26-004"));
    expect(screen.getByRole("dialog")).toBe(confirm);
    expect(session.api.closeShift).toHaveBeenCalledTimes(1);
    await act(async () => {
      write.resolve(CLOSED_ACTIVE);
      await Promise.resolve();
    });
    await screen.findByText("Смена OCT26-004 закрыта.");
    expect(session.api.closeShift).toHaveBeenCalledTimes(1);
  });

  it("frees the reason after a refusal so it can be mended", async () => {
    const session = shiftsSession();
    const write = pending<OfficeShift>();
    session.api.closeShift.mockReturnValueOnce(write.promise);
    await openClose(session);
    giveReason("Станция сломалась");
    await waitFor(() => expect(reason().readOnly).toBe(true));
    await act(async () => {
      write.reject(api("validation_failed", { field: "reason" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(reason().readOnly).toBe(false));
    expect(reasonNote()).toBe(REASON_WORDS);
  });

  it("closes nothing when the dialog is cancelled, and opens empty again", async () => {
    const session = shiftsSession();
    await openClose(session);
    fireEvent.change(reason(), { target: { value: "Станция сломалась" } });
    fireEvent.click(cancelButton("Закрыть смену OCT26-004"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(session.api.closeShift).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть смену OCT26-004" }));
    await screen.findByRole("dialog", { name: "Закрыть смену OCT26-004" });
    expect(reason().value).toBe("");
    expect(reasonNote()).toBe(
      "От 3 до 500 символов, одной строкой. Её увидят в списке смен и в журнале действий.",
    );
  });

  it("is offered to both roles for an active shift only, never for a planned or closed one", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const session = shiftsSession(undefined, user);
      session.api.closeShift.mockResolvedValue(CLOSED_ACTIVE);
      const view = await openShifts(session);
      expect(screen.getAllByRole("button", { name: /^Закрыть смену / })).toHaveLength(1);
      expect(within(shiftRow("OCT26-005")).queryByRole("button", { name: /Закрыть/ })).toBeNull();
      expect(within(shiftRow("OCT26-001/S")).queryAllByRole("button")).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Закрыть смену OCT26-004" }));
      await screen.findByRole("dialog", { name: "Закрыть смену OCT26-004" });
      giveReason("Станция сломалась");
      await screen.findByText("Смена OCT26-004 закрыта.");
      expect(session.api.closeShift).toHaveBeenCalledWith(TOKEN, ACTIVE.id, {
        reason: "Станция сломалась",
        expectedRev: 71,
      });
      view.unmount();
    }
  });
});
