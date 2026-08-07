import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const appModule = vi.hoisted(() => ({
  evaluations: 0,
  rejectEvaluation: true,
}));

vi.mock("../src/App.js", () => {
  appModule.evaluations += 1;
  if (appModule.rejectEvaluation) {
    throw new Error("App dependency graph evaluated in gallery mode");
  }
  return { App: () => "APPLICATION_RENDERED" };
});

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  appModule.evaluations = 0;
  appModule.rejectEvaluation = true;
  vi.resetModules();
});

describe("development screen gallery bootstrap", () => {
  it("imports the real entrypoint without evaluating the App dependency graph", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "/?gallery=1&state=pairing-waiting&locale=ru");

    await expect(import("../src/main.js")).resolves.toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId("station-screen-gallery")).toBeDefined();
    });
    expect(appModule.evaluations).toBe(0);
  });

  it("evaluates and renders App outside gallery mode", async () => {
    appModule.rejectEvaluation = false;
    document.body.innerHTML = '<div id="root"></div>';

    await expect(import("../src/main.js")).resolves.toBeDefined();

    await waitFor(() => {
      expect(screen.getByText("APPLICATION_RENDERED")).toBeDefined();
    });
    expect(appModule.evaluations).toBe(1);
  });
});
