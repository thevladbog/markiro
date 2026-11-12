import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { SetWorkScreen } from "../src/floor/work/SetWorkScreen.js";
import { enteredShift, km, OTHER_GTIN, VALIDATION_ENTERED } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { renderWork } from "./support/work-screen.js";

it("shows the last accepted product, pauses the shift, and returns to the list when closed", async () => {
  const { db, executor } = openLocalDb();
  const setItems = [{ gtin14: OTHER_GTIN, productName: "Крем для рук", quantity: 1 }];
  const shift = await enteredShift(executor, {
    ...VALIDATION_ENTERED,
    setItems,
    plannedQty: 1,
    snapshot: {
      ...VALIDATION_ENTERED.snapshot,
      product: { ...VALIDATION_ENTERED.snapshot.product, setItems },
    },
  });
  db.prepare(
    "INSERT INTO ref_products (id, gtin14, name, status, archived, rev) VALUES (?, ?, ?, 'active', 0, 1)",
  ).run("cream", OTHER_GTIN, "Крем для рук");
  db.prepare(
    "INSERT INTO ref_product_photos (product_id, checksum, width, height, data_base64, media_type) " +
      "VALUES (?, ?, 1, 1, ?, 'image/png')",
  ).run("cream", "a".repeat(64), "iVBORw0KGgo=");
  const onLeave = vi.fn();
  const work = renderWork({ local: executor, shift }, { screen: SetWorkScreen, onLeave });
  await work.scanner.listening();
  const scanSet = () => screen.queryByRole("region", { name: "Сканируйте марку набора" });
  expect(scanSet()).toBeNull();
  await work.scan(km("CREAM01", { gtin: OTHER_GTIN }));
  const prompt = within(screen.getByRole("region", { name: "Сканируйте марку набора" }));
  expect(prompt.getByText("Наведите сканер на Data Matrix внешней упаковки.")).toBeTruthy();
  expect(prompt.getByText("1 / 1")).toBeTruthy();
  expect(prompt.getByRole("heading", { name: "Сканируйте марку набора" })).toBeTruthy();
  const recipe = within(screen.getByRole("region", { name: "Состав набора" }));
  const row = recipe.getByRole("listitem");
  expect(row.getAttribute("data-last-scan")).toBe("true");
  expect(row.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  expect(within(row).getByText(OTHER_GTIN)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Крем для рук");
  await work.press("На паузу");
  expect(onLeave).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT kind FROM outbox").all()).toEqual([]);
  await work.scan(km("SET0001"));
  expect(scanSet()).toBeNull();
  await work.press("Закрыть смену");
  await screen.findByRole("region", { name: `Закрытие смены ${shift.copy.number}` });
  await work.press("Подтвердить закрытие");
  expect(onLeave).toHaveBeenCalledTimes(2);
  expect(db.prepare("SELECT kind FROM outbox ORDER BY seq").all()).toEqual([
    { kind: "set_assembled" },
    { kind: "shift_closed" },
  ]);
});
