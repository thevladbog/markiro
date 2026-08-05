import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import {
  DatePicker,
  Select,
  SidePanel,
  type OverlayDismissReason,
} from "../src/components/index.js";

function PanelHarness({
  onClose = vi.fn(),
}: {
  onClose?: (reason: OverlayDismissReason) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open product
      </button>
      <SidePanel
        open={open}
        title="New product"
        description="Product fields"
        closeLabel="Close panel"
        onClose={(reason) => {
          onClose(reason);
          setOpen(false);
        }}
        footer={<button type="button">Save</button>}
      >
        <label>
          Name
          <input />
        </label>
      </SidePanel>
    </>
  );
}

afterEach(() => {
  cleanup();
  expect(document.querySelector(".mk-overlay-root")).toBeNull();
  document.body.style.overflow = "";
});

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { value: () => false },
    setPointerCapture: { value: () => undefined },
    releasePointerCapture: { value: () => undefined },
    scrollIntoView: { value: () => undefined },
  });
});

it("portals a labelled panel to body and removes the host after close", async () => {
  const user = userEvent.setup();
  render(<PanelHarness />);

  await user.click(screen.getByRole("button", { name: "Open product" }));

  const panel = screen.getByRole("dialog", { name: "New product" });
  expect(panel.closest(".mk-overlay-layer")?.parentElement).toBe(
    document.querySelector(".mk-overlay-root"),
  );
  expect(panel.getAttribute("aria-describedby")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Close panel" }));

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector(".mk-overlay-root")).toBeNull();
});

it.each([
  [
    "close-button",
    async (user: ReturnType<typeof userEvent.setup>) =>
      user.click(screen.getByRole("button", { name: "Close panel" })),
  ],
  ["escape", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
  [
    "backdrop",
    async (user: ReturnType<typeof userEvent.setup>) =>
      user.click(document.querySelector(".mk-side-panel__scrim") as HTMLElement),
  ],
] as const)("reports %s dismissal", async (reason, dismiss) => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<PanelHarness onClose={onClose} />);

  await user.click(screen.getByRole("button", { name: "Open product" }));
  await dismiss(user);

  expect(onClose).toHaveBeenCalledWith(reason);
});

it("focuses the first editable field, traps focus, and restores the exact trigger", async () => {
  const user = userEvent.setup();
  render(<PanelHarness />);
  const trigger = screen.getByRole("button", { name: "Open product" });

  await user.click(trigger);
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));

  screen.getByRole("button", { name: "Save" }).focus();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close panel" }));

  await user.click(screen.getByRole("button", { name: "Close panel" }));
  expect(document.activeElement).toBe(trigger);
});

it("makes the app inert, locks scroll, and restores both exactly", async () => {
  document.body.style.overflow = "clip";
  const user = userEvent.setup();
  const { container } = render(<PanelHarness />);

  await user.click(screen.getByRole("button", { name: "Open product" }));
  expect(container.inert).toBe(true);
  expect(document.body.style.overflow).toBe("hidden");

  await user.click(screen.getByRole("button", { name: "Close panel" }));
  expect(container.inert).toBe(false);
  expect(document.body.style.overflow).toBe("clip");
});

it("blocks every dismissal path while busy", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <SidePanel open busy title="Saving" closeLabel="Close" onClose={onClose}>
      Body
    </SidePanel>,
  );

  expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard("{Escape}");
  await user.click(document.querySelector(".mk-side-panel__scrim") as HTMLElement);
  expect(onClose).not.toHaveBeenCalled();
});

it.each(["compact", "standard", "complex"] as const)("applies the %s size token", (size) => {
  render(<SidePanel open size={size} title="Panel" closeLabel="Close" onClose={() => {}} />);
  expect(screen.getByRole("dialog").classList.contains(`mk-side-panel--${size}`)).toBe(true);
});

it("keeps Radix child portals in the panel and lets each child consume Escape first", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <SidePanel open title="Panel" closeLabel="Close" onClose={onClose}>
      <Select label="Product" value="milk" options={[{ value: "milk", label: "Milk" }]} />
      <DatePicker label="Planned date" value="2026-08-06" calendarLabel="Calendar" />
    </SidePanel>,
  );

  await user.click(screen.getByRole("combobox", { name: "Product" }));
  expect(screen.getByRole("listbox").closest(".mk-overlay-layer--panel")).not.toBeNull();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Planned date" }));
  expect(screen.getByRole("dialog", { name: "Calendar" }).closest(".mk-overlay-layer--panel")).not.toBeNull();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Calendar" })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
