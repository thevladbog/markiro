import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ListCard } from "../src/office/list/ListCard.js";
const originalObserver = globalThis.ResizeObserver;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.ResizeObserver = originalObserver;
});

it("reserves filters, bounded rows and footer through resize and disconnects its observer", () => {
  let resize: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  class Observer {
    constructor(callback: ResizeObserverCallback) {
      resize = callback;
    }
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = disconnect;
  }
  globalThis.ResizeObserver = Observer;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = Number(this.dataset.height ?? "0");
    return {
      height,
      width: 800,
      x: 0,
      y: 0,
      top: 0,
      bottom: height,
      left: 0,
      right: 800,
      toJSON: () => ({}),
    };
  });
  const view = render(
    <ListCard>
      <div className="office-list-filters" data-height="100" />
      <div className="office-paged">
        <div
          className="mk-table"
          style={{ "--office-table-floor": "268px" } as React.CSSProperties}
        />
        <div className="office-pagination" data-height="64" />
      </div>
    </ListCard>,
  );
  const card = view.container.querySelector<HTMLElement>(".office-list-card");
  const filter = view.container.querySelector<HTMLElement>(".office-list-filters");
  if (card === null || filter === null) throw new Error("list card and filters must render");
  expect(card.style.getPropertyValue("--office-list-min-height")).toBe("434px");
  filter.dataset.height = "180";
  act(() => resize?.([], {} as ResizeObserver));
  expect(card.style.getPropertyValue("--office-list-min-height")).toBe("514px");
  view.unmount();
  expect(disconnect).toHaveBeenCalled();
});
