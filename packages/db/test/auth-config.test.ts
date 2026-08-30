import { describe, expect, it } from "vitest";

import { STATION_API_KEY_RATE_LIMIT } from "../src/auth-config.js";

describe("station API key configuration", () => {
  it("does not apply Better Auth's idle-window quota to an always-connected station", () => {
    expect(STATION_API_KEY_RATE_LIMIT).toEqual({ enabled: false });
  });
});
