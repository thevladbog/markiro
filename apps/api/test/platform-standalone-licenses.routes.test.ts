import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  PlatformStandaloneLicensesController,
  standaloneTenantParam,
} from "../src/modules/standalone-licenses/platform-standalone-licenses.controller";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";

describe("standalone license platform route policy (plan ЛЦ-0)", () => {
  it("guards every read and mutation with the dedicated capability", () => {
    for (const method of [
      "list",
      "inspect",
      "register",
      "previewIssuance",
      "confirmIssuance",
      "listIssuances",
      "download",
    ] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformStandaloneLicensesController.prototype[method],
        ),
      ).toEqual({
        mode: "capabilities",
        capabilities: ["tenants.read", "standaloneLicenses.manage"],
      });
    }
  });
});

describe("standalone license tenant id in the route (owner decision 2026-10-13)", () => {
  it("accepts the counterparty's opaque id: a platform UUID or a cabinet-era id", () => {
    for (const id of [randomUUID(), "Zq4bL0x9cabinetTenant01", "a.b_c:d-e", "x".repeat(64)]) {
      expect(standaloneTenantParam.transform(id)).toBe(id);
    }
  });

  it("refuses an empty, too long, spaced, control-character or look-alike id before any query", () => {
    for (const id of [
      "",
      "x".repeat(65),
      " tenant",
      "tenant 1",
      "tenant\u0000",
      "tenant\n",
      "tenant/1",
      "t\u0435nant",
      "ｔenant",
      "tenant\u202e",
    ]) {
      expect(() => standaloneTenantParam.transform(id)).toThrow(BadRequestException);
    }
  });
});
