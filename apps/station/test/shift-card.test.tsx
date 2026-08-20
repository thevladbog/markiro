import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { formatShiftPlannedDate } from "../src/lib/format-date.js";
import { ShiftCard } from "../src/ui/ShiftCard.js";

describe("ShiftCard", () => {
  it("keeps the full product name and action together beside the product photo", () => {
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
    const image = container.querySelector(".product-image");
    const details = container.querySelector(".shift-card__details");
    const product = container.querySelector(".shift-card__product");
    const action = screen.getByRole("button", { name: "Открыть" });

    expect(cardBody).not.toBeNull();
    expect(image?.parentElement).toBe(cardBody);
    expect(details?.parentElement).toBe(cardBody);
    expect(product?.parentElement).toBe(details);
    expect(product?.textContent).toBe(productName);
    expect(screen.getByText("AUG26-041").closest(".shift-card__details")).toBe(details);
    expect(action.classList.contains("shift-card__action")).toBe(true);
    expect(action.parentElement).toBe(details);
    expect(container.querySelector(".shift-card__date")?.textContent).toBe("21.08.2026");
    expect(container.querySelector(".shift-card__plan")?.textContent).toBe(
      "Валидация · план 10 000",
    );
    expect(container.querySelector(".shift-card__meta")?.children).toHaveLength(2);
  });

  it("formats a calendar date without exposing the API ISO representation", () => {
    expect(formatShiftPlannedDate("2026-08-21", "ru")).toBe("21.08.2026");
    expect(formatShiftPlannedDate("2026-08-21", "en")).toBe("08/21/2026");
    expect(formatShiftPlannedDate(null, "ru")).toBeNull();
  });
});
