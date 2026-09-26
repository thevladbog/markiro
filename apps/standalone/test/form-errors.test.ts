import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { writeFailure } from "../src/office/form-errors.js";

const FIELDS = { name: "orgName", gln: "gln" } as const;

describe("writeFailure", () => {
  it("puts a validation failure under the form field the host names", () => {
    const error = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "the GLN must be 13 digits",
      details: { field: "gln" },
    });
    expect(writeFailure(error, FIELDS)).toEqual({
      kind: "field",
      field: "gln",
      message: "rules.rejected",
    });
  });

  it("asks to reload after a stale write", () => {
    const error = new HostError({
      kind: "api",
      code: "stale_revision",
      status: 409,
      message: "stale",
      details: { currentRev: 9 },
    });
    expect(writeFailure(error, FIELDS)).toEqual({ kind: "stale" });
  });

  it("explains everything else by its code", () => {
    const unknownField = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "bad",
      details: { field: "somethingElse" },
    });
    expect(writeFailure(unknownField, FIELDS)).toEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    expect(writeFailure(down, FIELDS)).toEqual({
      kind: "alert",
      message: "errors.transport.unreachable",
    });
    expect(writeFailure(new Error("boom"), FIELDS)).toEqual({
      kind: "alert",
      message: "errors.unknown",
    });
  });
});
