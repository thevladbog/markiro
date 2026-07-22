import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ThemeProvider, useTheme } from "../src/theme.js";

function Probe() {
  const { theme, setTheme } = useTheme();

  return (
    <div>
      <div data-testid="theme">{theme}</div>
      <button onClick={() => setTheme("light")}>Light</button>
      <button onClick={() => setTheme("dark")}>Dark</button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = "";
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("sets data-theme on documentElement", () => {
    render(
      <ThemeProvider defaultTheme="dark">
        <Probe />
      </ThemeProvider>
    );

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("allows switching themes", async () => {
    const user = userEvent.setup();

    render(
      <ThemeProvider defaultTheme="dark">
        <Probe />
      </ThemeProvider>
    );

    expect(document.documentElement.dataset.theme).toBe("dark");

    await user.click(screen.getByText("Light"));
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.click(screen.getByText("Dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("persists theme to localStorage", async () => {
    const user = userEvent.setup();

    render(
      <ThemeProvider defaultTheme="dark">
        <Probe />
      </ThemeProvider>
    );

    await user.click(screen.getByText("Light"));
    expect(localStorage.getItem("markiro.theme")).toBe("light");

    await user.click(screen.getByText("Dark"));
    expect(localStorage.getItem("markiro.theme")).toBe("dark");
  });

  it("reads theme from localStorage on mount", () => {
    localStorage.setItem("markiro.theme", "light");

    const { unmount } = render(
      <ThemeProvider defaultTheme="dark">
        <Probe />
      </ThemeProvider>
    );

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByTestId("theme").textContent).toBe("light");

    unmount();
  });
});

describe("cn helper", async () => {
  it("filters out falsy values and joins strings", async () => {
    const { cn } = await import("../src/cn.js");

    expect(cn("a", false, "b", null, undefined, "c")).toBe("a b c");
  });
});
