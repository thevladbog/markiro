// Initializes the i18next singleton (RU resources, missing-key-throws in
// test mode) before any test renders a component that calls useTranslation.
import "../src/i18n/index.js";

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
