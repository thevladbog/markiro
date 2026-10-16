import { fireEvent, screen, waitFor, within } from "@testing-library/react";

/** The office top bar's user menu, opened (the trigger shows the person; its entries are «Сменить пароль» and «Выйти из офиса»). */
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
export async function chooseFromUserMenu(name: "Сменить пароль" | "Выйти из офиса"): Promise<void> {
  const menu = await openUserMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
}
