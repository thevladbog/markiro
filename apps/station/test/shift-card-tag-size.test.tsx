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

  /**
   * Номер смены — её адрес, а не свойство. Тегом он добавлял в одну строку
   * четвёртую коробку рядом со статусом, режимом и признаком паллет, и строка
   * читалась как набор кнопок. Осталась одна коробка — статус.
   */
  it("рисует номер смены текстом, а не тегом", () => {
    const { container } = render(
      <ShiftCard {...base} number="СМ-101" status="active" statusLabel="Активна" />,
    );

    const number = container.querySelector(".shift-card__number");
    expect(number?.textContent).toBe("СМ-101");
    expect(number?.className).toBe("shift-card__number");
    expect(container.querySelectorAll(".shift-card__heading .mk-tag")).toHaveLength(1);
  });

  /**
   * Тона режимов нейтральные ОБА: правило словаря запрещает асимметрию, из-за
   * которой один режим читался успехом, а другой архивом, — два одинаково
   * тихих тега её не создают, а цвет на карточке остаётся за статусом.
   */
  it("не красит режим и признак паллет", () => {
    const { container } = render(
      <ShiftCard
        {...base}
        number="СМ-101"
        status="active"
        statusLabel="Активна"
        mode="aggregation"
        modeLabel="Агрегация"
        palletsEnabled
        palletsLabel="Паллеты"
      />,
    );

    for (const selector of [".shift-card__mode-badge", ".shift-card__pallets"]) {
      const tag = container.querySelector(selector);
      expect(tag?.className).toContain("mk-tag--neutral");
      expect(tag?.className).toContain("mk-tag--office");
    }
  });
});
