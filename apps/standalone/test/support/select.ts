import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
  type waitForOptions,
} from "@testing-library/react";

/**
 * Helpers for `@markiro/ui`'s `Select`, the office's only dropdown: a Radix
 * trigger and a listbox in a portal, not a native `<select>`. They drive it
 * as a person does (open the list, pick an option); a test names a field by
 * its label and an option by its value (the id or code the form sends) or by
 * its text. Inside a `<form>` Radix mirrors its items into a hidden native
 * `<select>`, which is how a value is turned into the text shown for it; a
 * select outside a form (a filter) is picked by its text only.
 *
 * Each helper has a name form (`chooseValue("Линия", id)`) and an `…On` form
 * that takes the trigger element, for a test that already holds the control.
 */

type Name = string | RegExp;

/** What `Select` stands in for the empty value inside Radix, which cannot hold "". */
const EMPTY_OPTION_VALUE = "__markiro_empty_option__";
const toRadix = (value: string) => (value === "" ? EMPTY_OPTION_VALUE : value);
const fromRadix = (value: string) => (value === EMPTY_OPTION_VALUE ? "" : value);

/** The trigger of the field called `name` (its label or `aria-label`). */
export function selectTrigger(name: Name): HTMLElement {
  return screen.getByRole("combobox", { name });
}

/** Whether `control` is a `Select`'s trigger (and not an input or a native select). */
export function isSelectTrigger(control: HTMLElement): boolean {
  return control instanceof HTMLButtonElement && control.getAttribute("role") === "combobox";
}

function proxyOf(trigger: HTMLElement): HTMLSelectElement {
  const proxy = trigger
    .closest(".mk-field")
    ?.querySelector<HTMLSelectElement>("select[aria-hidden='true']");
  if (!proxy) throw new Error("the select has no form proxy (it is outside a form)");
  return proxy;
}

/** The text a value is listed under (`null` where the field has no such option). */
export function optionTextOn(trigger: HTMLElement, value: string): string | null {
  const option = Array.from(proxyOf(trigger).options).find((each) => each.value === toRadix(value));
  return option?.textContent ?? null;
}

/** The text shown in the closed field. */
export function shownOn(trigger: HTMLElement): string {
  return (trigger.textContent ?? "").trim();
}

/** Opens the list of the field. */
export function openSelectOn(trigger: HTMLElement): HTMLElement {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pageX: 0,
    pageY: 0,
    pointerId: 1,
    pointerType: "mouse",
  });
  return screen.getByRole("listbox");
}

/**
 * The texts of the options of the field, in order; the list is closed again (a
 * disabled field cannot be opened, so it is read from its form proxy).
 */
export function optionTextsOn(trigger: HTMLElement): string[] {
  if (trigger.hasAttribute("disabled")) {
    // Radix adds an empty, unlabelled option while no value is chosen; it is not a choice.
    return Array.from(proxyOf(trigger).options)
      .filter((option) => option.value !== "" || (option.textContent ?? "") !== "")
      .map((option) => (option.textContent ?? "").trim());
  }
  const list = openSelectOn(trigger);
  const texts = within(list)
    .getAllByRole("option")
    .map((option) => (option.textContent ?? "").trim());
  fireEvent.keyDown(list, { key: "Escape" });
  return texts;
}

/** The `[value, text]` of every option of the field (from its form proxy), in order. */
export function optionPairsOn(trigger: HTMLElement): [string, string][] {
  return Array.from(proxyOf(trigger).options, (option) => [
    fromRadix(option.value),
    (option.textContent ?? "").trim(),
  ]);
}

/** Picks the option listed under `text`, as a click does. */
export function chooseTextOn(trigger: HTMLElement, text: string): void {
  const list = openSelectOn(trigger);
  fireEvent.click(within(list).getByRole("option", { name: text }));
}

/** Picks the option whose value is `value` (`""` is the empty option). */
export function chooseValueOn(trigger: HTMLElement, value: string): void {
  const text = optionTextOn(trigger, value);
  if (text === null) throw new Error(`the select has no option with the value "${value}"`);
  chooseTextOn(trigger, text);
}

/** The value the field holds: the form proxy's, which Radix keeps in step with the trigger. */
export function valueOn(trigger: HTMLElement): string {
  return fromRadix(proxyOf(trigger).value);
}

export const optionTextOf = (name: Name, value: string) => optionTextOn(selectTrigger(name), value);
export const shownIn = (name: Name) => shownOn(selectTrigger(name));
export const openSelect = (name: Name) => openSelectOn(selectTrigger(name));
export const optionTexts = (name: Name) => optionTextsOn(selectTrigger(name));
export const chooseText = (name: Name, text: string) => chooseTextOn(selectTrigger(name), text);
export const chooseValue = (name: Name, value: string) => chooseValueOn(selectTrigger(name), value);
export const valueOf = (name: Name) => valueOn(selectTrigger(name));

/**
 * Lets the select that was just picked finish: Radix hands focus back to the
 * trigger one macrotask after its list closes. A person is slower than that; a
 * test that goes on at once and then asks where focus is must wait for it.
 */
export async function settleSelect(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * `waitFor` for a check that opens a list (`optionTexts`, `chooseValue`…).
 * Opening and closing a list changes the page, and `waitFor` runs its check
 * again on every change it observes: a check that fails wakes itself in a loop
 * of microtasks that no timer breaks — not the query that would make it pass,
 * nor the test's timeout — and the test file hangs for good. This one watches
 * an empty, detached element instead of the page, so it only polls.
 */
export function waitForList<T>(
  check: () => T | Promise<T>,
  options: Omit<waitForOptions, "container"> = {},
): Promise<T> {
  return waitFor(check, { ...options, container: document.createElement("div") });
}
