import { describe, expect, it } from "vitest";
import type { ShellView } from "../src/app/shell.js";
import { INITIAL_HOST_HOME, startView } from "../src/app/start-screen.js";

const FLOOR: ShellView = { kind: "floor" };
const LINE: ShellView = { kind: "line_select" };
const OFFICE_LOGIN: ShellView = { kind: "office_login", notice: null };

describe("the start screen by role (owner requirement, beta 3.2)", () => {
  it("starts a host PC in the office, never persisted", () => {
    expect(INITIAL_HOST_HOME).toBe("office");
    expect(startView(FLOOR, "host", "office")).toEqual(OFFICE_LOGIN);
    expect(startView(LINE, "host", "office")).toEqual(OFFICE_LOGIN);
  });

  it("lets a host PC stay on the floor once it went there", () => {
    expect(startView(FLOOR, "host", "floor")).toBe(FLOOR);
    expect(startView(LINE, "host", "floor")).toBe(LINE);
  });

  it("never shows an office PC the floor", () => {
    for (const home of ["office", "floor"] as const) {
      expect(startView(FLOOR, "office", home)).toEqual(OFFICE_LOGIN);
      expect(startView({ kind: "floor_operator", operator: {} as never }, "office", home)).toEqual(
        OFFICE_LOGIN,
      );
    }
  });

  it("leaves a station, and a PC with no readable role, on the floor", () => {
    for (const role of ["station", null] as const) {
      expect(startView(FLOOR, role, "office")).toBe(FLOOR);
      expect(startView(LINE, role, "office")).toBe(LINE);
    }
  });

  it("holds a floor screen until the role is known, and passes every other screen", () => {
    expect(startView(FLOOR, "unknown", "office")).toEqual({ kind: "loading" });
    for (const role of ["host", "station", "office", null, "unknown"] as const) {
      for (const view of [
        { kind: "bootstrap" },
        { kind: "pairing" },
        { kind: "network_pairing" },
        { kind: "host_missing", reason: "unreachable" },
        { kind: "device_rejected", reason: "key_rejected" },
        OFFICE_LOGIN,
      ] as ShellView[]) {
        expect(startView(view, role, "office")).toBe(view);
      }
    }
  });
});
