import { act, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { toast } from "../src/lib/toast.js";

// `toast()` renders into its own React root on `document.body`, which RTL's
// cleanup never unmounts, and arms a four-second dismiss timer. A timer left
// pending when a file ends fires after Vitest has torn jsdom down and commits
// into that root: "window is not defined". The test setup resets toasts after
// every test; these two run in order, so the second sees what the first left.
let timersBefore = 0;

it("shows a toast the way a successful save does", () => {
  vi.useFakeTimers();
  timersBefore = vi.getTimerCount();
  act(() => {
    toast("ok", "Сотрудник добавлен");
  });

  expect(screen.getByText("Сотрудник добавлен")).toBeDefined();
  expect(vi.getTimerCount()).toBe(timersBefore + 1);
});

it("leaves the next test no toast root and no pending dismiss timer", () => {
  try {
    expect(document.querySelector("[data-mk-toast-root]")).toBeNull();
    expect(vi.getTimerCount()).toBe(timersBefore);
  } finally {
    vi.useRealTimers();
  }
});
