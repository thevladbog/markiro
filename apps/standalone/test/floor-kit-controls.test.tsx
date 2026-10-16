import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModeSegment } from "../src/floor/kit/ModeSegment.js";
import { NumericKeypad } from "../src/floor/kit/NumericKeypad.js";
import { NumericReadout } from "../src/floor/kit/NumericReadout.js";
import { PhotoSquare } from "../src/floor/kit/PhotoSquare.js";
import { SwitchCard } from "../src/floor/kit/SwitchCard.js";
import {
  appendDigit,
  dropDigit,
  groupDigits,
  SCAN_END_GAP_MS,
  SCAN_KEY_GAP_MS,
  useKeyboardDigits,
} from "../src/floor/kit/numeric-entry.js";

/**
 * Design kit 2026-10, step B: the floor controls of «Новая смена», each on its own.
 */

describe("the digit string of the keypad", () => {
  it("appends a digit, but not a non-digit, a leading zero or past the limit", () => {
    expect(appendDigit("", "5", 8)).toBe("5");
    expect(appendDigit("12", "3", 8)).toBe("123");
    expect(appendDigit("12", "0", 8)).toBe("120");
    expect(appendDigit("", "0", 8)).toBe("");
    expect(appendDigit("12", "a", 8)).toBe("12");
    expect(appendDigit("12", "٣", 8)).toBe("12");
    expect(appendDigit("12", "34", 8)).toBe("12");
    expect(appendDigit("1234567", "8", 8)).toBe("12345678");
    expect(appendDigit("12345678", "9", 8)).toBe("12345678");
  });

  it("drops the last digit, and groups by thin spaces for the readout only", () => {
    expect(dropDigit("1200")).toBe("120");
    expect(dropDigit("")).toBe("");
    expect(groupDigits("1")).toBe("1");
    expect(groupDigits("120")).toBe("120");
    expect(groupDigits("1200")).toBe("1\u202f200");
    expect(groupDigits("10000000", " ")).toBe("10 000 000");
  });
});

function Keypad({ max = 6, disabled = false }: { max?: number; disabled?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <>
      <output data-testid="value">{value}</output>
      <NumericKeypad
        value={value}
        onChange={setValue}
        maxLength={max}
        disabled={disabled}
        ariaLabel="Цифровая клавиатура"
        clearLabel="Очистить"
        backspaceLabel="Стереть цифру"
      />
    </>
  );
}

const shown = () => screen.getByTestId("value").textContent;
const key = (name: string) => screen.getByRole("button", { name });

