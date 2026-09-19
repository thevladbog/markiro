import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { formatShiftPlannedDate } from "../src/lib/format-date.js";
import { ShiftCard } from "../src/ui/ShiftCard.js";

function dateParts(container: HTMLElement) {
  return [...container.querySelectorAll(".shift-card__date-part")].map((part) => part.textContent);
}

describe("ShiftCard", () => {
  it("keeps the print name and action together beside the product photo panel", () => {
    const productName =
      "Молоко ультрапастеризованное безлактозное обогащённое витаминами для детского питания 3,2%, 930 мл";

    const { container } = render(
      <ShiftCard
        number="AUG26-041"
        productName={productName}
        plannedDate="2026-08-21"
        locale="ru"
        plannedQty={10_000}
        mode="validation"
        status="planned"
        modeLabel="Валидация"
        statusLabel="Запланирована"
        plannedLabel="план"
        noPlanLabel="без плана"
        counterpartyName={null}
        counterpartyLabel="Для"
        actionLabel="Открыть"
        active={false}
        disabled={false}
        onSelect={vi.fn()}
        productId="product-1"
        image={null}
      />,
    );

    const cardBody = container.querySelector(".shift-card__body");
    const photo = container.querySelector(".shift-card__photo");
    const details = container.querySelector(".shift-card__details");
    const product = container.querySelector(".shift-card__product");
    const action = screen.getByRole("button", { name: "Открыть" });

    expect(cardBody).not.toBeNull();
    // The photo panel and the details are the card's two columns; the photo —
    // or its monogram stand-in — lives inside the panel, not beside it.
    expect(photo?.parentElement).toBe(cardBody);
    expect(details?.parentElement).toBe(cardBody);
    expect(container.querySelector(".shift-card__photo-monogram")?.parentElement).toBe(photo);
    expect(product?.parentElement).toBe(details);
    expect(product?.textContent).toBe(productName);
    // No print name was supplied, so the headline stands alone.
    expect(container.querySelector(".shift-card__product-full")).toBeNull();
    expect(screen.getByText("AUG26-041").closest(".shift-card__details")).toBe(details);
    expect(action.classList.contains("shift-card__action")).toBe(true);
    expect(action.parentElement).toBe(details);
    expect(container.querySelector(".shift-card__dates")?.textContent).toBe("21.08.2026");
    expect(container.querySelector(".shift-card__mode-badge")?.textContent).toBe("Валидация");
    // The thousands separator is the locale's own non-breaking space.
    expect(container.querySelector(".shift-card__plan")?.textContent).toBe("план 10 000");
  });

  it("leads with the print name, keeps the full name beneath it and tints the photo panel by product hue", () => {
    const { container } = render(
      <ShiftCard
        number="SEP26-008/S"
        productName="Сидр Дикий Крест 0,45"
        productFullName="Сидр полусухой газированный «ДИКИЙ КРЕСТ» 0,45 л"
        gtin="04600682000017"
        plannedDate="2026-09-19"
        plannedDateLabel="Смена"
        productionDate="2026-09-20"
        productionDateLabel="Производство"
        locale="ru"
        mode="aggregation"
        palletsEnabled
        status="active"
        modeLabel="Агрегация"
        palletsLabel="Паллеты"
        statusLabel="Активна"
        plannedLabel="план"
        noPlanLabel="без плана"
        counterpartyName={null}
        counterpartyLabel="для:"
        actionLabel="Присоединиться"
        active
        disabled={false}
        onSelect={vi.fn()}
        productId="product-1"
        image={null}
      />,
    );
    expect(container.querySelector(".shift-card__product")?.textContent).toBe(
      "Сидр Дикий Крест 0,45",
    );
    expect(container.querySelector(".shift-card__product-full")?.textContent).toBe(
      "Сидр полусухой газированный «ДИКИЙ КРЕСТ» 0,45 л",
    );
    const photo = container.querySelector<HTMLElement>(".shift-card__photo");
    expect(photo?.getAttribute("data-accent")).toBe("true");
    expect(photo?.style.getPropertyValue("--product-hue")).not.toBe("");
    // No photo: the monogram stands in on the same gradient, never a light box.
    expect(container.querySelector(".shift-card__photo-monogram")?.textContent).toBe("С");
    expect(
      container.querySelector(".shift-card__number")?.classList.contains("mk-tag--office"),
    ).toBe(true);
    expect(
      container.querySelector(".shift-card__status")?.classList.contains("mk-tag--office"),
    ).toBe(true);
    expect(container.querySelector(".shift-card__status")?.textContent).toBe("▸Активна");
    expect(
      [...container.querySelectorAll(".shift-card__date-part")].map((n) => n.textContent),
    ).toEqual(["Смена: 19.09.2026", "Производство: 20.09.2026"]);
    expect(container.querySelector(".shift-card__mode-badge")?.textContent).toBe("Агрегация");
    expect(
      container.querySelector(".shift-card__mode-badge")?.classList.contains("mk-tag--teal"),
    ).toBe(true);
    expect(container.querySelector(".shift-card__pallets")?.textContent).toBe("Паллеты");
    expect(container.querySelector(".shift-card__plan")?.textContent).toBe("без плана");
  });

  it("hides the full name when it equals the headline and paints the neutral gradient without a hue", () => {
    const { container } = render(
      <ShiftCard
        productName="Пиво"
        productFullName="Пиво"
        mode="validation"
        modeLabel="Проверка"
        counterpartyName={null}
        counterpartyLabel="для:"
        actionLabel="Открыть"
        active={false}
        disabled={false}
        onSelect={vi.fn()}
        productId="p"
        image={null}
      />,
    );
    expect(container.querySelector(".shift-card__product-full")).toBeNull();
    expect(container.querySelector(".shift-card__photo")?.getAttribute("data-accent")).toBeNull();
    expect(
      container.querySelector(".shift-card__mode-badge")?.classList.contains("mk-tag--violet"),
    ).toBe(true);
    expect(container.querySelector(".shift-card__pallets")).toBeNull();
  });

  it("shows the labeled production date beside the planned date and hides it when absent", () => {
    const { container, rerender } = render(
      <ShiftCard
        productName="Пиво светлое"
        plannedDate="2026-08-21"
        plannedDateLabel="Смена"
        productionDate="2026-08-15"
        productionDateLabel="Производство"
        locale="ru"
        counterpartyName={null}
        counterpartyLabel="Для"
        actionLabel="Открыть"
        active={false}
        disabled={false}
        onSelect={vi.fn()}
        productId="product-1"
        image={null}
      />,
    );

    expect(container.querySelector(".shift-card__dates")).not.toBeNull();
    // Separate parts so the production date wraps whole on narrow cards
    // instead of ellipsizing the middle of one combined line.
    expect(dateParts(container)).toEqual(["Смена: 21.08.2026", "Производство: 15.08.2026"]);

    rerender(
      <ShiftCard
        productName="Пиво светлое"
        plannedDate="2026-08-21"
        productionDate={null}
        productionDateLabel="Производство"
        locale="ru"
        counterpartyName={null}
        counterpartyLabel="Для"
        actionLabel="Открыть"
        active={false}
        disabled={false}
        onSelect={vi.fn()}
        productId="product-1"
        image={null}
      />,
    );
    expect(container.querySelector(".shift-card__dates")?.textContent).toBe("21.08.2026");
    expect(container.textContent).not.toContain("Производство");
  });

  /** Owner request 2026-09-19: an aggregation shift that builds pallets must say so on the card. */
  it("names pallets in a badge beside the mode only when the shift builds them", () => {
    const props = {
      productName: "Квас хлебный",
      plannedDate: "2026-08-21",
      locale: "ru",
      plannedQty: 2_400,
      mode: "aggregation" as const,
      status: "planned" as const,
      modeLabel: "Агрегация",
      palletsLabel: "Паллеты",
      plannedLabel: "план",
      noPlanLabel: "без плана",
      counterpartyName: null,
      counterpartyLabel: "Для",
      actionLabel: "Открыть",
      active: false,
      disabled: false,
      onSelect: vi.fn(),
      productId: "product-1",
      image: null,
    };
    const { container, rerender } = render(<ShiftCard {...props} palletsEnabled />);
    // The mode row is facts, not prose: two tags plus the plan text, never the
    // one dot-joined line that ellipsized to «без…» on the line terminal.
    expect(container.querySelector(".shift-card__mode-badge")?.textContent).toBe("Агрегация");
    expect(container.querySelector(".shift-card__pallets")?.textContent).toBe("Паллеты");
    // Non-breaking thousands separator, as the ru formatter emits it.
    expect(container.querySelector(".shift-card__plan")?.textContent).toBe("план 2 400");
    // The plan text never shares a badge with the mode.
    expect(container.querySelector(".shift-card__plan")?.classList.contains("mk-tag")).toBe(false);

    rerender(<ShiftCard {...props} palletsEnabled={false} plannedQty={null} />);
    expect(container.querySelector(".shift-card__mode-badge")?.textContent).toBe("Агрегация");
    expect(container.querySelector(".shift-card__pallets")).toBeNull();
    expect(container.querySelector(".shift-card__plan")?.textContent).toBe("без плана");
  });

  it("formats a calendar date without exposing the API ISO representation", () => {
    expect(formatShiftPlannedDate("2026-08-21", "ru")).toBe("21.08.2026");
    expect(formatShiftPlannedDate("2026-08-21", "en")).toBe("08/21/2026");
    expect(formatShiftPlannedDate(null, "ru")).toBeNull();
  });
});
