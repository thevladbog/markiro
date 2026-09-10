import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import "../src/i18n/index.js";
import { ReportTimezoneSelect } from "../src/pages/reports/ReportTimezoneSelect.js";

const supportedValues = vi.hoisted(() =>
  vi.spyOn(Intl, "supportedValuesOf").mockReturnValue(["Europe/Moscow", "UTC", "Asia/Tokyo"]),
);
afterAll(() => supportedValues.mockRestore());
afterEach(cleanup);

it("offers UTC once and retains named zone order when the runtime includes UTC", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ThemeProvider defaultTheme="light">
      <ReportTimezoneSelect value="Europe/Moscow" onValueChange={onValueChange} />
    </ThemeProvider>,
  );
  await user.click(screen.getByRole("combobox", { name: /часовой пояс/i }));
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "UTC",
    "Москва — Europe/Moscow",
    "Tokyo — Asia/Tokyo",
  ]);
  await user.click(screen.getByRole("option", { name: "UTC" }));
  expect(onValueChange).toHaveBeenCalledWith("UTC");
});
