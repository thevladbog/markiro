import { describe, expect, it } from "vitest";
import { platformCapabilitiesForRole } from "@markiro/platform-contracts";

import {
  assertAllowedAttachment,
  MAX_ATTACHMENT_BYTES,
} from "../src/modules/platform-agreements/agreement-documents.service";
import {
  agreementAttachmentObjectKey,
  agreementDraftObjectKey,
  agreementSignedObjectKey,
  isAgreementObjectKey,
} from "../src/modules/platform-agreements/agreement-object-key";
import { PlatformAgreementsController } from "../src/modules/platform-agreements/platform-agreements.controller";
import {
  hasPlatformCapabilities,
  PLATFORM_ACCESS_POLICY,
} from "../src/platform-auth/platform-access-policy";

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function policyFor(method: keyof PlatformAgreementsController): {
  mode: string;
  capabilities?: readonly string[];
} {
  const handler = PlatformAgreementsController.prototype[method];
  const policy = Reflect.getMetadata(PLATFORM_ACCESS_POLICY, handler as object);
  if (!policy) throw new Error(`Handler ${String(method)} declares no access policy`);
  return policy;
}

describe("agreement route policies", () => {
  const readers = ["list", "detail", "tenantCandidates", "download"] as const;
  const writers = [
    "create",
    "update",
    "transition",
    "linkTenant",
    "unlinkTenant",
    "renderDraft",
    "uploadAttachment",
    "deleteAttachment",
  ] as const;

  it.each(readers)("%s requires agreements.read", (method) => {
    expect(policyFor(method).capabilities).toEqual(["agreements.read"]);
  });

  it.each(writers)("%s requires agreements.write", (method) => {
    expect(policyFor(method).capabilities).toEqual(["agreements.write"]);
  });

  it("lets support read but never write", () => {
    const support = platformCapabilitiesForRole.support;
    expect(hasPlatformCapabilities(support, ["agreements.read"])).toBe(true);
    expect(hasPlatformCapabilities(support, ["agreements.write"])).toBe(false);
  });

  it("lets platform_admin and accountant write", () => {
    for (const role of ["platform_admin", "accountant"] as const) {
      expect(hasPlatformCapabilities(platformCapabilitiesForRole[role], ["agreements.write"])).toBe(
        true,
      );
    }
  });
});

describe("attachment gate", () => {
  it("accepts each allowlisted type by its leading bytes", () => {
    expect(() => assertAllowedAttachment("application/pdf", PDF)).not.toThrow();
    expect(() =>
      assertAllowedAttachment(DOCX_MEDIA_TYPE, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])),
    ).not.toThrow();
    expect(() =>
      assertAllowedAttachment("image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])),
    ).not.toThrow();
  });

  it("rejects a type outside the allowlist", () => {
    expect(() => assertAllowedAttachment("application/zip", PDF)).toThrow(/Unsupported/);
    expect(() => assertAllowedAttachment("text/html", PDF)).toThrow(/Unsupported/);
  });

  it("rejects an executable renamed to a PDF", () => {
    // Mach-O magic with a PDF content type: the declaration lies, the bytes do not.
    const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00]);
    expect(() => assertAllowedAttachment("application/pdf", machO)).toThrow(
      /does not match its declared type/,
    );
  });

  it("rejects an empty file and one past the size cap", () => {
    expect(() => assertAllowedAttachment("application/pdf", Buffer.alloc(0))).toThrow(/Empty/);
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    PDF.copy(oversized);
    expect(() => assertAllowedAttachment("application/pdf", oversized)).toThrow(/20 MB/);
  });
});

describe("agreement object keys", () => {
  const AGREEMENT = "6915caba-c643-4edb-b4ed-df5a95522942";
  const SHA = "a".repeat(64);

  it("accepts exactly the three shapes the service writes", () => {
    expect(isAgreementObjectKey(agreementDraftObjectKey(AGREEMENT))).toBe(true);
    expect(isAgreementObjectKey(agreementSignedObjectKey(AGREEMENT, SHA))).toBe(true);
    expect(isAgreementObjectKey(agreementAttachmentObjectKey(AGREEMENT, AGREEMENT))).toBe(true);
  });

  it("refuses anything else under the namespace", () => {
    // The object store allowlists namespaces; a loose prefix would widen it.
    expect(isAgreementObjectKey(`agreements/${AGREEMENT}/anything.docx`)).toBe(false);
    expect(isAgreementObjectKey(`agreements/${AGREEMENT}/../escape`)).toBe(false);
    expect(isAgreementObjectKey("agreements/not-a-uuid/draft.docx")).toBe(false);
    expect(isAgreementObjectKey(`agreements/${AGREEMENT}/attachments/report.pdf`)).toBe(false);
  });

  it("refuses to build a key from an unsafe identifier", () => {
    expect(() => agreementDraftObjectKey("../../etc")).toThrow(/Unsafe object key/);
    expect(() => agreementAttachmentObjectKey(AGREEMENT, "../escape")).toThrow(/Unsafe object key/);
  });
});
