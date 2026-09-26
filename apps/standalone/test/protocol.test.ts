import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  blockSizesUpdateSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  credentialSchema,
  deviceInfoSchema,
  errorBodySchema,
  helloSchema,
  officeLoginRequestSchema,
  officeSessionSchema,
  officeUserCreateSchema,
  officeUserRecordSchema,
  officeUserSchema,
  officeUserUpdateSchema,
  orgProfileSchema,
  orgProfileUpdateSchema,
  passwordChangeSchema,
  passwordSetSchema,
  ssccCounterUpdateSchema,
  ssccStateSchema,
} from "../src/host/protocol.js";

// Vite statically rewrites the literal pattern `new URL(..., import.meta.url)`
// for browser asset bundling (see `vite:asset-import-meta-url`); under the
// jsdom test environment that rewrite resolves against a fake browser
// location instead of this file's real path, breaking a plain fixture read.
// Binding the value first keeps this a normal runtime URL resolution.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe("protocol schemas parse the shared Rust fixtures", () => {
  it("hello", () => {
    expect(helloSchema.parse(fixture("hello.json"))).toMatchObject({
      product: "markiro-host",
      protocol: 1,
      initialized: false,
    });
  });

  it("error bodies", () => {
    expect(errorBodySchema.parse(fixture("error-not-found.json")).error.code).toBe("not_found");
    expect(errorBodySchema.parse(fixture("error-with-details.json")).error.details).toEqual({
      protocol: 7,
      minProtocol: 1,
      maxProtocol: 1,
    });
  });

  it("rejects unknown fields in payloads the Rust shell rebuilds from proto types", () => {
    const hello = { ...(fixture("hello.json") as Record<string, unknown>), extra: true };
    expect(helloSchema.safeParse(hello).success).toBe(false);
  });

  it("rejects non-object error details, like the Rust Map type", () => {
    const body = fixture("error-with-details.json") as { error: Record<string, unknown> };
    expect(
      errorBodySchema.safeParse({ error: { ...body.error, details: "not an object" } }).success,
    ).toBe(false);
  });
});

// Host responses pass through the shell unchanged: lenient, like the Rust
// response types. Requests are strict, like the host's deny_unknown_fields.
const RESPONSES = [
  ["device-info.json", deviceInfoSchema],
  ["office-user.json", officeUserSchema],
  ["office-session.json", officeSessionSchema],
  ["bootstrap-response.json", bootstrapResponseSchema],
  ["org-profile.json", orgProfileSchema],
  ["sscc-state.json", ssccStateSchema],
  ["office-user-record.json", officeUserRecordSchema],
  ["error-unauthorized.json", errorBodySchema],
] as const;

const REQUESTS = [
  ["office-login-request.json", officeLoginRequestSchema],
  ["bootstrap-request.json", bootstrapRequestSchema],
  ["org-profile-update.json", orgProfileUpdateSchema],
  ["sscc-counter-update.json", ssccCounterUpdateSchema],
  ["block-sizes-update.json", blockSizesUpdateSchema],
  ["office-user-create.json", officeUserCreateSchema],
  ["office-user-update.json", officeUserUpdateSchema],
  ["password-set.json", passwordSetSchema],
  ["password-change.json", passwordChangeSchema],
] as const;

function extended(name: string): Record<string, unknown> {
  return { ...(fixture(name) as Record<string, unknown>), addedLater: true };
}

describe.each(RESPONSES)("response fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });

  it("tolerates a field added by a newer host", () => {
    expect(schema.safeParse(extended(name)).success).toBe(true);
  });
});

describe.each(REQUESTS)("request fixture %s", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });

  it("rejects an unknown field, like the host", () => {
    expect(schema.safeParse(extended(name)).success).toBe(false);
  });
});

describe("unauthorized errors", () => {
  it("name the rejected credential", () => {
    const body = errorBodySchema.parse(fixture("error-unauthorized.json"));
    expect(credentialSchema.parse(body.error.details?.credential)).toBe("session");
  });
});
