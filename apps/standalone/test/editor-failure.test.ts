import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { deleteFailure, editorFailure } from "../src/office/templates/editor-failure.js";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, message: code, details });
}

describe("a refused template save", () => {
  it("says whose default a template is", () => {
    expect(
      editorFailure(
        api("conflict", {
          constraint: "template_is_default",
          organizationDefault: true,
          categoryDefaults: [8],
        }),
      ),
    ).toStrictEqual({ kind: "default", conflict: { organization: true, categories: [8] } });
  });

  it("puts a refused name or categories under the control", () => {
    expect(editorFailure(api("validation_failed", { field: "name" }))).toStrictEqual({
      kind: "field",
      field: "name",
      message: "rules.rejected",
    });
    expect(
      editorFailure(api("validation_failed", { field: "chzProductGroupCodes" })),
    ).toStrictEqual({
      kind: "field",
      field: "scope",
      message: "office.templateEditor.errors.scopeRejected",
    });
  });

  it("explains a stock template, a refused layout and a deleted template above the form", () => {
    expect(editorFailure(api("conflict", { constraint: "stock_template" }))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.stock",
    });
    expect(editorFailure(api("validation_failed", { field: "spec" }))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.specRejected",
    });
    expect(editorFailure(api("not_found"))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.missing",
    });
  });

  it("offers to reload a stale save and explains the rest by its code", () => {
    expect(editorFailure(api("stale_revision", { currentRev: 9 }))).toStrictEqual({
      kind: "stale",
    });
    expect(editorFailure(api("conflict", { constraint: "line_name" }))).toStrictEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
    expect(
      editorFailure(new HostError({ kind: "transport", code: "unreachable", message: "down" })),
    ).toStrictEqual({ kind: "alert", message: "errors.transport.unreachable" });
  });
});

describe("a refused template delete", () => {
  it("says whose default it is, that a stock template stays, that the template is gone, and the rest by its code", () => {
    expect(
      deleteFailure(
        api("conflict", {
          constraint: "template_is_default",
          organizationDefault: false,
          categoryDefaults: [13, 8],
        }),
      ),
    ).toStrictEqual({ kind: "default", conflict: { organization: false, categories: [13, 8] } });
    expect(deleteFailure(api("conflict", { constraint: "stock_template" }))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.stockDelete",
    });
    expect(deleteFailure(api("not_found"))).toStrictEqual({
      kind: "alert",
      message: "office.templateEditor.errors.missing",
    });
    expect(deleteFailure(api("forbidden"))).toStrictEqual({
      kind: "alert",
      message: "errors.api.forbidden",
    });
  });
});
