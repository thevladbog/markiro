import { describe, expect, it, vi } from "vitest";
import { clearLegacyFirstTouch, FIRST_TOUCH_STORAGE_KEY } from "./first-touch";

describe("legacy attribution cleanup", () => {
  it("removes only the old attribution key", () => {
    const values = new Map([
      [FIRST_TOUCH_STORAGE_KEY, '{"utm":{"source":"private"}}'],
      ["other", "keep"],
    ]);
    const removeItem = vi.fn((key: string) => {
      values.delete(key);
    });
    clearLegacyFirstTouch({ removeItem });
    expect(removeItem).toHaveBeenCalledExactlyOnceWith(FIRST_TOUCH_STORAGE_KEY);
    expect([...values]).toEqual([["other", "keep"]]);
  });
  it("does not break a form when storage is blocked", () => {
    expect(() =>
      clearLegacyFirstTouch({
        removeItem: () => {
          throw new Error("blocked");
        },
      }),
    ).not.toThrow();
  });
});
