import { fireEvent, screen, waitFor, within } from "@testing-library/react";

/** The office top bar's user menu, opened (the trigger shows the person; it contains profile and exit actions). */
export async function openUserMenu(): Promise<HTMLElement> {
  const trigger = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(".user-menu__trigger");
    if (found === null) throw new Error("no user menu trigger yet");
    return found;
  });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return screen.findByRole("menu", { name: "Меню пользователя" });
}

/** Opens the user menu and presses one of its entries. */
export async function chooseFromUserMenu(
  name: "Профиль" | "Сменить пароль" | "Выйти в цех" | "Выйти из офиса",
): Promise<void> {
  const menu = await openUserMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
}
