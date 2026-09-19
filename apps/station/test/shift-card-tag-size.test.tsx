import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ShiftCard } from "../src/ui/ShiftCard.js";

const base = {
  productName: "Сыр «Российский»",
  counterpartyLabel: "Контрагент",
  actionLabel: "Выбрать",
  active: false,
  disabled: false,
  onSelect: () => {},
} as const;

describe("теги карточки смены", () => {
  /**
   * Решение владельца 2026-09-20 (спека 2026-09-20-station-shift-card-redesign):
   * только на этой карточке теги офисные. Цеховые 34px правы для вердикта,
   * который читают с двух метров, а карточку смены читают с вытянутой руки при
   * выборе, и теги там — метаданные, а не сообщение. Размер задаётся пропом,
   * а не накладкой в station.css: накладку перебивает геометрия .mk-tag--*.
   */
  it("берёт офисный размер, а не цеховой", () => {
    const { container } = render(
      <ShiftCard {...base} number="СМ-101" status="active" statusLabel="Активна" />,
    );

    const status = container.querySelector(".shift-card__status");
    expect(status?.className).toContain("mk-tag--office");
    expect(status?.className).not.toContain("mk-tag--floor");
  });

  it("ставит фазу active, а не галочку завершения", () => {
    const { container } = render(
      <ShiftCard {...base} number="СМ-101" status="active" statusLabel="Активна" />,
    );

    expect(container.querySelector(".shift-card__status .mk-tag__glyph")?.textContent).toBe("▸");
    expect(screen.getByText("Активна")).toBeDefined();
  });

  /**
   * `closing` — отдельная фаза: смена ещё не закрыта, закрытие идёт. Раньше
   * она попадала в ту же ветку, что и `planned`, и получала глиф ожидания.
   */
  it("отличает закрывающуюся смену от запланированной и от закрытой", () => {
    const planned = render(
      <ShiftCard {...base} number="СМ-100" status="planned" statusLabel="Запланирована" />,
    );
    expect(planned.container.querySelector(".shift-card__status .mk-tag__glyph")?.textContent).toBe(
      "◷",
    );

    const closing = render(
      <ShiftCard {...base} number="СМ-101" status="closing" statusLabel="Закрывается" />,
    );
    expect(closing.container.querySelector(".shift-card__status .mk-tag__glyph")?.textContent).toBe(
      "⟳",
    );

    const closed = render(
      <ShiftCard {...base} number="СМ-102" status="closed" statusLabel="Закрыта" />,
    );
    expect(closed.container.querySelector(".shift-card__status .mk-tag__glyph")?.textContent).toBe(
      "✓",
    );
  });

  it("рисует номер смены тегом категории без глифа", () => {
    const { container } = render(
      <ShiftCard {...base} number="СМ-101" status="active" statusLabel="Активна" />,
    );

    const number = container.querySelector(".shift-card__number");
    expect(number?.className).toContain("mk-badge");
    expect(number?.className).toContain("mk-tag--office");
    expect(number?.className).toContain("mk-tag--mono");
    expect(number?.querySelector(".mk-tag__glyph")).toBeNull();
  });
});
