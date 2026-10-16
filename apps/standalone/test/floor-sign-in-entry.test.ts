import { describe, expect, it } from "vitest";

import { appendDigit } from "../src/floor/kit/numeric-entry.js";
import {
  canSubmit,
  editEntry,
  fieldStatus,
  afterAttempt,
  selectField,
  type Entry,
} from "../src/floor/sign-in/entry.js";

const start: Entry = { active: "login", login: "", pin: "" };
const typed = (entry: Entry, digits: string) =>
  [...digits].reduce((now, digit) => editEntry(now, { kind: "digit", digit }), entry);

describe("the shared keypad's digits", () => {
  it("keeps a leading zero only when the field asks for it (a personnel number and a PIN may start with 0)", () => {
    expect(appendDigit("", "0", 12)).toBe("");
    expect(appendDigit("", "0", 12, true)).toBe("0");
    expect(appendDigit("0", "4", 12, true)).toBe("04");
    expect(appendDigit("", "x", 12, true)).toBe("");
    expect(appendDigit("123456", "7", 6, true)).toBe("123456");
  });
});

describe("the sign-in's two fields and one keypad", () => {
  it("edits the active field only: the number first, then the PIN once it is chosen", () => {
    let entry = typed(start, "0042");
    expect(entry).toEqual({ active: "login", login: "0042", pin: "" });
    entry = selectField(entry, "pin");
    entry = typed(entry, "4821");
    expect(entry).toEqual({ active: "pin", login: "0042", pin: "4821" });
  });

  it("takes at most 12 digits of a number and 6 of a PIN, zeros included", () => {
    expect(typed(start, "00000000000099").login).toBe("000000000000");
    expect(typed({ ...start, active: "pin" }, "1234567890").pin).toBe("123456");
  });

  it("hands the keypad to the PIN when the number is full, as it can take no more", () => {
    const full = typed(start, "12345678901");
    expect(full.active).toBe("login");
    expect(typed(start, "123456789012").active).toBe("pin");
  });

  it("«Стереть» drops the last digit of the active field; on an empty PIN it only goes back to the number", () => {
    expect(editEntry({ active: "login", login: "0042", pin: "" }, { kind: "backspace" }).login).toBe(
      "004",
    );
    expect(
      editEntry({ active: "pin", login: "0042", pin: "48" }, { kind: "backspace" }),
    ).toEqual({ active: "pin", login: "0042", pin: "4" });
    expect(
      editEntry({ active: "pin", login: "0042", pin: "" }, { kind: "backspace" }),
    ).toEqual({ active: "login", login: "0042", pin: "" });
    expect(editEntry(start, { kind: "backspace" })).toEqual(start);
  });

  it("«Сброс» empties the active field and leaves the other one", () => {
    expect(editEntry({ active: "pin", login: "0042", pin: "48" }, { kind: "clear" })).toEqual({
      active: "pin",
      login: "0042",
      pin: "",
    });
    expect(editEntry({ active: "login", login: "0042", pin: "48" }, { kind: "clear" })).toEqual({
      active: "login",
      login: "",
      pin: "48",
    });
  });

  it("offers «Войти» for a number of 3–12 digits together with a PIN of 4–6", () => {
    expect(canSubmit({ active: "pin", login: "004", pin: "1234" })).toBe(true);
    expect(canSubmit({ active: "pin", login: "00", pin: "1234" })).toBe(false);
    expect(canSubmit({ active: "pin", login: "0042", pin: "123" })).toBe(false);
    expect(canSubmit({ active: "pin", login: "123456789012", pin: "123456" })).toBe(true);
  });

  it("empties the PIN after every answer, and puts the keypad on it after a PIN's answer", () => {
    const entry: Entry = { active: "pin", login: "0042", pin: "4821" };
    expect(afterAttempt(entry, "pin")).toEqual({ active: "pin", login: "0042", pin: "" });
    const onLogin: Entry = { active: "login", login: "0042", pin: "48" };
    expect(afterAttempt(onLogin, "badge")).toEqual({ active: "login", login: "0042", pin: "" });
    expect(afterAttempt(onLogin, "pin").active).toBe("pin");
  });
});

describe("what each field says about itself", () => {
  const entry = (over: Partial<Entry>): Entry => ({ ...start, ...over });

  it("is empty, active, accepted (valid and not active) or merely filled", () => {
    expect(fieldStatus("login", entry({}), {})).toBe("active");
    expect(fieldStatus("pin", entry({}), {})).toBe("empty");
    expect(fieldStatus("login", entry({ active: "pin", login: "0042" }), {})).toBe("accepted");
    expect(fieldStatus("login", entry({ active: "pin", login: "00" }), {})).toBe("filled");
    expect(fieldStatus("pin", entry({ active: "login", pin: "4821" }), {})).toBe("accepted");
  });

  it("puts an error over a plain state and a lock over an error", () => {
    const now = entry({ active: "pin", login: "0042" });
    expect(fieldStatus("pin", now, { error: "pin" })).toBe("error");
    expect(fieldStatus("login", now, { error: "pin" })).toBe("accepted");
    expect(fieldStatus("pin", now, { error: "pin", locked: ["pin"] })).toBe("locked");
    expect(fieldStatus("login", now, { locked: ["pin", "login"] })).toBe("locked");
  });
});
