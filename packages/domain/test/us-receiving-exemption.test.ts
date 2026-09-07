import { describe, expect, it } from "vitest";
import {
  assessReceivingExemptionLine,
  type ReceivingExemptReceiptInput,
  type ReceivingExemptionLine,
} from "../src/index.js";

const validExemptReceipt: ReceivingExemptReceiptInput = {
  evidenceUrl: "https://supplier.example.test/declarations/2026-09",
  tlcHandling: "assign_if_missing",
  proposedTlc: "=Own/Ä-001",
};

const line: ReceivingExemptionLine = {
  tlc: null,
  source: { kind: "location", locationId: "dock" },
  lotLinkMode: "create_on_finalize",
  lotId: null,
  exemptSupplier: true,
  exemptReason: "Synthetic supplier declaration reviewed for this receipt",
  exemptReceipt: validExemptReceipt,
};

function assessWithoutMutation(
  candidate: ReceivingExemptionLine,
  receivingLocationId: string | null = "dock",
) {
  const before = structuredClone(candidate);
  const result = assessReceivingExemptionLine(candidate, receivingLocationId);
  expect(candidate).toEqual(before);
  return result;
}

describe("exempt receiving assessment", () => {
  it("assesses an own-code proposal without assigning or changing input", () => {
    expect(assessWithoutMutation(line)).toEqual({
      path: "exempt_assigned_tlc",
      effectiveTlc: "=Own/Ä-001",
      requiresReview: true,
      issues: [],
    });
    expect(line.tlc).toBeNull();
  });

  it("keeps hidden exemption input inactive on an ordinary line", () => {
    expect(
      assessWithoutMutation({
        ...line,
        tlc: "Received-Ä",
        exemptSupplier: false,
        exemptReason: null,
        exemptReceipt: {
          evidenceUrl: "https://user@supplier.example.test/evidence",
          tlcHandling: "assign_if_missing",
          proposedTlc: " replacement ",
        },
      }),
    ).toEqual({
      path: "ordinary",
      effectiveTlc: "Received-Ä",
      requiresReview: false,
      issues: [],
    });
  });

  it("reports every missing exemption primitive without choosing a path", () => {
    expect(
      assessWithoutMutation({
        ...line,
        exemptReason: "  ",
        exemptReceipt: null,
      }),
    ).toEqual({
      path: null,
      effectiveTlc: null,
      requiresReview: true,
      issues: [
        { field: "exemption", code: "required", detail: "exemptReason" },
        { field: "exemption", code: "required", detail: "evidenceUrl" },
        { field: "exemption", code: "required", detail: "tlcHandling" },
      ],
    });
  });

  it("reports a null reason and an absent exemption extension", () => {
    expect(
      assessWithoutMutation({
        tlc: null,
        source: { kind: "location", locationId: "dock" },
        lotLinkMode: "create_on_finalize",
        lotId: null,
        exemptSupplier: true,
        exemptReason: null,
      }),
    ).toEqual({
      path: null,
      effectiveTlc: null,
      requiresReview: true,
      issues: [
        { field: "exemption", code: "required", detail: "exemptReason" },
        { field: "exemption", code: "required", detail: "evidenceUrl" },
        { field: "exemption", code: "required", detail: "tlcHandling" },
      ],
    });
  });

  it("does not choose a path when a present extension has null handling", () => {
    expect(
      assessWithoutMutation({
        ...line,
        exemptReceipt: { ...validExemptReceipt, tlcHandling: null },
      }),
    ).toEqual({
      path: null,
      effectiveTlc: null,
      requiresReview: true,
      issues: [{ field: "exemption", code: "required", detail: "tlcHandling" }],
    });
  });

  it.each([
    ["empty", ""],
    ["userinfo", "https://user@supplier.example.test/evidence"],
    ["backslash", "https://supplier.example.test\\evidence"],
    ["control", "https://supplier.example.test/\u0001"],
    ["over 1,024 UTF-8 bytes", `https://example.test/${"é".repeat(502)}`],
  ])("rejects an invalid %s evidence URL", (_name, evidenceUrl) => {
    expect(
      assessWithoutMutation({
        ...line,
        exemptReceipt: { ...validExemptReceipt, evidenceUrl },
      }).issues,
    ).toEqual([{ field: "exemption", code: "format", detail: "evidenceUrl" }]);
  });

  it.each([
    ["international hostname", "https://bücher.example/evidence"],
    ["exactly 1,024 UTF-8 bytes", `https://example.test/${"é".repeat(501)}a`],
  ])("accepts a credential-free %s evidence URL", (_name, evidenceUrl) => {
    expect(
      assessWithoutMutation({
        ...line,
        exemptReceipt: { ...validExemptReceipt, evidenceUrl },
      }).issues,
    ).toEqual([]);
  });

  it("preserves an existing opaque Unicode TLC and rejects a competing proposal", () => {
    expect(
      assessWithoutMutation({
        ...line,
        tlc: "=Партия/保存-🍎",
        source: {
          kind: "reference",
          referenceKind: "web_url",
          referenceValue: "https://supplier.example.test/lot/A",
          resolvedLocationId: "upstream",
        },
        exemptReceipt: {
          ...validExemptReceipt,
          tlcHandling: "preserve_existing",
          proposedTlc: "replacement",
        },
      }),
    ).toEqual({
      path: "exempt_existing_tlc",
      effectiveTlc: "=Партия/保存-🍎",
      requiresReview: true,
      issues: [{ field: "exemption", code: "format", detail: "proposedTlc" }],
    });
  });

  it("accepts a canonical opaque Unicode TLC on the preserve-existing path", () => {
    expect(
      assessWithoutMutation({
        ...line,
        tlc: "=Партия/保存-🍎",
        exemptReceipt: {
          ...validExemptReceipt,
          tlcHandling: "preserve_existing",
          proposedTlc: null,
        },
      }),
    ).toEqual({
      path: "exempt_existing_tlc",
      effectiveTlc: "=Партия/保存-🍎",
      requiresReview: true,
      issues: [],
    });
  });

  it.each([
    [
      "a missing proposal",
      null,
      [{ field: "tlc", code: "tlc_assignment_required", detail: "proposedTlc" }],
    ],
    ["an empty proposal", "", [{ field: "tlc", code: "format", detail: "proposedTlc" }]],
    [
      "a proposal needing trim",
      " own-1 ",
      [{ field: "tlc", code: "format", detail: "proposedTlc" }],
    ],
    ["invalid Unicode", "own-\ud800", [{ field: "tlc", code: "format", detail: "proposedTlc" }]],
  ] as const)("rejects %s without repairing it", (_name, proposedTlc, issues) => {
    expect(
      assessWithoutMutation({
        ...line,
        exemptReceipt: { ...validExemptReceipt, proposedTlc },
      }),
    ).toEqual({
      path: "exempt_assigned_tlc",
      effectiveTlc: proposedTlc,
      requiresReview: true,
      issues,
    });
  });

  it("reports simultaneous received and proposed TLCs without replacing either", () => {
    expect(assessWithoutMutation({ ...line, tlc: "received-TLC" })).toEqual({
      path: "exempt_assigned_tlc",
      effectiveTlc: "=Own/Ä-001",
      requiresReview: true,
      issues: [{ field: "tlc", code: "format", detail: null }],
    });
  });

  it.each([
    ["wrong receiving site", { kind: "location" as const, locationId: "other" }, "dock"],
    [
      "reference source",
      {
        kind: "reference" as const,
        referenceKind: "web_url" as const,
        referenceValue: "https://supplier.example.test/source",
        resolvedLocationId: "dock",
      },
      "dock",
    ],
    ["missing receiving site", { kind: "location" as const, locationId: "dock" }, null],
  ])("rejects assignment with a %s", (_name, source, receivingLocationId) => {
    expect(assessWithoutMutation({ ...line, source }, receivingLocationId).issues).toEqual([
      { field: "source", code: "format", detail: null },
    ]);
  });

  it.each([
    ["linked mode", "link_existing" as const, null],
    ["selected lot", "create_on_finalize" as const, "lot-1"],
    ["linked selected lot", "link_existing" as const, "lot-1"],
  ])("rejects assignment with %s", (_name, lotLinkMode, lotId) => {
    expect(assessWithoutMutation({ ...line, lotLinkMode, lotId }).issues).toEqual([
      { field: "lot", code: "lot_link_inconsistent", detail: null },
    ]);
  });
});
