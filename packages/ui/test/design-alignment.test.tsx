import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert, Button, Modal, SidePanel } from "../src/components/index.js";

afterEach(cleanup);

describe("shared design controls", () => {
  it("uses a scalable decorative symbol for a multiline alert", () => {
    const { container } = render(
      <Alert tone="error" title="Ошибка чтения">
        Проверьте передачу разделителей GS и повторите сканирование.
      </Alert>,
    );
    const icon = container.querySelector(".mk-alert__icon svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("Проверьте передачу");
  });

  it("preserves the direct-child marks styled by floor controls", () => {
    const { container } = render(
      <Button size="floor">
        <span className="floor-choice__mark">✓</span>Выбор
      </Button>,
    );
    expect(container.querySelector("button > .floor-choice__mark")).not.toBeNull();
  });

  it.each(["modal", "panel"])("keeps %s close accessible and draws a 24 px vector", (kind) => {
    const close = vi.fn();
    render(
      kind === "modal" ? (
        <Modal open title="Настройки" closeLabel="Закрыть настройки" onClose={close}>
          Параметры
        </Modal>
      ) : (
        <SidePanel open title="Настройки" closeLabel="Закрыть настройки" onClose={close}>
          Параметры
        </SidePanel>
      ),
    );
    const button = screen.getByRole("button", { name: "Закрыть настройки" });
    expect(button.querySelector("svg")?.getAttribute("width")).toBe("24");
    fireEvent.click(button);
    expect(close).toHaveBeenCalledOnce();
  });
});
