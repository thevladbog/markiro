import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Combobox, DatePicker, Modal, Select } from "../src/components/index.js";

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { value: () => false },
    setPointerCapture: { value: () => undefined },
    releasePointerCapture: { value: () => undefined },
    scrollIntoView: { value: () => undefined },
  });
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

const options = [
  { value: "milk", label: "Milk" },
  { value: "kefir", label: "Kefir" },
];

type Host = (props: { onClose: () => void; children: ReactNode }) => ReactNode;

const hosts: ReadonlyArray<readonly [string, Host]> = [
  [
    "Modal",
    ({ onClose, children }) => (
      <Modal open title="Settings" onClose={onClose}>
        {children}
      </Modal>
    ),
  ],
];

describe.each(hosts)("%s Escape handling", (_name, Host) => {
  it("closes on a plain Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Host onClose={onClose}>
        <input aria-label="Name" />
      </Host>,
    );
    await user.click(screen.getByLabelText("Name"));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close on an Escape an inner element already handled", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Host onClose={onClose}>
        <input
          aria-label="Name"
          onKeyDown={(event) => {
            if (event.key === "Escape") event.preventDefault();
          }}
        />
      </Host>,
    );
    await user.click(screen.getByLabelText("Name"));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on an Escape raised inside a nested overlay", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Host onClose={onClose}>
        <div data-mk-nested-overlay="">
          <input aria-label="Inner" />
        </div>
      </Host>,
    );
    await user.click(screen.getByLabelText("Inner"));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only an open Select popover on the first Escape, then itself", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Host onClose={onClose}>
        <Select label="Product" value="milk" options={options} />
      </Host>,
    );
    await user.click(screen.getByRole("combobox", { name: "Product" }));
    expect(screen.getByRole("listbox")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes only an open Combobox popover on the first Escape, then itself", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Host onClose={onClose}>
        <Combobox
          label="Offer"
          options={options}
          onValueChange={vi.fn()}
          placeholder="Select offer"
          searchPlaceholder="Search offers"
          emptyText="No offers"
          loadingText="Loading offers"
        />
      </Host>,
    );
    await user.click(screen.getByRole("combobox", { name: "Offer" }));
    expect(screen.getByRole("searchbox")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes only an open DatePicker calendar on the first Escape, then itself", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Host onClose={onClose}>
        <DatePicker label="Planned date" value="2026-08-06" calendarLabel="Calendar" />
      </Host>,
    );
    await user.click(screen.getByRole("button", { name: "Planned date" }));
    expect(screen.getByRole("dialog", { name: "Calendar" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Calendar" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
