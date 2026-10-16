import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  duplicateSteps,
  UnitLabelPanel,
  type DuplicateStepState,
  type UnitLabelShown,
} from "../src/floor/unit-labels/UnitLabelPanel.js";

/*
 * «Дубликат Data Matrix» as three vertical steps (kit step C). The steps are derived from the
 * label job's own state: the state machine is not touched.
 */

function job(
  attemptState: UnitLabelShown["attemptState"],
  verification: UnitLabelShown["verification"],
  policy: UnitLabelShown["verificationPolicy"] = "required",
): UnitLabelShown {
  return {
    id: "job-1",
    attemptNo: 1,
    attemptState,
    verificationPolicy: policy,
    verification,
    fields: {},
  };
}

type Steps = [DuplicateStepState, DuplicateStepState, DuplicateStepState];

describe("the duplicate's steps, from the job's state", () => {
  const CASES: [string, UnitLabelShown | null, boolean, Steps][] = [
    ["no label yet", null, false, ["pending", "pending", "pending"]],
    ["prepared", job("prepared", "pending"), false, ["ready", "current", "pending"]],
    ["sending", job("sending", "pending"), false, ["ready", "current", "pending"]],
    ["sent, check waits", job("sent", "pending"), false, ["ready", "ready", "current"]],
    ["verified", job("sent", "verified"), false, ["ready", "ready", "ready"]],
    ["skipped", job("sent", "skipped"), false, ["ready", "ready", "ready"]],
    [
      "sent under no check",
      job("sent", "not_required", "none"),
      false,
      ["ready", "ready", "pending"],
    ],
    [
      "failed before the send",
      job("failed_before_send", "pending"),
      false,
      ["ready", "error", "pending"],
    ],
    ["delivery unknown", job("delivery_unknown", "pending"), false, ["ready", "error", "pending"]],
    [
      "unknown, then settled by the label's scan",
      job("delivery_unknown", "verified"),
      false,
      ["ready", "ready", "ready"],
    ],
    [
      "a decision is being saved on a stopped step",
      job("failed_before_send", "pending"),
      true,
      ["ready", "current", "pending"],
    ],
  ];

  it.each(CASES)("%s", (_name, shown, busy, expected) => {
    expect(duplicateSteps(shown, busy, shown?.verificationPolicy ?? "required").steps).toEqual(
      expected,
    );
  });

  it("says the check is off when the shift's policy is none", () => {
    expect(duplicateSteps(null, false, "none").checkOff).toBe(true);
    expect(duplicateSteps(job("sent", "not_required", "none"), false, "none").checkOff).toBe(true);
    expect(duplicateSteps(null, false, "required").checkOff).toBe(false);
  });
});

function renderPanel(shown: UnitLabelShown | null, busy = false, onRecover?: () => void) {
  return render(
    <ThemeProvider>
      <UnitLabelPanel
        job={shown}
        busy={busy}
        verification="required"
        {...(onRecover === undefined ? {} : { onRecover })}
      />
    </ThemeProvider>,
  );
}

function stepStates(): string[] {
  return within(screen.getByRole("list"))
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("data-state") ?? "");
}

describe("the duplicate's steps on the screen", () => {
  it("lists the three steps in order, each with its state, and one line of words", () => {
    renderPanel(null);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Код принят",
      "Этикетка напечатана",
      "Проверка этикетки",
    ]);
    expect(stepStates()).toEqual(["pending", "pending", "pending"]);
    expect(screen.getByRole("status").textContent).toBe("Ожидание сканирования");
  });

  it("marks a label that waits for its check: the third step is in hand", () => {
    renderPanel(job("sent", "pending"));
    expect(stepStates()).toEqual(["ready", "ready", "current"]);
    expect(screen.getByRole("status").textContent).toBe("Проверьте этикетку");
  });

  it("marks a confirmed label: all three ready", () => {
    renderPanel(job("sent", "verified"));
    expect(stepStates()).toEqual(["ready", "ready", "ready"]);
    expect(screen.getByRole("status").textContent).toBe("Этикетка подтверждена");
  });

  it("names the step that is not asked when the check is off", () => {
    render(
      <ThemeProvider>
        <UnitLabelPanel
          job={job("sent", "not_required", "none")}
          busy={false}
          verification="none"
        />
      </ThemeProvider>,
    );
    expect(screen.getByText("Проверка этикетки выключена")).toBeTruthy();
    expect(stepStates()).toEqual(["ready", "ready", "pending"]);
  });

  it("shows a stopped print in error with its recovery action, as a floor button", () => {
    const onRecover = vi.fn();
    renderPanel(job("delivery_unknown", "pending"), false, onRecover);
    expect(stepStates()).toEqual(["ready", "error", "pending"]);
    const stopped = within(screen.getByRole("list")).getAllByRole("listitem")[1];
    if (stopped === undefined) throw new Error("no step");
    const retry = within(stopped).getByRole("button", { name: "Повторить" });
    expect(retry.className).toContain("mk-btn--floor");
    fireEvent.click(retry);
    expect(onRecover).toHaveBeenCalledTimes(1);
    // No other step offers an action.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("says nothing of its recovery without a handler, and keeps the step in error", () => {
    renderPanel(job("failed_before_send", "pending"));
    expect(stepStates()).toEqual(["ready", "error", "pending"]);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
