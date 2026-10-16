import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UserMenu } from "../src/office/UserMenu.js";

function mount() {
  const onProfile = vi.fn();
  const onChangePassword = vi.fn();
  const onSignOut = vi.fn();
  render(
    <div>
      <UserMenu
        userId="u-1"
        avatarVersion={null}
        name="Иван Петров"
        login="ivan"
        roleLabel="Администратор"
        onProfile={onProfile}
        onChangePassword={onChangePassword}
        onSignOut={onSignOut}
      />
      <p>вне</p>
    </div>,
  );
  const trigger = screen.getByRole("button", { name: /Иван Петров/ });
  return { trigger, onProfile, onChangePassword, onSignOut };
}

describe("UserMenu", () => {
  it("shows the person on the trigger and keeps the menu closed", () => {
    const { trigger } = mount();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(within(trigger).getByText("Иван Петров")).toBeTruthy();
    expect(within(trigger).getByText("Администратор")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("draws the person's avatar on the trigger and in the menu's header, decorative", () => {
    const { trigger } = mount();
    const onTrigger = trigger.querySelector(".user-avatar");
    expect(onTrigger?.textContent).toBe("ИП");
    expect(onTrigger?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(trigger);
    const inHeader = screen.getByRole("menu").querySelector(".user-avatar");
    expect(inHeader?.textContent).toBe("ИП");
    expect(inHeader?.className).toBe(
      onTrigger?.className.replace("user-avatar--32", "user-avatar--40"),
    );
  });

  it("opens on a click with the identity and exactly the three entries, the first one focused", () => {
    const { trigger } = mount();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Меню пользователя" });
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Профиль",
      "Сменить пароль",
      "Выйти из офиса",
    ]);
    expect(document.activeElement).toBe(items[0]);
    // The identity is text, not an entry.
    expect(within(menu).getByText("Администратор · ivan")).toBeTruthy();
  });

  it("moves with the arrows, wraps, and jumps with Home and End", () => {
    const { trigger } = mount();
    fireEvent.click(trigger);
    const [first, second, third] = screen.getAllByRole("menuitem");
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(third);
  });

  it("opens from the trigger with ArrowDown on the first entry and ArrowUp on the last", () => {
    const { trigger } = mount();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[2]);
  });

  it("closes on Escape and returns the focus to the trigger", () => {
    const { trigger } = mount();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Tab and on a press outside", () => {
    const { trigger } = mount();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByText("вне"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("runs «Профиль» and closes", () => {
    const { trigger, onProfile, onChangePassword } = mount();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Профиль" }));
    expect(onProfile).toHaveBeenCalledTimes(1);
    expect(onChangePassword).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("runs «Сменить пароль» and closes", () => {
    const { trigger, onChangePassword, onSignOut } = mount();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Сменить пароль" }));
    expect(onChangePassword).toHaveBeenCalledTimes(1);
    expect(onSignOut).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("runs «Выйти из офиса» and closes", () => {
    const { trigger, onSignOut } = mount();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Выйти из офиса" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
