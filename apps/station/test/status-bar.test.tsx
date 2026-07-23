import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../src/i18n/index.js";
import { StatusBar } from "../src/ui/StatusBar.js";

beforeAll(async () => { await i18n.changeLanguage("en"); });

describe("StatusBar", () => {
  it("shows the online state", () => {
    render(<StatusBar online />);
    expect(screen.getByText("Online")).toBeDefined();
  });
  it("shows the offline state and 'not configured' hardware placeholders", () => {
    render(<StatusBar online={false} />);
    expect(screen.getByText("Offline")).toBeDefined();
    expect(screen.getAllByText("Not configured").length).toBeGreaterThanOrEqual(3);
  });
});
