import { act } from "@testing-library/react";
import { afterEach } from "vitest";

import { resetToasts } from "@markiro/ui";

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
