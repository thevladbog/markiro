import { createElement } from "react";
import { vi } from "vitest";

vi.mock("@mdxeditor/editor", () => ({
  MDXEditor: ({ markdown, onChange }: { markdown: string; onChange: (value: string) => void }) =>
    createElement("textarea", {
      "aria-label": "Markdown editor",
      value: markdown,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }),
  headingsPlugin: () => ({}),
  listsPlugin: () => ({}),
  linkPlugin: () => ({}),
  tablePlugin: () => ({}),
  toolbarPlugin: () => ({}),
  UndoRedo: () => null,
  BoldItalicUnderlineToggles: () => null,
  ListsToggle: () => null,
  CreateLink: () => null,
  InsertTable: () => null,
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { value: () => false },
  setPointerCapture: { value: () => undefined },
  releasePointerCapture: { value: () => undefined },
  scrollIntoView: { configurable: true, writable: true, value: () => undefined },
});

Object.defineProperty(globalThis, "ResizeObserver", {
  value: ResizeObserverMock,
  writable: true,
});
