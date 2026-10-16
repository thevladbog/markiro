// Initializes the i18next singleton (RU resources, missing key throws in test
// mode) before any test renders a component that calls useTranslation.
import "../src/i18n/index.js";

import { configure } from "@testing-library/react";

// A findBy*/waitFor waits up to the test's own timeout, not Testing Library's 1 s: on a loaded
// machine the first paint of a heavy dialog takes longer, and `--testTimeout` does not move the
// 1 s. The wait is no assertion about speed, and no test here asserts that something does NOT
// appear within one (no `.rejects` on a findBy/waitFor, no waitForElementToBeRemoved), so only
// the time to a genuine failure grows. This is not a weakened test: the gate stays the timeout of
// the test itself. The file is also loaded for suites that opt into `@vitest-environment node`.
configure({ asyncUtilTimeout: 15_000 });

// @markiro/ui's RadioGroup and Checkbox (Radix) render a hidden native input
// inside a <form> so the control still participates in native form
// submission; that hidden input sizes itself with `useSize`, which reads
// `ResizeObserver`. jsdom has no such global, so any office form using these
// two controls (src/office/users) crashes on mount with "ResizeObserver is
// not defined" — not only on click. Mirrors apps/admin/test/setup.ts, which
// hit the same gap first. This file is also loaded for suites that opt into
// `@vitest-environment node` (e.g. phc-contract.test.ts), where `HTMLElement`
// does not exist, so the DOM patch is skipped there.
if (typeof HTMLElement !== "undefined") {
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

  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverMock,
    writable: true,
  });

  // jsdom has no canvas: `getContext` logs «Not implemented» and returns null.
  // Here it returns null quietly; a test that looks at a drawing passes a
  // recording context of its own (`LabelRendering`).
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: () => null,
  });
}

// A table's page size is kept in the webview's storage between visits (`office/paging`); a test
// must not inherit the size a test before it chose.
if (typeof localStorage !== "undefined") {
  afterEach(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("markiro.office.pageSize.")) localStorage.removeItem(key);
    }
  });
}
