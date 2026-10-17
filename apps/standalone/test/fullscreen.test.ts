import { describe, expect, it, vi } from "vitest";

import { createFullscreenController } from "../src/app/fullscreen.js";

/** A document that answers the Fullscreen API like a webview: one element, `fullscreenchange`. */
function fakeDocument(options: { enterFails?: boolean; exitFails?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const doc = {
    fullscreenElement: null as object | null,
    fullscreenEnabled: true,
    documentElement: {
      requestFullscreen: vi.fn(async () => {
        if (options.enterFails === true) throw new Error("denied");
        doc.fullscreenElement = doc.documentElement;
        listeners.forEach((listener) => listener());
      }),
    },
    exitFullscreen: vi.fn(async () => {
      if (options.exitFails === true) throw new Error("denied");
      doc.fullscreenElement = null;
      listeners.forEach((listener) => listener());
    }),
    addEventListener: vi.fn((_type: string, listener: () => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => {
      listeners.delete(listener);
    }),
    /** What the user does with Esc or F11: the webview leaves full screen by itself. */
    pressEscape: () => {
      doc.fullscreenElement = null;
      listeners.forEach((listener) => listener());
    },
  };
  return doc;
}

describe("the plain full-screen mode of a PC that is never locked", () => {
  it("starts windowed, goes full screen and back, and follows an Esc the page never saw", async () => {
    const doc = fakeDocument();
    const controller = createFullscreenController(doc as unknown as Document);
    expect(controller.getSnapshot()).toEqual({ mode: "windowed", pending: false, error: null });
    const seen = vi.fn();
    const stop = controller.subscribe(seen);
    await controller.enter();
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().mode).toBe("locked");
    doc.pressEscape();
    expect(controller.getSnapshot().mode).toBe("windowed");
    await controller.enter();
    await controller.exit();
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().mode).toBe("windowed");
    expect(seen).toHaveBeenCalled();
    stop();
    expect(doc.removeEventListener).toHaveBeenCalled();
  });

  it("names the direction of a refusal, never its text, and clears it", async () => {
    const entering = createFullscreenController(
      fakeDocument({ enterFails: true }) as unknown as Document,
    );
    await entering.enter();
    expect(entering.getSnapshot()).toEqual({ mode: "windowed", pending: false, error: "enter" });
    entering.clearError();
    expect(entering.getSnapshot().error).toBeNull();

    const leaving = fakeDocument({ exitFails: true });
    const controller = createFullscreenController(leaving as unknown as Document);
    await controller.enter();
    await controller.exit();
    expect(controller.getSnapshot()).toEqual({ mode: "locked", pending: false, error: "exit" });
  });

  it("is not offered where the webview has no Fullscreen API", () => {
    const doc = fakeDocument();
    doc.fullscreenEnabled = false;
    expect(createFullscreenController(doc as unknown as Document).enabled).toBe(false);
  });
});
