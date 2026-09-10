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

/**
 * Evaluating the entrypoint says nothing about its bootstrap being done: the
 * module body only *starts* it, and the branch under test then dynamically
 * imports a module graph (the whole gallery, or `App`) that Vite still has to
 * transform. Awaiting the promise the entrypoint exposes ties these tests to
 * that work finishing.
 *
 * Waiting on the rendered output alone did not, and that was the flake: on an
 * idle machine the gallery landed 679-970ms after the entrypoint import
 * resolved, against `waitFor`'s 1000ms default (which `testTimeout` does not
 * govern) -- 3-32% headroom, which a loaded runner loses. Awaiting `ready`
 * leaves only React's own commit, measured at 37-51ms over ten runs, so the
 * same budget now carries ~20x margin instead of ~1.03x.
 */
async function bootstrapEntrypoint(): Promise<void> {
  const { ready } = await import("../src/main.js");
  // Pinned, not incidental: an entrypoint that goes back to starting its
  // bootstrap without exposing it would make every await below a no-op and
  // quietly restore the race.
  expect(ready).toBeInstanceOf(Promise);
  await ready;
}

describe("development screen gallery bootstrap", () => {
  it("imports the real entrypoint without evaluating the App dependency graph", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "/?gallery=1&state=pairing-waiting&locale=ru");

    await bootstrapEntrypoint();

    // The tree is handed to React inside `ready`, but the commit is not
    // synchronous, so the element is still absent at this point.
    await waitFor(() => {
      expect(screen.getByTestId("station-screen-gallery")).toBeDefined();
    });
    expect(appModule.evaluations).toBe(0);
  });

  it("evaluates and renders App outside gallery mode", async () => {
    appModule.rejectEvaluation = false;
    document.body.innerHTML = '<div id="root"></div>';

    await bootstrapEntrypoint();

    await waitFor(() => {
      expect(screen.getByText("APPLICATION_RENDERED")).toBeDefined();
    });
    expect(appModule.evaluations).toBe(1);
  });
});
