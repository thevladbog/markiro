import { beforeEach, describe, expect, it } from "vitest";

import {
  clearLogins,
  forgetLogin,
  MAX_RECENT_LOGINS,
  readRecentLogins,
  rememberLogin,
} from "../src/office/recent-logins.js";

describe("the office users who signed in on this PC", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty and keeps the latest sign-in first, once", () => {
    expect(readRecentLogins()).toEqual([]);
    rememberLogin("admin");
    rememberLogin("irina");
    expect(rememberLogin("admin")).toEqual(["admin", "irina"]);
    expect(readRecentLogins()).toEqual(["admin", "irina"]);
  });

  it("keeps at most six, dropping the oldest", () => {
    for (let n = 1; n <= MAX_RECENT_LOGINS + 2; n += 1) rememberLogin(`user-${n}`);
    const names = readRecentLogins();
    expect(names).toHaveLength(MAX_RECENT_LOGINS);
    expect(names[0]).toBe(`user-${MAX_RECENT_LOGINS + 2}`);
    expect(names).not.toContain("user-1");
  });

  it("forgets one name and leaves the rest", () => {
    rememberLogin("a-user");
    rememberLogin("b-user");
    expect(forgetLogin("a-user")).toEqual(["b-user"]);
    expect(readRecentLogins()).toEqual(["b-user"]);
  });

  it("clears the list", () => {
    rememberLogin("a-user");
    clearLogins();
    expect(readRecentLogins()).toEqual([]);
  });

  it("stores the names alone: no password, no role", () => {
    rememberLogin("admin");
    const raw = localStorage.getItem("markiro.office.recentLogins");
    expect(JSON.parse(raw ?? "null")).toEqual(["admin"]);
  });

  it("reads a damaged value as an empty list, and drops what is no login name", () => {
    localStorage.setItem("markiro.office.recentLogins", "{not json");
    expect(readRecentLogins()).toEqual([]);
    localStorage.setItem(
      "markiro.office.recentLogins",
      JSON.stringify(["ok", 7, "", "x".repeat(65), "ok", null]),
    );
    expect(readRecentLogins()).toEqual(["ok"]);
  });
});
