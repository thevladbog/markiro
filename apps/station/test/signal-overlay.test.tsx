import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../src/i18n/index.js";
import { SignalOverlay } from "../src/ui/SignalOverlay.js";

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
});
