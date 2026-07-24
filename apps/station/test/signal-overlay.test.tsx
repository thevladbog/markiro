import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SignalOverlay } from "../src/ui/SignalOverlay.js";

describe("SignalOverlay", () => {
  it("renders a full-screen tone with its title and role=alert", () => {
    render(<SignalOverlay tone="error" title="ЧУЖОЙ ГТИН" />);
    const overlay = screen.getByRole("alert");
    expect(overlay.textContent).toContain("ЧУЖОЙ ГТИН");
    expect(overlay.getAttribute("data-tone")).toBe("error");
  });
});
