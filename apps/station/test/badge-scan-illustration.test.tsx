import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BadgeScanIllustration } from "../src/ui/BadgeScanIllustration.js";

describe("BadgeScanIllustration", () => {
  it("renders an offline decorative badge, barcode, scanner, and scan beam", () => {
    const { container } = render(<BadgeScanIllustration />);

    const illustration = screen.getByTestId("badge-scan-illustration");
    expect(illustration.tagName).toBe("svg");
    expect(illustration.getAttribute("aria-hidden")).toBe("true");
    expect(illustration.getAttribute("focusable")).toBe("false");
    expect(container.querySelector(".badge-scan-illustration__badge")).not.toBeNull();
    expect(container.querySelector(".badge-scan-illustration__barcode")).not.toBeNull();
    expect(container.querySelector(".badge-scan-illustration__scanner")).not.toBeNull();
    expect(container.querySelector(".badge-scan-illustration__beam")).not.toBeNull();
    expect(container.querySelector("image")).toBeNull();
    expect(container.innerHTML).not.toMatch(/https?:|data:/i);
  });
});
