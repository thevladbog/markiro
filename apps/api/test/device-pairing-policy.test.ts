import { afterEach, describe, expect, it, vi } from "vitest";

const { randomInt } = vi.hoisted(() => ({ randomInt: vi.fn() }));

vi.mock("node:crypto", () => ({ randomInt }));
import {
  CODE_DIGITS,
  GLOBAL_PAIR_ATTEMPT_BUDGET,
  GLOBAL_PAIR_SOURCE,
  PAIR_ATTEMPT_BUDGET,
  PAIR_ATTEMPT_WINDOW_MS,
  PAIR_CODE_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  mintPairingCode,
  pairAttemptWindowStart,
} from "../src/modules/device-pairing/pairing-policy";

describe("device pairing policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mints an eight-digit code while preserving leading zeroes", () => {
    randomInt.mockReturnValue(42);

    expect(mintPairingCode()).toBe("00000042");
  });

  it("keeps the kiosk pairing lifetime and rate-limit policy aligned", () => {
    expect(CODE_DIGITS).toBe(8);
    expect(PAIRING_TTL_MS).toBe(15 * 60_000);
    expect(PAIR_CODE_MAX_ATTEMPTS).toBe(5);
    expect(PAIR_ATTEMPT_BUDGET).toBe(10);
    expect(GLOBAL_PAIR_ATTEMPT_BUDGET).toBe(400);
    expect(PAIR_ATTEMPT_WINDOW_MS).toBe(PAIRING_TTL_MS);
    expect(GLOBAL_PAIR_SOURCE).toBe("*");
  });

  it("floors an attempt timestamp to its fixed policy window", () => {
    expect(pairAttemptWindowStart(new Date("2026-08-06T12:34:56.789Z"))).toEqual(
      new Date("2026-08-06T12:30:00.000Z"),
    );
  });
});
