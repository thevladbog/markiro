import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { alertFailure, failureMessage, writeFailure } from "../src/office/form-errors.js";

const FIELDS = { name: "orgName", gln: "gln" } as const;

function conflict(constraint: unknown): HostError {
  return new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: "another active line has this name",
    details: { constraint },
  });
}

function rejected(field: string): HostError {
  return new HostError({
    kind: "api",
    code: "validation_failed",
    status: 400,
    message: "rejected",
    details: { field },
  });
}

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

  it("puts a conflict the form knows under its field, with the form's own text", () => {
    const conflicts = { line_name: { field: "name", message: "office.lines.errors.nameTaken" } };
    expect(writeFailure(conflict("line_name"), { name: "name" }, conflicts)).toEqual({
      kind: "field",
      field: "name",
      message: "office.lines.errors.nameTaken",
    });
  });

  it("explains a conflict the form does not know by its code", () => {
    const conflicts = { line_name: { field: "name", message: "office.lines.errors.nameTaken" } };
    expect(writeFailure(conflict("login"), { name: "name" }, conflicts)).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
    expect(writeFailure(conflict(7), { name: "name" }, conflicts)).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
    expect(writeFailure(conflict("line_name"), { name: "name" })).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
  });

  it("gives a field its own text when the form names one", () => {
    const fields = {
      newPassword: { field: "newPassword", message: "rules.password" },
      name: "name",
    } as const;
    expect(writeFailure(rejected("newPassword"), fields)).toEqual({
      kind: "field",
      field: "newPassword",
      message: "rules.password",
    });
    expect(writeFailure(rejected("name"), fields)).toEqual({
      kind: "field",
      field: "name",
      message: "rules.rejected",
    });
  });

  it("never takes an inherited object key for a field or a constraint", () => {
    expect(writeFailure(rejected("constructor"), FIELDS)).toEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    expect(writeFailure(conflict("toString"), FIELDS, {})).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
  });
});

describe("alertFailure", () => {
  it("explains a write that has no field to go under", () => {
    const stale = new HostError({
      kind: "api",
      code: "stale_revision",
      status: 409,
      message: "stale",
      details: { currentRev: 9 },
    });
    expect(alertFailure(stale)).toEqual({ kind: "stale" });
    expect(alertFailure(rejected("name"))).toEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    expect(alertFailure(new Error("boom"))).toEqual({ kind: "alert", message: "errors.unknown" });
  });
});

describe("failureMessage", () => {
  it("shows the alert's own message", () => {
    expect(failureMessage({ kind: "alert", message: "errors.api.validation_failed" })).toBe(
      "errors.api.validation_failed",
    );
  });

  it("falls back to the stale-revision text for anything without a message", () => {
    expect(failureMessage({ kind: "stale" })).toBe("errors.api.stale_revision");
  });
});
