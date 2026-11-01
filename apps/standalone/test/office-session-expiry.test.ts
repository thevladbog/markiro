import { afterEach, describe, expect, it, vi } from "vitest";

import { watchOfficeSession } from "../src/office/office-session-expiry.js";

const MINUTE = 60_000;

afterEach(() => vi.useRealTimers());

describe("office session expiry", () => {
  function setup(hours = 12) {
    vi.useFakeTimers();
    const ended = vi.fn();
    const watch = watchOfficeSession(
      new Date(Date.now() + hours * 60 * MINUTE).toISOString(),
      ended,
    );
    return { watch, ended };
  }

  it("ends an idle session without a click or a keepalive request", () => {
    const { watch, ended } = setup();
    vi.advanceTimersByTime(30 * MINUTE - 1);
    expect(ended).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ended).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("moves the idle deadline for a confirmed office request, but never the absolute expiry", () => {
    const { watch, ended } = setup(1);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(19 * MINUTE);
      watch.confirmRequest(Date.now());
      expect(ended).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(3 * MINUTE);
    expect(ended).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("drops older responses and cancels timers when the session leaves", () => {
    const { watch, ended } = setup();
    const old = Date.now();
    vi.advanceTimersByTime(20 * MINUTE);
    watch.confirmRequest(Date.now());
    watch.confirmRequest(old);
    vi.advanceTimersByTime(11 * MINUTE);
    expect(ended).not.toHaveBeenCalled();
    watch.stop();
    vi.advanceTimersByTime(60 * MINUTE);
    expect(ended).not.toHaveBeenCalled();
  });

  it("checks expiry immediately when the window wakes after sleep", () => {
    const { watch, ended } = setup();
    vi.setSystemTime(Date.now() + 31 * MINUTE);
    window.dispatchEvent(new Event("focus"));
    expect(ended).toHaveBeenCalledTimes(1);
    watch.stop();
  });
});
