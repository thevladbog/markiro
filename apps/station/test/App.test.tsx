import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";

describe("App", () => {
  it("renders the RU app title by default", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Маркиро — Станция" })).toBeDefined();
  });
});
