import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";

import { ThemeProvider } from "@markiro/ui";

import { OfficeTopBar } from "../src/office/OfficeTopBar.js";
import { OfficeLinkProvider } from "../src/office/office-link.js";
import type { HostStatus } from "../src/host/protocol.js";
import { SESSION } from "./support/fixtures.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { fakeOfficeSession } from "./support/office.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { WindowModeProvider, type WindowMode } from "../src/office/window-mode.js";

const originalWidth = window.innerWidth;
const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
function resize(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}
function mount(status = ONLINE, windowMode: WindowMode | null = null) {
  render(
    <ThemeProvider defaultTheme="dark">
      <MemoryRouter>
        <QueryClientProvider client={createOfficeQueryClient()}>
          <OfficeSessionProvider value={fakeOfficeSession()}>
            <OfficeLinkProvider value={{ status, sync: null }}>
              <WindowModeProvider value={windowMode}>
                <OfficeTopBar
                  user={SESSION.user}
                  pathname="/about"
                  menuCollapsed
                  menuId="office-nav"
                  onToggleMenu={vi.fn()}
                  onToFloor={null}
                  onProfile={vi.fn()}
                  onChangePassword={vi.fn()}
                  onSignOut={vi.fn()}
                  onWindowLeft={vi.fn()}
                />
              </WindowModeProvider>
            </OfficeLinkProvider>
          </OfficeSessionProvider>
        </QueryClientProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}
beforeEach(() => {
  resize(390);
  localStorage.clear();
});
afterEach(() => act(() => resize(originalWidth)));

describe("the compact office header", () => {
  it("keeps the page and named profile available with secondary controls behind one button", async () => {
    mount();
    expect(screen.getByText("Информация").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /Ирина Смирнова.*Администратор/ })).toBeTruthy();
    const tools = screen.getByRole("button", { name: /Настройки и состояние/ });
    expect(tools.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(tools);
    const panel = screen.getByRole("dialog", { name: "Настройки и состояние" });
    expect(tools.getAttribute("aria-controls")).toBe(panel.id);
    expect(within(panel).getByRole("button", { name: /Связь с хостом/ })).toBe(
      document.activeElement,
    );
    fireEvent.click(within(panel).getByRole("radio", { name: "Светлая" }));
    await waitFor(() => expect(localStorage.getItem("markiro.theme")).toBe("light"));
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(tools);
  });

  it("closes on outside presses and when keyboard focus leaves the panel", () => {
    mount();
    const tools = screen.getByRole("button", { name: /Настройки и состояние/ });
    fireEvent.click(tools);
    fireEvent.pointerDown(screen.getByText("Информация"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(tools);
    fireEvent.blur(screen.getByRole("dialog"), {
      relatedTarget: screen.getByRole("button", { name: /Ирина Смирнова/ }),
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a host failure visible on the closed tools button", () => {
    mount({ ...ONLINE, state: "offline", lastError: "unreachable" });
    const tools = screen.getByRole("button", { name: /Настройки и состояние.*Нет связи/ });
    expect(tools.querySelector(".status-dot--error")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Нет связи");
  });

  it("restores the normal desktop controls on resize", () => {
    mount();
    act(() => resize(1280));
    expect(screen.queryByRole("button", { name: /Настройки и состояние/ })).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Тема оформления" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Связь с хостом/ })).toBeTruthy();
  });

  it("keeps the kiosk confirmation alive through portalled focus and a window resize", async () => {
    mount(ONLINE, { mode: "locked", leave: vi.fn(async () => true) });
    fireEvent.click(screen.getByRole("button", { name: /Настройки и состояние/ }));
    fireEvent.click(screen.getByRole("button", { name: "Оконный режим" }));
    const confirmation = await screen.findByRole("dialog", { name: "Перейти в оконный режим?" });
    fireEvent.pointerDown(confirmation);
    expect(screen.getByRole("dialog", { name: "Перейти в оконный режим?" })).toBe(confirmation);
    act(() => resize(1280));
    expect(screen.getByRole("dialog", { name: "Перейти в оконный режим?" })).toBe(confirmation);
    act(() => resize(390));
    expect(screen.getByRole("dialog", { name: "Перейти в оконный режим?" })).toBe(confirmation);
    fireEvent.click(within(confirmation).getByRole("button", { name: "Отмена" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Перейти в оконный режим?" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Настройки и состояние" })).toBeTruthy();
  });
});
