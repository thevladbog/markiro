import { render, screen } from "@testing-library/react";
import { SignalOverlay } from "@markiro/ui";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../src/i18n/index.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("SignalOverlay", () => {
  it("announces the verdict to assistive tech", () => {
    render(<SignalOverlay tone="ok" title="OK" />);
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("carries the tone as data for styling and tests", () => {
    render(<SignalOverlay tone="error" title="WRONG CODE" />);
    expect(screen.getByRole("alert").dataset.tone).toBe("error");
  });

  it("renders the detail line when given one", () => {
    render(<SignalOverlay tone="duplicate" title="DUPLICATE" detail="First seen 10:00" />);
    expect(screen.getByText("First seen 10:00")).toBeDefined();
  });

  it("omits the detail line when absent", () => {
    render(<SignalOverlay tone="ok" title="OK" />);
    expect(screen.queryByText(/First seen/)).toBeNull();
  });

  it.each(["ok", "error", "duplicate"] as const)(
    "uses a distinct non-color icon for the %s verdict while keeping the icon decorative",
    (tone) => {
      const { container } = render(<SignalOverlay tone={tone} title={`${tone} verdict`} />);
      const icon = container.querySelector("svg");

      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.querySelectorAll("path, rect").length).toBeGreaterThan(0);
      expect(screen.getByRole("alert").textContent).toContain(`${tone} verdict`);
    },
  );
});
