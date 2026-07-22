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
    const closeButton = within(status).getByRole("button", { name: "Закрыть" });

    act(() => {
      closeButton.click();
    });

    expect(screen.queryByText("Принтер не отвечает")).toBeNull();
  });
});
