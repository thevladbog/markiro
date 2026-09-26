import { act } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { resetToasts } from "@markiro/ui";

// Tests inject a fake through `AuthClientProvider`. A component that falls
// back to the real Better Auth client subscribes to its session store, which
// fetches the session and tears down a second after its last subscriber leaves
// by removing a `window` listener. When the file ends inside that second, JSDOM
// is already gone and the run fails on "window is not defined" although every
// test passed. So a client may be created here -- the SaaS-admin app builds its
// own on import -- but using one fails at the misuse instead.
vi.mock("better-auth/react", () => ({
  createAuthClient: () =>
    new Proxy(
      {},
      {
        get(_target, key) {
          if (typeof key !== "string" || key === "then") return undefined;
          throw new Error(
            `A test reached the real Better Auth client (${key}); inject a fake with AuthClientProvider.`,
          );
        },
      },
    ),
}));

// Initializes the i18next singleton (RU resources, missing-key-throws in
// test mode) before any test renders a component that calls useTranslation.
import "../src/i18n/index.js";

// `toast()` renders into its own React root on `document.body`, which RTL's
// cleanup never unmounts, and arms a four-second dismiss timer. A timer still
// pending when a file ends can fire after Vitest has torn jsdom down, and its
// commit into that root throws ("window is not defined") -- an unhandled error
// that fails the run although every test passed. Reset toasts after each test.
afterEach(() => {
  act(() => resetToasts());
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { value: () => false },
  setPointerCapture: { value: () => undefined },
  releasePointerCapture: { value: () => undefined },
  scrollIntoView: { value: () => undefined },
});

Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverMock, writable: true });
