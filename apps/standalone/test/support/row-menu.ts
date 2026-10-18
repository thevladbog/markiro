import { fireEvent, screen, type within } from "@testing-library/react";

type Scope = Pick<typeof screen, "queryByRole" | "queryAllByRole"> | ReturnType<typeof within>;

/**
 * Presses a table row's action by its accessible name: the button when the row
 * shows it, else the item of the row's «⋯» menu (`RowActionMenu`), which this
 * opens first. The same name serves both, so a test does not care which of the
 * two the page chose.
 */
export function pressRowAction(scope: Scope, name: string | RegExp): void {
  const button = scope.queryByRole("button", { name });
  if (button) {
    fireEvent.click(button);
    return;
  }
  for (const trigger of scope.queryAllByRole("button", { name: /^Действия: / })) {
    fireEvent.click(trigger);
    const item = screen.queryByRole("menuitem", { name });
    if (item) {
      fireEvent.click(item);
      return;
    }
    fireEvent.keyDown(trigger, { key: "Escape" });
  }
  throw new Error(`no row action named ${String(name)}`);
}

/** Whether a row (or the page) offers the action, as a button or as a menu item. */
export function hasRowAction(scope: Scope, name: string | RegExp): boolean {
  if (scope.queryByRole("button", { name })) return true;
  for (const trigger of scope.queryAllByRole("button", { name: /^Действия: / })) {
    fireEvent.click(trigger);
    const found = screen.queryByRole("menuitem", { name }) !== null;
    fireEvent.keyDown(screen.queryByRole("menu") ?? trigger, { key: "Escape" });
    if (found) return true;
  }
  return false;
}

/**
 * The element of a row's action: the button, or the item of the row's «⋯» menu,
 * which is left open for the caller to look at (its disabled state, for one).
 */
export function findRowAction(scope: Scope, name: string | RegExp): HTMLElement {
  const button = scope.queryByRole("button", { name });
  if (button) return button;
  for (const trigger of scope.queryAllByRole("button", { name: /^Действия: / })) {
    if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
    const item = screen.queryByRole("menuitem", { name });
    if (item) return item;
    fireEvent.keyDown(trigger, { key: "Escape" });
  }
  throw new Error(`no row action named ${String(name)}`);
}
