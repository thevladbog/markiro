import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALERT_TONE,
  Alert,
  EmptyState,
  Modal,
  PageHeader,
  Sidebar,
  Spinner,
  toast,
  type AlertTone,
  type SidebarItem,
} from "../src/components/index.js";

afterEach(() => {
  cleanup();
});

describe("Alert", () => {
  it.each(Object.keys(ALERT_TONE) as AlertTone[])(
    "maps tone=%s to its semantic token colors",
    (tone) => {
      const { container } = render(<Alert tone={tone}>Message</Alert>);

      const alert = screen.getByRole("alert");
      expect(alert.style.background).toBe(ALERT_TONE[tone].bg);
      expect(alert.style.border).toContain(ALERT_TONE[tone].border);
      // the glyph carries the tone's foreground color so it never depends on color alone
      const glyph = container.querySelector('[aria-hidden="true"]');
      expect(glyph).not.toBeNull();
      expect((glyph as HTMLElement).style.color).toBe(ALERT_TONE[tone].fg);
    },
  );

  it("renders a title and an action alongside the message", () => {
    render(
      <Alert tone="error" title="Принтер не отвечает" action={<button>Повторить</button>}>
        Проверьте кабель и питание.
      </Alert>,
    );

    expect(screen.getByText("Принтер не отвечает")).toBeDefined();
    expect(screen.getByText("Проверьте кабель и питание.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeDefined();
  });
});

describe("Modal", () => {
  it("renders nothing when closed and its content when open", () => {
    const { rerender } = render(
      <Modal open={false} title="Удалить задание?">
        Тело
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(
      <Modal open title="Удалить задание?">
        Тело
      </Modal>,
    );
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Удалить задание?")).toBeDefined();
    expect(screen.getByText("Тело")).toBeDefined();
  });

  it("calls onClose on Escape and on overlay click, but not on inner clicks", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <Modal open title="Удалить задание?" onClose={onClose}>
        <button>Внутри</button>
      </Modal>,
    );

    await user.click(screen.getByRole("button", { name: "Внутри" }));
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    const overlay = container.querySelector(".mk-modal-overlay");
    expect(overlay).not.toBeNull();
    await user.click(overlay as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps focus inside the dialog and wraps Tab/Shift+Tab between the first and last focusable elements", async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Форма" footer={<button>Сохранить</button>}>
        <button>Первая</button>
        <button>Вторая</button>
      </Modal>,
    );

    const first = screen.getByRole("button", { name: "Первая" });
    const last = screen.getByRole("button", { name: "Сохранить" });

    // focus starts inside the dialog on open
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the trigger button when closed", () => {
    const { rerender } = render(
      <>
        <button data-testid="trigger">Открыть</button>
        <Modal open={false} title="Модаль" />
      </>,
    );

    const trigger = screen.getByTestId("trigger") as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    rerender(
      <>
        <button data-testid="trigger">Открыть</button>
        <Modal open title="Модаль" />
      </>,
    );
    expect(screen.getByRole("dialog")).toBeDefined();
    // focus moved into modal
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    rerender(
      <>
        <button data-testid="trigger">Открыть</button>
        <Modal open={false} title="Модаль" />
      </>,
    );
    // focus restored to trigger
    expect(document.activeElement).toBe(trigger);
  });

  it("defaults the × button's aria-label to 'Close' and honors a custom closeLabel", () => {
    const { rerender } = render(
      <Modal open title="Модаль" onClose={() => {}}>
        Тело
      </Modal>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();

    rerender(
      <Modal open title="Модаль" onClose={() => {}} closeLabel="Закрыть">
        Тело
      </Modal>,
    );
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeDefined();
  });
});

describe("Sidebar", () => {
  const items: SidebarItem[] = [
    { to: "/dashboard", labelKey: "Обзор" },
    { to: "/shifts", labelKey: "Смены", badge: 2 },
  ];

  it("renders each item via the injected renderLink, passing through label and badge content", () => {
    render(
      <Sidebar
        items={items}
        renderLink={(item, content) => (
          <a href={item.to} data-testid={`link-${item.to}`}>
            {content}
          </a>
        )}
      />,
    );

    expect(screen.getByText("маркиро")).toBeDefined();

    const dashboardLink = screen.getByTestId("link-/dashboard");
    expect(within(dashboardLink).getByText("Обзор")).toBeDefined();

    const shiftsLink = screen.getByTestId("link-/shifts");
    expect(within(shiftsLink).getByText("Смены")).toBeDefined();
    expect(within(shiftsLink).getByText("2")).toBeDefined();
    // no badge rendered for items without one
    expect(within(dashboardLink).queryByText("0")).toBeNull();
  });

  it("renders the footer slot", () => {
    render(
      <Sidebar
        items={items}
        renderLink={(item, content) => <a href={item.to}>{content}</a>}
        footer={<span>Елена Ким</span>}
      />,
    );

    expect(screen.getByText("Елена Ким")).toBeDefined();
  });

  it("defaults the nav landmark's aria-label to 'Main navigation' and honors a custom navLabel", () => {
    const { rerender } = render(
      <Sidebar items={items} renderLink={(item, content) => <a href={item.to}>{content}</a>} />,
    );
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeDefined();

    rerender(
      <Sidebar
        items={items}
        renderLink={(item, content) => <a href={item.to}>{content}</a>}
        navLabel="Основная навигация"
      />,
    );
    expect(screen.getByRole("navigation", { name: "Основная навигация" })).toBeDefined();
  });
});

describe("PageHeader", () => {
  it("renders the title as an h1 and actions alongside it", () => {
    render(<PageHeader title="Каталог" actions={<button>+ Продукт</button>} />);

    expect(screen.getByRole("heading", { level: 1, name: "Каталог" })).toBeDefined();
    expect(screen.getByRole("button", { name: "+ Продукт" })).toBeDefined();
  });
});

describe("EmptyState", () => {
  it("renders title, hint and action", () => {
    render(
      <EmptyState
        title="Заданий пока нет"
        hint="Создайте первое задание"
        action={<button>Создать</button>}
      ></EmptyState>,
    );

    expect(screen.getByText("Заданий пока нет")).toBeDefined();
    expect(screen.getByText("Создайте первое задание")).toBeDefined();
    expect(screen.getByRole("button", { name: "Создать" })).toBeDefined();
  });
});

describe("Spinner", () => {
  it("exposes role=status and a screen-reader label", () => {
    render(<Spinner label="Загрузка отчёта…" />);

    const status = screen.getByRole("status");
    // textContent also picks up the scoped <style> keyframes text node — assert
    // the visible label is present rather than an exact match.
    expect(status.textContent).toContain("Загрузка отчёта…");
  });
});

describe("toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders into a portal container appended to document.body with the tone's glyph", () => {
    act(() => {
      toast("ok", "Отчёт отправлен в Честный ЗНАК", 4000);
    });

    const status = screen.getByText("Отчёт отправлен в Честный ЗНАК").closest('[role="status"]');
    expect(status).not.toBeNull();
    expect(document.body.contains(status)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText("Отчёт отправлен в Честный ЗНАК")).toBeNull();
  });

  it("dismisses immediately when its close button is clicked", () => {
    act(() => {
      toast("error", "Принтер не отвечает", 4000);
    });

    const status = screen
      .getByText("Принтер не отвечает")
      .closest('[role="status"]') as HTMLElement;
    const closeButton = within(status).getByRole("button", { name: "Close" });

    act(() => {
      closeButton.click();
    });

    expect(screen.queryByText("Принтер не отвечает")).toBeNull();
  });

  it("uses the per-call dismissLabel for the dismiss button's aria-label", () => {
    act(() => {
      toast("ok", "С переводом", 4000, "Закрыть");
    });

    const status = screen.getByText("С переводом").closest('[role="status"]') as HTMLElement;
    expect(within(status).getByRole("button", { name: "Закрыть" })).toBeDefined();
  });

  it("clears the auto-dismiss timer when manually dismissed (clearTimeout called)", () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    act(() => {
      toast("ok", "Уведомление", 4000);
    });

    const status = screen.getByText("Уведомление").closest('[role="status"]') as HTMLElement;
    const closeButton = within(status).getByRole("button", { name: "Close" });

    // Dismiss manually — this must call clearTimeout on the pending timer
    act(() => {
      closeButton.click();
    });

    // Verify clearTimeout was called with a defined handle (the stored timer)
    expect(clearTimeoutSpy).toHaveBeenCalled();
    const calls = clearTimeoutSpy.mock.calls;
    expect(calls.some((call) => call[0] !== undefined)).toBe(true);
    clearTimeoutSpy.mockRestore();

    // Verify DOM reflects immediate dismissal
    expect(screen.queryByText("Уведомление")).toBeNull();

    // Advance time past auto-dismiss duration — no toast should reappear
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText("Уведомление")).toBeNull();
  });

  it("does not drop the first toast when called before viewport subscription exists (cold path)", async () => {
    // Use real timers for this test so React rendering isn't blocked by fake timer state.
    vi.useRealTimers();

    // Reset to get a fresh Toast module instance (no container, no listeners).
    // This tests the race condition where toast() is called before the viewport
    // has had a chance to subscribe to the store.
    vi.resetModules();
    const { toast: freshToast } = await import("../src/components/Toast.js");

    // Call toast bare (no act()) before any React render has subscribed.
    // This simulates the real-world case where toast() might be called in a
    // click handler or other synchronous context before React effects run.
    freshToast("ok", "cold-path-race-xyz-unique");

    // Wait for the toast to actually appear in the DOM. This forces the viewport
    // to mount and subscribe, which re-checks the store snapshot.
    //
    // Why this matters: a naive useState store would capture the initial empty
    // array before any listeners registered. The toast is added to the array,
    // and listeners fire, but since the component rendered with an empty snapshot
    // before subscribing, the update is lost. useSyncExternalStore specifically
    // addresses this by re-checking the snapshot right after subscription — if
    // it changed, it forces a re-render, so the first toast is never dropped.
    await screen.findByText("cold-path-race-xyz-unique");

    // Confirm it rendered exactly once (not duplicated or dropped).
    expect(screen.queryAllByText("cold-path-race-xyz-unique").length).toBe(1);

    // Restore fake timers for remaining tests in this suite.
    vi.useFakeTimers();
  });
});
