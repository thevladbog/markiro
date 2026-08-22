import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
// @ts-expect-error The UI test tsconfig omits Node globals; Vitest still runs in Node.
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import componentStyles from "virtual:ui-component-styles";

import {
  DataTabs,
  DefinitionGrid,
  MetricStrip,
  OperationalRail,
  SectionHeader,
} from "../src/components/index.js";

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = `${readFileSync("src/tokens.css", "utf8") as string}\n${componentStyles}`;
  document.head.append(style);
});

afterEach(() => cleanup());

describe("OperationalRail", () => {
  it("renders grouped navigation with visible active-page semantics and a caller-owned brand", () => {
    render(
      <OperationalRail
        navLabel="Основная навигация"
        brand={<span>Маркиро Platform</span>}
        groups={[
          {
            id: "operations",
            label: "Операции",
            items: [
              { id: "overview", label: "Обзор", to: "/", active: true },
              { id: "tenants", label: "Тенанты", to: "/tenants" },
            ],
          },
          {
            id: "commerce",
            label: "Коммерция",
            items: [{ id: "catalog", label: "Каталог", to: "/catalog", badge: 3 }],
          },
        ]}
        footer={<button>Профиль</button>}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "Основная навигация" });
    expect(navigation).toBeDefined();
    expect(screen.getByText("Маркиро Platform")).toBeDefined();
    expect(screen.getByRole("link", { name: "Обзор" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Каталог/ }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: "Профиль" })).toBeDefined();
    expect(navigation.closest("aside")?.classList).toContain("mk-motion-safe");
  });

  it("lets the router render links without losing the operational classes", () => {
    const renderLink = vi.fn((item, content, linkProps) => (
      <a href={item.to} {...linkProps}>
        {content}
      </a>
    ));
    render(
      <OperationalRail
        navLabel="Main"
        brand="Markiro"
        groups={[
          {
            id: "platform",
            label: "Platform",
            items: [{ id: "monitoring", label: "Monitoring", to: "/monitoring", active: true }],
          },
        ]}
        renderLink={renderLink}
      />,
    );

    const link = screen.getByRole("link", { name: "Monitoring" });
    expect(link.classList).toContain("mk-operational-rail__link--active");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(renderLink).toHaveBeenCalledOnce();
  });
});

describe("DataTabs", () => {
  function Harness() {
    const [active, setActive] = useState<"overview" | "legal" | "usage">("overview");
    return (
      <DataTabs
        label="Разделы тенанта"
        activeId={active}
        onChange={setActive}
        items={[
          { id: "overview", label: "Обзор", panelId: "panel-overview" },
          { id: "legal", label: "Юридические данные", panelId: "panel-legal" },
          { id: "usage", label: "Использование", panelId: "panel-usage", disabled: true },
        ]}
      />
    );
  }

  it("uses roving focus and changes the selected tab with arrow keys", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const overview = screen.getByRole("tab", { name: "Обзор" });
    const legal = screen.getByRole("tab", { name: "Юридические данные" });
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.getAttribute("aria-controls")).toBe("panel-overview");

    overview.focus();
    await user.keyboard("{ArrowRight}");

    expect(document.activeElement).toBe(legal);
    expect(legal.getAttribute("aria-selected")).toBe("true");
    expect(legal.tabIndex).toBe(0);
  });

  it("supports Home and End while skipping disabled tabs", () => {
    render(<Harness />);
    const overview = screen.getByRole("tab", { name: "Обзор" });
    const legal = screen.getByRole("tab", { name: "Юридические данные" });

    fireEvent.keyDown(overview, { key: "End" });
    expect(document.activeElement).toBe(legal);
    fireEvent.keyDown(legal, { key: "Home" });
    expect(document.activeElement).toBe(overview);
  });
});

describe("operational display primitives", () => {
  it("exposes metric labels and values as a bounded definition list", () => {
    render(
      <MetricStrip
        label="Ключевые показатели"
        items={[
          {
            id: "tenants",
            label: "Активные тенанты",
            value: "128",
            hint: "Подтверждено контрактом",
            tone: "positive",
          },
          { id: "overdue", label: "Просроченные счета", value: "4", tone: "critical" },
        ]}
      />,
    );

    expect(screen.getByRole("group", { name: "Ключевые показатели" })).toBeDefined();
    expect(screen.getByText("Активные тенанты").tagName).toBe("DT");
    expect(screen.getByText("128").tagName).toBe("DD");
    expect(screen.getByText("Подтверждено контрактом").closest("dd")).toBe(screen.getByText("128"));
    expect(screen.getByText("Просроченные счета")).toBeDefined();
  });

  it("renders semantic definition pairs without wrapping each pair in a card", () => {
    render(
      <DefinitionGrid
        items={[
          { id: "inn", term: "ИНН", description: "7700000000", mono: true },
          { id: "status", term: "Статус", description: "Подтверждено" },
        ]}
      />,
    );

    expect(screen.getByText("ИНН").tagName).toBe("DT");
    expect(screen.getByText("7700000000").tagName).toBe("DD");
    expect(screen.getByText("7700000000").classList).toContain("font-mono");
  });

  it("keeps one semantic heading and a named action region", () => {
    render(
      <SectionHeader
        eyebrow="КОНТРОЛЬ · 01"
        title="Операционный обзор"
        description="Решения, которые требуют внимания сегодня."
        actionsLabel="Действия обзора"
        actions={<button>Обновить</button>}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Операционный обзор" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Действия обзора" })).toBeDefined();
  });

  it("publishes the operational token aliases without changing legacy token values", () => {
    const root = getComputedStyle(document.documentElement);
    expect(root.getPropertyValue("--mk-surface-paper").trim()).toBe("var(--surface-page)");
    expect(root.getPropertyValue("--mk-rail-bg").trim()).toBe("#171916");
    expect(root.getPropertyValue("--mk-border-operational").trim()).toBe("var(--line)");
    expect(root.getPropertyValue("--mk-accent-operational").trim()).toBe("var(--accent)");
  });
});