describe("NumericKeypad", () => {
  it("is a labelled group of twelve keys in the 3 x 4 order of the kit", () => {
    render(<Keypad />);
    const group = screen.getByRole("group", { name: "Цифровая клавиатура" });
    const names = within(group)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(names).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "Очистить",
      "0",
      "Стереть цифру",
    ]);
  });

  it("types digits, erases the last one and clears", () => {
    render(<Keypad />);
    for (const digit of ["1", "2", "0", "0"]) fireEvent.click(key(digit));
    expect(shown()).toBe("1200");
    fireEvent.click(key("Стереть цифру"));
    expect(shown()).toBe("120");
    fireEvent.click(key("Очистить"));
    expect(shown()).toBe("");
    fireEvent.click(key("Стереть цифру"));
    expect(shown()).toBe("");
  });

  it("takes no leading zero and no digit past the maximum length", () => {
    render(<Keypad max={3} />);
    fireEvent.click(key("0"));
    expect(shown()).toBe("");
    for (const digit of ["1", "2", "3", "4", "5"]) fireEvent.click(key(digit));
    expect(shown()).toBe("123");
    fireEvent.click(key("0"));
    expect(shown()).toBe("123");
  });

  it("is plain buttons: no text field, and a tap does not take the focus off the page", () => {
    render(<Keypad />);
    expect(document.querySelector("input, textarea, [contenteditable]")).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("type")).toBe("button");
      // A tap would move the focus to the key; the scanner's closing Enter would press it again.
      expect(fireEvent.mouseDown(button)).toBe(false);
    }
  });

  it("disables every key together", () => {
    render(<Keypad disabled />);
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

function Readout(props: Partial<React.ComponentProps<typeof NumericReadout>>) {
  return (
    <NumericReadout
      label="План, шт."
      note="необязательно"
      value="1200"
      unit="шт."
      active={true}
      {...props}
    />
  );
}

describe("NumericReadout", () => {
  it("is a button, not a text field, named by its label, the value and the unit", () => {
    render(<Readout />);
    expect(document.querySelector("input")).toBeNull();
    const field = screen.getByRole("button", { name: /^План, шт\./ });
    expect(field.textContent).toContain("1200");
    expect(field.textContent).toContain("необязательно");
    expect(field.textContent).toContain("шт.");
    // The thin spaces are boxes, not characters: a reader says one number.
    expect(field.querySelectorAll(".floor-readout__thin")).toHaveLength(1);
    expect(field.querySelector(".floor-readout__digits")?.textContent).toBe("1200");
  });

  it("shows a dash for an empty entry, and says which field the keypad edits", () => {
    const select = vi.fn();
    const { rerender } = render(<Readout value="" active={false} onSelect={select} />);
    const field = screen.getByRole("button", { name: /^План, шт\./ });
    expect(field.querySelector(".floor-readout__digits")).toBeNull();
    expect(field.querySelector(".floor-readout__empty")?.textContent).toBe("—");
    expect(field.getAttribute("aria-pressed")).toBe("false");
    expect(field.getAttribute("data-active")).toBeNull();
    fireEvent.click(field);
    expect(select).toHaveBeenCalledTimes(1);
    rerender(<Readout value="" active={true} onSelect={select} />);
    expect(field.getAttribute("aria-pressed")).toBe("true");
    expect(field.getAttribute("data-active")).toBe("true");
    // The only field has nothing to choose: no pressed state.
    rerender(<Readout value="" active={null} />);
    expect(field.hasAttribute("aria-pressed")).toBe(false);
    expect(field.getAttribute("data-active")).toBe("true");
  });

  it("marks an error with aria-invalid and points at its line", () => {
    render(<Readout invalid errorId="e1" />);
    const field = screen.getByRole("button", { name: /^План, шт\./ });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe("e1");
  });
});

function Segment({ hint = "Подсказка", disabled = false }: { hint?: string; disabled?: boolean }) {
  const [value, setValue] = useState<"validation" | "aggregation">("aggregation");
  return (
    <ModeSegment
      label="Режим работы"
      options={[
        { value: "validation", label: "Проверка" },
        { value: "aggregation", label: "Агрегация" },
      ]}
      value={value}
      onChange={setValue}
      hint={hint}
      disabled={disabled}
    />
  );
}

describe("ModeSegment", () => {
  it("is a radio group named by its caption, the selected radio carrying a check", () => {
    render(<Segment />);
    const group = screen.getByRole("radiogroup", { name: "Режим работы" });
    const [validation, aggregation] = within(group).getAllByRole("radio");
    expect(validation?.getAttribute("aria-checked")).toBe("false");
    expect(aggregation?.getAttribute("aria-checked")).toBe("true");
    // Not colour alone: a check icon sits in the selected option only.
    expect(aggregation?.querySelector("svg")).not.toBeNull();
    expect(validation?.querySelector("svg")).toBeNull();
    expect(group.getAttribute("aria-describedby")).not.toBeNull();
  });

  it("says its hint politely, in a line that is there before it has words", () => {
    const { rerender } = render(<Segment hint="" />);
    const line = document.querySelector(".floor-mode__hint");
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.textContent).toBe("");
    rerender(<Segment hint="Одна строка" />);
    expect(document.querySelector(".floor-mode__hint")).toBe(line);
  });

  it("chooses by a tap and by the arrows, with one tab stop", () => {
    render(<Segment />);
    const [validation, aggregation] = screen.getAllByRole("radio");
    expect(validation?.getAttribute("tabindex")).toBe("-1");
    expect(aggregation?.getAttribute("tabindex")).toBe("0");
    fireEvent.click(validation as HTMLElement);
    expect(validation?.getAttribute("aria-checked")).toBe("true");
    expect(validation?.getAttribute("tabindex")).toBe("0");
    expect(aggregation?.getAttribute("tabindex")).toBe("-1");
    (validation as HTMLElement).focus();
    fireEvent.keyDown(validation as HTMLElement, { key: "ArrowRight" });
    expect(aggregation?.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(aggregation);
    fireEvent.keyDown(aggregation as HTMLElement, { key: "ArrowRight" });
    expect(validation?.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(validation as HTMLElement, { key: "ArrowUp" });
    expect(aggregation?.getAttribute("aria-checked")).toBe("true");
  });

  it("does nothing while disabled", () => {
    render(<Segment disabled />);
    const [validation] = screen.getAllByRole("radio");
    fireEvent.click(validation as HTMLElement);
    fireEvent.keyDown(validation as HTMLElement, { key: "ArrowLeft" });
    expect(validation?.getAttribute("aria-checked")).toBe("false");
  });
});

function Switch({ disabled = false, detail }: { disabled?: boolean; detail?: string }) {
  const [on, setOn] = useState(false);
  return (
    <SwitchCard
      title="Печатать дубликат Data Matrix"
      hint="Количество продукции не меняется."
      {...(detail === undefined ? {} : { detail })}
      checked={on}
      onChange={setOn}
      stateLabel={on ? "Включено" : "Выключено"}
      disabled={disabled}
    />
  );
}

describe("SwitchCard", () => {
  it("is one switch named by its title, described by its hint, with the state in words", () => {
    render(<Switch />);
    const card = screen.getByRole("switch", { name: "Печатать дубликат Data Matrix" });
    expect(card.getAttribute("aria-checked")).toBe("false");
    expect(card.getAttribute("aria-describedby")).not.toBeNull();
    expect(card.textContent).toContain("Выключено");
    // The whole card is the one control: no second button inside it.
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("flips as a whole, and shows the detail the caller gives it", () => {
    render(<Switch detail="Шаблон: Дубликат" />);
    const card = screen.getByRole("switch");
    expect(card.textContent).toContain("Шаблон: Дубликат");
    fireEvent.click(card);
    expect(card.getAttribute("aria-checked")).toBe("true");
    expect(card.textContent).toContain("Включено");
    fireEvent.click(card);
    expect(card.getAttribute("aria-checked")).toBe("false");
  });

  it("stays as it is while disabled", () => {
    render(<Switch disabled />);
    const card = screen.getByRole("switch");
    fireEvent.click(card);
    expect(card.getAttribute("aria-checked")).toBe("false");
    expect((card as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PhotoSquare", () => {
  it("is one frame holding whatever it is given, and takes its side from a variable", () => {
    const { container } = render(
      <PhotoSquare size={132}>
        <img className="product-photo" alt="" src="data:image/png;base64,AA==" />
      </PhotoSquare>,
    );
    const frame = container.querySelector(".floor-photo-square") as HTMLElement;
    expect(frame.style.getPropertyValue("--floor-photo")).toBe("132px");
    expect(frame.children).toHaveLength(1);
    expect(frame.querySelector("img.product-photo")).not.toBeNull();
    // ONE frame: no inner shell around the picture.
    expect(container.querySelectorAll(".floor-photo-square .floor-photo-square")).toHaveLength(0);
  });

  it("leaves the side to the stylesheet when none is given", () => {
    const { container } = render(<PhotoSquare>x</PhotoSquare>);
    expect((container.firstElementChild as HTMLElement).getAttribute("style")).toBeNull();
  });
});

/** A host component for the keyboard hook: the area is a div that listens for `keydown`. */
function Keyboard({ clock, max = 8 }: { clock: () => number; max?: number }) {
  const [value, setValue] = useState("");
  const onKeyDown = useKeyboardDigits({ value, onChange: setValue, maxLength: max, clock });
  return (
    <div data-testid="area" tabIndex={0} onKeyDown={onKeyDown}>
      <output data-testid="value">{value}</output>
    </div>
  );
}

function clockAt(times: number[]): () => number {
  let at = 0;
  return () => times[Math.min(at++, times.length - 1)] ?? 0;
}

describe("the keyboard digits of the keypad area", () => {
  const SLOW = 1000;

  it("types digits at a hand's pace, erases with Backspace and clears with Delete", () => {
    render(<Keyboard clock={clockAt([0, SLOW, 2 * SLOW, 3 * SLOW, 4 * SLOW, 5 * SLOW])} />);
    const area = screen.getByTestId("area");
    for (const digit of ["1", "2", "0"]) fireEvent.keyDown(area, { key: digit });
    expect(shown()).toBe("120");
    fireEvent.keyDown(area, { key: "Backspace" });
    expect(shown()).toBe("12");
    fireEvent.keyDown(area, { key: "Delete" });
    expect(shown()).toBe("");
  });

  it("takes no leading zero and no digit past the maximum, and no letter", () => {
    render(<Keyboard max={2} clock={clockAt([0, SLOW, 2 * SLOW, 3 * SLOW, 4 * SLOW])} />);
    const area = screen.getByTestId("area");
    for (const key of ["0", "a", "1", "2", "3"]) fireEvent.keyDown(area, { key });
    expect(shown()).toBe("12");
  });

  it("leaves shortcuts alone", () => {
    render(<Keyboard clock={clockAt([0, SLOW, 2 * SLOW])} />);
    const area = screen.getByTestId("area");
    expect(fireEvent.keyDown(area, { key: "5", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(area, { key: "5", metaKey: true })).toBe(true);
    expect(shown()).toBe("");
  });

  it("takes digits typed faster than a hand for a scanner's: they are taken back and dropped, and its Enter presses nothing", () => {
    // 1, then 2 and 3 within the scan gap, then Enter right after.
    const t0 = 5_000;
    const gap = SCAN_KEY_GAP_MS / 4;
    render(<Keyboard clock={clockAt([t0, t0 + gap, t0 + 2 * gap, t0 + 3 * gap, t0 + 10 * gap])} />);
    const area = screen.getByTestId("area");
    fireEvent.keyDown(area, { key: "1" });
    expect(shown()).toBe("1");
    fireEvent.keyDown(area, { key: "2" });
    // The first digit of the run is taken back with the rest of it.
    expect(shown()).toBe("");
    fireEvent.keyDown(area, { key: "3" });
    expect(shown()).toBe("");
    // fireEvent returns false when the default was prevented: Enter does not press the focused key.
    expect(fireEvent.keyDown(area, { key: "Enter" })).toBe(false);
  });

  it("keeps what was typed before a scan, and types again after it", () => {
    const t0 = 5_000;
    const gap = SCAN_KEY_GAP_MS / 4;
    const later = t0 + 10 * SCAN_END_GAP_MS;
    render(
      <Keyboard
        clock={clockAt([
          t0, // hand: 7
          t0 + SCAN_END_GAP_MS, // scan: 4
          t0 + SCAN_END_GAP_MS + gap, // scan: 5
          t0 + SCAN_END_GAP_MS + 2 * gap, // Enter closing the scan
          later, // hand: 9
        ])}
      />,
    );
    const area = screen.getByTestId("area");
    fireEvent.keyDown(area, { key: "7" });
    fireEvent.keyDown(area, { key: "4" });
    fireEvent.keyDown(area, { key: "5" });
    expect(shown()).toBe("7");
    fireEvent.keyDown(area, { key: "Enter" });
    fireEvent.keyDown(area, { key: "9" });
    expect(shown()).toBe("79");
  });

  it("lets an Enter that closes no scan through", () => {
    render(<Keyboard clock={clockAt([0, SLOW])} />);
    const area = screen.getByTestId("area");
    fireEvent.keyDown(area, { key: "1" });
    expect(fireEvent.keyDown(area, { key: "Enter" })).toBe(true);
  });
});
