import { expect, it } from "vitest";
import { parseServerProfile, SERVER_PROFILE } from "../src/server-profile.js";

it("retains legacy for the existing build recipe", () => {
  expect(parseServerProfile(undefined)).toBe("legacy");
  expect(SERVER_PROFILE).toBe("legacy");
});

it.each(["legacy", "platform-only"])("accepts the explicit %s build profile", (value) => {
  expect(parseServerProfile(value)).toBe(value);
});

it.each(["", "platform", "LEGACY", "platform-only ", null, 1])(
  "rejects an invalid profile %s",
  (value) => {
    expect(() => parseServerProfile(value)).toThrow(
      "VITE_SERVER_PROFILE must be legacy or platform-only",
    );
  },
);
