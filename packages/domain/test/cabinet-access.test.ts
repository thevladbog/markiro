import { describe, expect, it } from "vitest";
import {
  CABINET_CAPABILITY as C,
  hasCabinetCapabilities,
  resolveCabinetAccess,
} from "../src/access/cabinet.js";

describe("resolveCabinetAccess", () => {
  it("gives a manager operations only", () => {
    expect(resolveCabinetAccess("manager")).toEqual({
      roles: ["manager"],
      capabilities: [C.OPERATIONS_READ, C.OPERATIONS_WRITE],
    });
  });

  it("grants billing only to tenant owners and admins", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(resolveCabinetAccess(role).capabilities).toEqual(
        expect.arrayContaining([C.BILLING_READ, C.BILLING_REQUEST]),
      );
    }
    for (const role of ["manager", "member"] as const) {
      expect(resolveCabinetAccess(role).capabilities).not.toEqual(
        expect.arrayContaining([C.BILLING_READ, C.BILLING_REQUEST]),
      );
    }
  });

  it("makes admin a superset of manager and owner a superset of admin", () => {
    expect(resolveCabinetAccess("admin").capabilities).toEqual([
      C.OPERATIONS_READ,
      C.OPERATIONS_WRITE,
      C.INTEGRATIONS_READ,
      C.INTEGRATIONS_WRITE,
      C.TENANT_SETTINGS_MANAGE,
      C.BILLING_READ,
      C.BILLING_REQUEST,
      C.CREDENTIALS_MANAGE,
      C.MEMBERS_MANAGE,
    ]);
    expect(resolveCabinetAccess("owner").capabilities).toEqual([
      C.OPERATIONS_READ,
      C.OPERATIONS_WRITE,
      C.INTEGRATIONS_READ,
      C.INTEGRATIONS_WRITE,
      C.TENANT_SETTINGS_MANAGE,
      C.BILLING_READ,
      C.BILLING_REQUEST,
      C.CREDENTIALS_MANAGE,
      C.MEMBERS_MANAGE,
    ]);
  });

  it("gives member and unknown roles no capabilities", () => {
    expect(resolveCabinetAccess("member").capabilities).toEqual([]);
    expect(resolveCabinetAccess("future-role").capabilities).toEqual([]);
  });

  it("normalizes a comma-separated multi-role membership", () => {
    expect(resolveCabinetAccess(" member, admin,admin, future-role ")).toEqual({
      roles: ["member", "admin"],
      capabilities: [
        C.OPERATIONS_READ,
        C.OPERATIONS_WRITE,
        C.INTEGRATIONS_READ,
        C.INTEGRATIONS_WRITE,
        C.TENANT_SETTINGS_MANAGE,
        C.BILLING_READ,
        C.BILLING_REQUEST,
        C.CREDENTIALS_MANAGE,
        C.MEMBERS_MANAGE,
      ],
    });
  });

  it("checks every required capability", () => {
    const admin = resolveCabinetAccess("admin").capabilities;
    expect(hasCabinetCapabilities(admin, [C.INTEGRATIONS_WRITE, C.CREDENTIALS_MANAGE])).toBe(true);
    expect(hasCabinetCapabilities(admin, [C.MEMBERS_MANAGE])).toBe(true);
    expect(
      hasCabinetCapabilities(resolveCabinetAccess("manager").capabilities, [C.MEMBERS_MANAGE]),
    ).toBe(false);
  });
});
