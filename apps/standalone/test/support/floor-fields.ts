import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

import { chooseTextOn, optionTextsOn, shownOn } from "./select.js";

/**
 * The floor's fields in a test: the setup's lists are the product's own `Select` (a Radix trigger
 * and a listbox in a portal), its text fields are inputs. A test names a field by its label and
 * a choice by the value the form keeps (`usb`, `300`, a printer's id) or by its text.
 */
const CHOICE_TEXT: Record<string, string> = {
  tcp: "Сеть (порт 9100)",
  serial: "COM-порт",
  usb: "Принтер Windows (USB)",
  "203": "203 dpi",
  "300": "300 dpi",
  raw: "На языке принтера (ZPL / TSPL)",
  windows_driver: "Через драйвер Windows",
  label: "Термоэтикетка",
  a4: "Лист А4 (драйвер Windows)",
  zpl: "ZPL (Zebra)",
  tspl: "TSPL (TSC)",
  zebra: "Zebra у линии",
  tsc: "TSC на COM4",
  godex: "Godex через драйвер",
  "hp-a4": "HP LaserJet А4",
};

/** Whether `element` is a `Select`'s trigger. */
export function isList(element: HTMLElement): boolean {
  return element instanceof HTMLButtonElement && element.getAttribute("role") === "combobox";
}

/** Types into the field called `label`, or picks the choice `value` in its list. */
export function setField(label: string, value: string): void {
  const element = screen.getByLabelText(label);
  if (isList(element)) {
    chooseTextOn(element, value === "" ? "Не назначен" : (CHOICE_TEXT[value] ?? value));
  } else {
    fireEvent.change(element, { target: { value } });
  }
}

/** The text a list shows closed. */
export const shownInList = (label: string) => shownOn(screen.getByLabelText(label));

/** The texts of a list's choices, in order. */
export const choicesOf = (label: string) => optionTextsOn(screen.getByLabelText(label));

/** Waits until the list of Windows printers has come (the list itself is only in the page when open). */
export async function usbListed(): Promise<void> {
  await waitFor(() =>
    expect(screen.queryByText("Спрашиваем у Windows список принтеров…")).toBeNull(),
  );
}
