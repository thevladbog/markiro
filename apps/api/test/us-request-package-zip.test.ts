import { createHash } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { ServiceUnavailableException } from "@nestjs/common";
import * as fflate from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseUsRequestManifest,
  type UsRequestManifestV1,
} from "../src/modules/traceability/requests/us-request-package-manifest";
import {
  US_REQUEST_PACKAGE_LIMITS as limits,
  type UsRequestPackageByteFile,
  type UsRequestPackageInputs,
  type UsRequestReportModel,
} from "../src/modules/traceability/requests/us-request-package-types";
import * as renderer from "../src/modules/traceability/requests/us-request-report-pdf";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";

// Call-through instrumentation only: every zip byte still comes from the pinned real encoder.
vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof fflate>();
  return { ...actual, zipSync: vi.fn(actual.zipSync) };
});

const api = () => import("../src/modules/traceability/requests/us-request-package-zip");
const composer = () => import("../src/modules/traceability/requests/us-request-package");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const id = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const media = {
  "records.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "plan.pdf": "application/pdf",
  "validation.json": "application/json",
  "request-report.pdf": "application/pdf",
  "manifest.json": "application/json",
  SHA256SUMS: "text/plain",
  "package.zip": "application/zip",
};
function file<N extends UsRequestPackageByteFile["name"]>(
  name: N,
  value: string | Buffer,
): UsRequestPackageByteFile<N> {
  const bytes = Buffer.from(value);
  return { name, bytes, mediaType: media[name], byteSize: bytes.length, sha256: hash(bytes) };
}
function descriptor({ bytes, ...metadata }: UsRequestPackageByteFile) {
  void bytes;
  return metadata;
}
// Known byte fixtures exercise only the codec. These are deliberately NOT real XLSX/PDF proof.
function fixture(optional = false) {
  const payloads = [
    ...(optional
      ? [file("records.xlsx", "KNOWN WORKBOOK BYTES"), file("plan.pdf", "KNOWN PLAN BYTES")]
      : []),
    file("validation.json", '{"fixture":1}'),
    file("request-report.pdf", "KNOWN REPORT BYTES"),
  ];
  const manifest: UsRequestManifestV1 = {
    schemaVersion: 1,
    packageVersion: "us-request-package-v1",
    reportRendererVersion: "us-request-report-pdf-v1",
    identity: {
      tenantId: id,
      requestId: id,
      requestRevision: 1,
      runId,
      runRevision: 1,
      mode: optional ? "export_ready" : "available_records_incomplete",
      preparedBy: "codec-fixture-actor",
    },
    timing: {
      schemaVersion: 1,
      preparationStartedAt: "2026-10-04T00:00:00.000Z",
      workerStartedAt: null,
      reportDataPreparedAt: "2026-10-04T00:00:02.000Z",
      elapsedToReportDataPreparationMs: 2000,
    },
    tenantOrigin: {
      schemaVersion: 1,
      verificationPolicy: "us-request-tenant-origin-v1",
      result: "not_attested",
      trustedSeed: null,
    },
    stamps: {
      profile: "US_FSMA204_PROCESSOR",
      timeZone: "America/New_York",
      baselineId: "codec-fixture-baseline",
      registryId: "fda_sortable_xlsx",
      registryVersion: 1,
      registryHash: "a".repeat(64),
      build: { apiVersion: "codec-fixture", gitSha: "a".repeat(40), dirty: false },
    },
    selectionSummary: {
      capturedRevisionCount: optional ? 1 : 0,
      workbookEventCount: optional ? 1 : 0,
      byType: { receiving: optional ? 1 : 0, transformation: 0, shipping: 0 },
      byLifecycle: {
        current_finalized: optional ? 1 : 0,
        historical_finalized: 0,
        draft: 0,
        void: 0,
      },
    },
    findingsSummary: {
      validation: { error: 0, warning: 0, info: 0 },
      render: { error: 0, warning: 0, info: 0 },
    },
    renderFindings: [],
    warningAcknowledgement: null,
    plan: optional ? { id, pdfSha256: hash(Buffer.from("KNOWN PLAN BYTES")) } : null,
    digests: { scopedContentDigest: "b".repeat(64), inputDigest: optional ? "c".repeat(64) : null },
    files: payloads.map(descriptor),
    missingFiles: optional
      ? []
      : [
          { name: "records.xlsx", code: "empty_selection" },
          { name: "plan.pdf", code: "plan_absent" },
        ],
  };
  return expected(manifest, payloads);
}
function expected(manifest: UsRequestManifestV1, payloads: UsRequestPackageByteFile[]) {
  manifest.files = payloads.map(descriptor);
  parseUsRequestManifest(manifest);
  const manifestFile = file("manifest.json", stableStringify(manifest));
  const covered = [...payloads, manifestFile];
  return {
    manifest,
    files: [
      ...covered,
      file("SHA256SUMS", covered.map((f) => `${f.sha256}  ${f.name}\n`).join("")),
    ],
  };
}
function entryHeaders(bytes: Buffer) {
  const eocd = bytes.length - 22;
  let central = bytes.readUInt32LE(eocd + 16);
  const entries: { local: number; central: number; name: string; data: number; size: number }[] =
    [];
  for (let i = 0; i < bytes.readUInt16LE(eocd + 10); i++) {
    const length = bytes.readUInt16LE(central + 28),
      local = bytes.readUInt32LE(central + 42);
    entries.push({
      central,
      local,
      name: bytes.subarray(central + 46, central + 46 + length).toString("ascii"),
      data: local + 30 + length,
      size: bytes.readUInt32LE(central + 24),
    });
    central += 46 + length;
  }
  return { eocd, entries };
}
// CRC is independently specified here; a stale/ignored CRC must fail even when hashes match.
function crc(bytes: Uint8Array) {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function failure(operation: () => unknown, code = "us_request_package_archive_invalid") {
  expect(operation).toThrow(expect.objectContaining({ response: { code }, status: 503 }));
}
afterEach(() => vi.restoreAllMocks());

describe("US canonical stored ZIP with known codec fixtures", () => {
  it.each([false, true])(
    "emits exact four/six-entry order and pinned local/central profile (optional %s)",
    async (optional) => {
      const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
      const want = fixture(optional),
        first = encodeUsRequestPackageArchive(want.files),
        second = encodeUsRequestPackageArchive(want.files);
      expect(first.bytes).toEqual(second.bytes);
      expect(first.sha256).toBe(hash(first.bytes));
      // Pinned known-byte golden after the independent header/CRC/range checks below.
      expect(first.sha256).toBe(
        optional
          ? "9bbaadfb66756f715d94f6c7e2adc464000230dd1641f42259c72075a06b88a5"
          : "41f31fc826f9676be188178eec05438bbafb77261a47f165166e4f335743603d",
      );
      expect(first.byteSize).toBe(first.bytes.length);
      expect(first.mediaType).toBe("application/zip");
      const { eocd, entries } = entryHeaders(first.bytes);
      expect(entries.map((e) => e.name)).toEqual(
        optional
          ? [
              "records.xlsx",
              "plan.pdf",
              "validation.json",
              "request-report.pdf",
              "manifest.json",
              "SHA256SUMS",
            ]
          : ["validation.json", "request-report.pdf", "manifest.json", "SHA256SUMS"],
      );
      expect(first.bytes.readUInt32LE(eocd)).toBe(0x06054b50);
      expect(first.bytes.subarray(eocd + 4, eocd + 8)).toEqual(Buffer.alloc(4));
      expect(first.bytes.readUInt16LE(eocd + 20)).toBe(0);
      let localEnd = 0,
        centralEnd = first.bytes.readUInt32LE(eocd + 16);
      for (const [i, entry] of entries.entries()) {
        const original = want.files[i];
        if (!original) throw new Error("Missing fixture");
        expect(entry.local).toBe(localEnd);
        expect(entry.central).toBe(centralEnd);
        expect(first.bytes.readUInt32LE(entry.local)).toBe(0x04034b50);
        expect(first.bytes.readUInt32LE(entry.central)).toBe(0x02014b50);
        expect(first.bytes.readUInt16LE(entry.central + 4)).toBe(20);
        for (const offset of [entry.local + 4, entry.central + 6]) {
          expect(first.bytes.readUInt16LE(offset)).toBe(20);
          expect(first.bytes.readUInt16LE(offset + 2)).toBe(0);
          expect(first.bytes.readUInt16LE(offset + 4)).toBe(0);
          expect(first.bytes.readUInt16LE(offset + 6)).toBe(0);
          expect(first.bytes.readUInt16LE(offset + 8)).toBe(33);
          expect(first.bytes.readUInt32LE(offset + 10)).toBe(crc(original.bytes));
          expect(first.bytes.readUInt32LE(offset + 14)).toBe(original.byteSize);
          expect(first.bytes.readUInt32LE(offset + 18)).toBe(original.byteSize);
        }
        expect(first.bytes.readUInt16LE(entry.local + 28)).toBe(0);
        expect(first.bytes.subarray(entry.central + 30, entry.central + 42)).toEqual(
          Buffer.alloc(12),
        );
        expect(first.bytes.subarray(entry.data, entry.data + entry.size)).toEqual(original.bytes);
        localEnd = entry.data + entry.size;
        centralEnd += 46 + entry.name.length;
      }
      expect(localEnd).toBe(first.bytes.readUInt32LE(eocd + 16));
      expect(centralEnd).toBe(eocd);
      expect(() => verifyUsRequestPackageArchive(first.bytes, want)).not.toThrow();
      const saved = Buffer.from(first.bytes);
      want.files[0]?.bytes.fill(0);
      expect(first.bytes).toEqual(saved);
    },
  );

  it.each([
    ["local signature", "local", 0, 4, 0],
    ["local version", "local", 4, 2, 45],
    ["local encryption", "local", 6, 2, 1],
    ["descriptor flag", "local", 6, 2, 8],
    ["UTF8 flag outside pinned profile", "local", 6, 2, 2048],
    ["compression", "local", 8, 2, 8],
    ["mtime", "local", 10, 2, 1],
    ["date", "local", 12, 2, 34],
    ["CRC", "local", 14, 4, 0],
    ["compressed length", "local", 18, 4, 0xffffffff],
    ["uncompressed length", "local", 22, 4, 0xffffffff],
    ["name length", "local", 26, 2, 65535],
    ["local extra/ZIP64", "local", 28, 2, 4],
    ["central signature", "central", 0, 4, 0],
    ["unix platform", "central", 4, 2, 0x0314],
    ["central version", "central", 6, 2, 45],
    ["central flags", "central", 8, 2, 1],
    ["central method", "central", 10, 2, 8],
    ["central time", "central", 12, 2, 1],
    ["central date", "central", 14, 2, 34],
    ["central CRC", "central", 16, 4, 0],
    ["central compressed size", "central", 20, 4, 0xffffffff],
    ["central size", "central", 24, 4, 0xffffffff],
    ["central name length", "central", 28, 2, 65535],
    ["central extra", "central", 30, 2, 4],
    ["file comment", "central", 32, 2, 1],
    ["disk", "central", 34, 2, 1],
    ["internal attrs", "central", 36, 2, 1],
    ["symlink attrs", "central", 38, 4, 0xa1ff0000],
    ["offset", "central", 42, 4, 0xffffffff],
    ["EOCD signature", "eocd", 0, 4, 0],
    ["multi-disk", "eocd", 4, 2, 1],
    ["central disk", "eocd", 6, 2, 1],
    ["count on disk", "eocd", 8, 2, 65535],
    ["ZIP64 count", "eocd", 10, 2, 65535],
    ["central size", "eocd", 12, 4, 0xffffffff],
    ["central offset", "eocd", 16, 4, 0xffffffff],
    ["archive comment", "eocd", 20, 2, 1],
  ] as const)(
    "rejects hostile %s before trusting extracted bytes",
    async (_label, header, offset, width, value) => {
      const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
      const want = fixture(),
        bytes = encodeUsRequestPackageArchive(want.files).bytes;
      const { eocd, entries } = entryHeaders(bytes),
        entry = entries[0];
      if (!entry) throw new Error("Missing entry");
      const base = header === "eocd" ? eocd : entry[header];
      if (width === 2) bytes.writeUInt16LE(value, base + offset);
      else bytes.writeUInt32LE(value, base + offset);
      const slicing = vi.spyOn(bytes, "subarray");
      failure(() => verifyUsRequestPackageArchive(bytes, want));
      if (value === 0xffffffff || value === 65535) expect(slicing).not.toHaveBeenCalled();
    },
  );

  it("rejects altered local/central names, dropped/added/swapped/duplicate entries and unsafe paths", async () => {
    const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
    const want = fixture(true);
    for (const names of [
      [...want.files.map((f) => f.name)].reverse(),
      want.files.slice(1).map((f) => f.name),
      [...want.files.map((f) => f.name), "extra.json"],
      ["../records.xx", ...want.files.slice(1).map((f) => f.name)],
      ["/records.xlsx", ...want.files.slice(1).map((f) => f.name)],
      ["a\\records.xlsx", ...want.files.slice(1).map((f) => f.name)],
    ]) {
      const entries: fflate.Zippable = {};
      for (const [i, name] of names.entries())
        entries[name] = [
          want.files[i]?.bytes ?? Buffer.from("extra"),
          { level: 0, mtime: new Date(1980, 0, 1), os: 0, attrs: 0 },
        ];
      failure(() => verifyUsRequestPackageArchive(fflate.zipSync(entries, { level: 0 }), want));
    }
    const original = encodeUsRequestPackageArchive(want.files).bytes,
      headers = entryHeaders(original),
      first = headers.entries[0],
      second = headers.entries[1];
    if (!first || !second) throw new Error("Missing entries");
    for (const at of [first.local + 30, first.central + 46]) {
      const bytes = Buffer.from(original);
      bytes[at] = 47;
      failure(() => verifyUsRequestPackageArchive(bytes, want));
    }
    // Duplicate fixed names without allowing an object-based unzip API to collapse them.
    const duplicate = Buffer.from(original);
    duplicate.write("plan.pdf", first.local + 30, "ascii");
    duplicate.write("plan.pdf", first.central + 46, "ascii");
    failure(() => verifyUsRequestPackageArchive(duplicate, want));
    for (const bytes of [
      original.subarray(0, original.length - 1),
      Buffer.concat([original, Buffer.from([0])]),
      Buffer.concat([Buffer.from([0]), original]),
    ])
      failure(() => verifyUsRequestPackageArchive(bytes, want));
  });

  it.each(["payload", "run", "tenant", "revision", "mode", "plan", "context"] as const)(
    "rejects coherently rehashed replacement %s against original expected authority",
    async (change) => {
      const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
      const original = fixture(true),
        replacement = fixture(true);
      const payloads = replacement.files.slice(0, -2);
      if (change === "payload") payloads[0] = file("records.xlsx", "REPLACED WORKBOOK");
      if (change === "run") replacement.manifest.identity.runId = id;
      if (change === "tenant") replacement.manifest.identity.tenantId = runId;
      if (change === "revision") replacement.manifest.identity.runRevision++;
      if (change === "mode") replacement.manifest.identity.mode = "available_records_incomplete";
      if (change === "plan") {
        payloads[1] = file("plan.pdf", "REPLACED PLAN");
        replacement.manifest.plan = { id, pdfSha256: hash(Buffer.from("REPLACED PLAN")) };
      }
      if (change === "context") {
        replacement.manifest.timing.reportDataPreparedAt = "2026-10-04T00:00:03.000Z";
        replacement.manifest.timing.elapsedToReportDataPreparationMs = 3000;
      }
      const coherent = expected(replacement.manifest, payloads),
        zip = encodeUsRequestPackageArchive(coherent.files);
      expect(() => verifyUsRequestPackageArchive(zip.bytes, coherent)).not.toThrow();
      failure(() => verifyUsRequestPackageArchive(zip.bytes, original));
    },
  );

  it.each([
    "JSON whitespace",
    "JSON unknown field",
    "validation noncanonical",
    "sums CRLF",
    "sums uppercase",
    "sums order",
    "sums missing",
    "sums self cycle",
    "manifest cycle",
    "wrong descriptor",
  ])("rejects noncanonical coverage: %s", async (change) => {
    const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
    const want = fixture();
    const changed: UsRequestPackageByteFile[] = want.files.map((f) => ({
      ...f,
      bytes: Buffer.from(f.bytes),
    }));
    const manifest = changed.find((f) => f.name === "manifest.json"),
      sums = changed.find((f) => f.name === "SHA256SUMS");
    if (!manifest || !sums) throw new Error("Missing metadata");
    if (change === "JSON whitespace")
      Object.assign(manifest, file("manifest.json", manifest.bytes.toString() + "\n"));
    if (change === "JSON unknown field")
      Object.assign(
        manifest,
        file("manifest.json", stableStringify({ ...want.manifest, extra: true })),
      );
    if (change === "validation noncanonical")
      changed[0] = file("validation.json", '{ "fixture":1}');
    if (change === "manifest cycle")
      Object.assign(
        manifest,
        file(
          "manifest.json",
          stableStringify({
            ...want.manifest,
            files: [...want.manifest.files, descriptor(manifest)],
          }),
        ),
      );
    if (change === "wrong descriptor") manifest.sha256 = "f".repeat(64);
    if (
      change.startsWith("JSON") ||
      change === "manifest cycle" ||
      change === "validation noncanonical"
    )
      Object.assign(
        sums,
        file(
          "SHA256SUMS",
          changed
            .slice(0, -1)
            .map((f) => `${f.sha256}  ${f.name}\n`)
            .join(""),
        ),
      );
    if (change === "sums CRLF")
      Object.assign(sums, file("SHA256SUMS", sums.bytes.toString().replaceAll("\n", "\r\n")));
    if (change === "sums uppercase")
      Object.assign(sums, file("SHA256SUMS", sums.bytes.toString().toUpperCase()));
    if (change === "sums order")
      Object.assign(
        sums,
        file("SHA256SUMS", sums.bytes.toString().trimEnd().split("\n").reverse().join("\n") + "\n"),
      );
    if (change === "sums missing")
      Object.assign(
        sums,
        file("SHA256SUMS", sums.bytes.toString().split("\n").slice(1).join("\n")),
      );
    if (change === "sums self cycle")
      Object.assign(
        sums,
        file("SHA256SUMS", sums.bytes.toString() + `${sums.sha256}  SHA256SUMS\n`),
      );
    failure(() => encodeUsRequestPackageArchive(changed));
    const entries: fflate.Zippable = {};
    for (const f of changed)
      entries[f.name] = [f.bytes, { level: 0, mtime: new Date(1980, 0, 1), os: 0, attrs: 0 }];
    if (change !== "wrong descriptor")
      failure(() => verifyUsRequestPackageArchive(fflate.zipSync(entries, { level: 0 }), want));
  });

  it("rejects stale or invalid expected manifests and descriptors rather than accepting archive claims", async () => {
    const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
    const want = fixture(),
      zip = encodeUsRequestPackageArchive(want.files);
    const wrongIdentity = fixture();
    wrongIdentity.manifest.identity.runRevision++;
    failure(() => verifyUsRequestPackageArchive(zip.bytes, wrongIdentity));
    const wrongHash = fixture();
    const first = wrongHash.files[0];
    if (!first) throw new Error("Missing file");
    first.sha256 = "f".repeat(64);
    failure(() => verifyUsRequestPackageArchive(zip.bytes, wrongHash));
  });

  it("rejects replacement of every payload, identity, manifest and sums even when all attacker checksums agree", async () => {
    const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
    const original = fixture(true),
      replacement = fixture(true);
    const payloads = [
      file("records.xlsx", "NEW WORKBOOK"),
      file("plan.pdf", "NEW PLAN"),
      file("validation.json", '{"fixture":2}'),
      file("request-report.pdf", "NEW REPORT"),
    ];
    replacement.manifest.identity = {
      ...replacement.manifest.identity,
      tenantId: runId,
      requestId: runId,
      requestRevision: 2,
      runId: id,
      runRevision: 2,
      mode: "available_records_incomplete",
    };
    replacement.manifest.plan = { id: runId, pdfSha256: hash(Buffer.from("NEW PLAN")) };
    replacement.manifest.timing.reportDataPreparedAt = "2026-10-04T00:00:04.000Z";
    replacement.manifest.timing.elapsedToReportDataPreparationMs = 4000;
    const coherent = expected(replacement.manifest, payloads),
      zip = encodeUsRequestPackageArchive(coherent.files);
    expect(() => verifyUsRequestPackageArchive(zip.bytes, coherent)).not.toThrow();
    failure(() => verifyUsRequestPackageArchive(zip.bytes, original));
  });

  it("rejects altered actual payload, stale CRC, and coherently forged local/central CRC", async () => {
    const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
    const want = fixture(true),
      original = encodeUsRequestPackageArchive(want.files).bytes;
    const first = entryHeaders(original).entries[0];
    if (!first) throw new Error("Missing entry");
    const bytes = Buffer.from(original),
      byte = bytes[first.data];
    if (byte === undefined) throw new Error("Missing byte");
    bytes[first.data] = byte ^ 1;
    failure(() => verifyUsRequestPackageArchive(bytes, want));
    const forgedCrc = crc(bytes.subarray(first.data, first.data + first.size));
    bytes.writeUInt32LE(forgedCrc, first.local + 14);
    bytes.writeUInt32LE(forgedCrc, first.central + 16);
    failure(() => verifyUsRequestPackageArchive(bytes, want));
  });

  it("sanitizes non-JSON codec exceptions without leaking a secondary serialization failure", async () => {
    const { encodeUsRequestPackageArchive } = await api();
    vi.mocked(fflate.zipSync).mockImplementationOnce(() => {
      throw new ServiceUnavailableException({
        unsupported: undefined,
        contact: "private@example.test",
      });
    });
    failure(() => encodeUsRequestPackageArchive(fixture().files));
  });

  it("checks reachable per-file maximum before encoding, rejecting +1 before zipSync", async () => {
    const { encodeUsRequestPackageArchive } = await api();
    const want = fixture(true),
      payloads = want.files.slice(0, -2);
    payloads[0] = file("records.xlsx", Buffer.alloc(limits.workbook, 1));
    const max = expected(want.manifest, payloads);
    expect(encodeUsRequestPackageArchive(max.files).byteSize).toBeGreaterThan(limits.workbook);
    const codec = vi.mocked(fflate.zipSync).mockClear();
    payloads[0] = file("records.xlsx", Buffer.alloc(limits.workbook + 1, 1));
    const over = [...payloads, ...max.files.slice(-2)];
    failure(() => encodeUsRequestPackageArchive(over), "us_request_package_size_limit");
    expect(codec).not.toHaveBeenCalled();
  });

  it.each([
    ["plan.pdf", "plan"],
    ["validation.json", "validation"],
    ["request-report.pdf", "report"],
    ["manifest.json", "manifest"],
    ["SHA256SUMS", "sums"],
  ] as const)("rejects actual oversized %s before codec allocation", async (name, limit) => {
    const { encodeUsRequestPackageArchive } = await api();
    const want = fixture(true),
      index = want.files.findIndex((f) => f.name === name);
    if (index < 0) throw new Error("Missing file");
    want.files[index] = file(name, Buffer.alloc(limits[limit] + 1, 1));
    const codec = vi.mocked(fflate.zipSync).mockClear();
    failure(() => encodeUsRequestPackageArchive(want.files), "us_request_package_size_limit");
    expect(codec).not.toHaveBeenCalled();
  });

  it.each(["plan.pdf", "request-report.pdf"] as const)(
    "accepts exact byte bound for known %s codec bytes",
    async (name) => {
      const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
      const want = fixture(true),
        payloads = want.files.slice(0, -2),
        index = payloads.findIndex((f) => f.name === name);
      if (index < 0) throw new Error("Missing payload");
      payloads[index] = file(
        name,
        Buffer.alloc(name === "plan.pdf" ? limits.plan : limits.report, 1),
      );
      if (name === "plan.pdf") want.manifest.plan = { id, pdfSha256: hash(payloads[index].bytes) };
      const bounded = expected(want.manifest, payloads),
        zip = encodeUsRequestPackageArchive(bounded.files);
      expect(() => verifyUsRequestPackageArchive(zip.bytes, bounded)).not.toThrow();
    },
  );

  it("uses restored test-only thresholds for unreachable default aggregate/ZIP caps before codec allocation", async () => {
    const { encodeUsRequestPackageArchive, verifyUsRequestPackageArchive } = await api();
    const want = fixture(true),
      total = want.files.reduce((sum, f) => sum + f.byteSize, 0),
      zipSize = total + want.files.reduce((sum, f) => sum + 76 + 2 * f.name.length, 22);
    // Strict individual caps sum below both default aggregate caps: no fabricated 48/64MiB valid artifact.
    const individualMax =
      limits.workbook +
      limits.plan +
      limits.validation +
      limits.report +
      limits.manifest +
      limits.sums;
    expect(individualMax).toBeLessThan(limits.entriesTotal);
    expect(individualMax + 2048).toBeLessThan(limits.zip);
    const savedTotal = Object.getOwnPropertyDescriptor(limits, "entriesTotal"),
      savedZip = Object.getOwnPropertyDescriptor(limits, "zip");
    if (!savedTotal || !savedZip) throw new Error("Missing thresholds");
    try {
      Object.defineProperty(limits, "entriesTotal", { value: total });
      Object.defineProperty(limits, "zip", { value: zipSize });
      const exact = encodeUsRequestPackageArchive(want.files);
      expect(exact.byteSize).toBe(zipSize);
      expect(() => verifyUsRequestPackageArchive(exact.bytes, want)).not.toThrow();
      const codec = vi.mocked(fflate.zipSync).mockClear();
      Object.defineProperty(limits, "entriesTotal", { value: total - 1 });
      failure(() => encodeUsRequestPackageArchive(want.files), "us_request_package_size_limit");
      expect(codec).not.toHaveBeenCalled();
      failure(() => verifyUsRequestPackageArchive(exact.bytes, want));
      Object.defineProperty(limits, "entriesTotal", { value: total });
      Object.defineProperty(limits, "zip", { value: zipSize - 1 });
      failure(() => encodeUsRequestPackageArchive(want.files), "us_request_package_size_limit");
      expect(codec).not.toHaveBeenCalled();
      failure(() => verifyUsRequestPackageArchive(exact.bytes, want));
    } finally {
      Object.defineProperty(limits, "entriesTotal", savedTotal);
      Object.defineProperty(limits, "zip", savedZip);
    }
  });
});

// Pure async ownership tests use a canonical empty frozen envelope + a held renderer seam.
// They are not the real default report/Receiving/Plan integration reserved for Task 5.
function inputs(): UsRequestPackageInputs {
  const manifest = fixture().manifest;
  const request = {
    id,
    revision: 1,
    requestNumber: "CODEC-EMPTY",
    requesterName: "Synthetic codec",
    requesterOrganization: null,
    requesterContact: "private@example.test",
    receivedAt: "2026-10-04T00:00:00Z",
    dueAt: "2026-10-05T00:00:00Z",
    alternateDeadlineReason: null,
  };
  const snapshot = {
    schemaVersion: 2 as const,
    tenantId: id,
    request,
    selection: {
      scope: { tlcs: ["EMPTY-CODEC"] },
      seeds: [],
      records: [],
      lotIds: [],
      relations: [],
    },
    sources: [],
    matches: [],
    genealogy: [],
    lots: [],
    lifecycle: [],
    findings: [],
    plan: null,
    tenantOrigin: manifest.tenantOrigin,
    ...manifest.stamps,
  };
  const frozen = {
    schemaVersion: 2,
    selectionKind: "empty",
    mode: "available_records_incomplete",
    generatedAt: manifest.timing.preparationStartedAt,
    preparedBy: manifest.identity.preparedBy,
    validationSnapshot: snapshot,
    exportInput: null,
    warningAcknowledgement: null,
  };
  const validation = file("validation.json", stableStringify(frozen));
  const model: UsRequestReportModel = {
    schemaVersion: 1,
    identity: manifest.identity,
    request,
    scope: snapshot.selection.scope,
    timing: manifest.timing,
    tenantOrigin: manifest.tenantOrigin,
    stamps: manifest.stamps,
    selectionSummary: manifest.selectionSummary,
    findingsSummary: manifest.findingsSummary,
    renderFindings: [],
    warningAcknowledgement: null,
    plan: null,
    digests: { scopedContentDigest: canonicalExportDigest(snapshot), inputDigest: null },
    preReportFiles: [descriptor(validation)],
    missingFiles: manifest.missingFiles,
  };
  return { model, preReportFiles: [validation] };
}
describe("US package composer synchronous ownership and sanitized failures", () => {
  it("owns every bound model/file before await and returns independently mutable views", async () => {
    const { assembleUsRequestPackage } = await composer();
    const original = inputs(),
      trustedModel = structuredClone(original.model),
      trustedBytes = Buffer.from(original.preReportFiles[0]?.bytes ?? []);
    const report = file("request-report.pdf", "KNOWN HELD REPORT");
    let release: ((value: typeof report) => void) | undefined;
    const held = new Promise<typeof report>((resolve) => {
      release = resolve;
    });
    let rendered: UsRequestReportModel | undefined;
    vi.spyOn(renderer, "renderUsRequestReportPdf").mockImplementation((m) => {
      rendered = m;
      return held;
    });
    const pending = assembleUsRequestPackage(original);
    void pending.catch(() => undefined);
    original.model.identity.runId = id;
    original.model.request.requesterName = "MUTATED";
    original.model.timing.reportDataPreparedAt = "2030-01-01T00:00:00.000Z";
    original.preReportFiles[0]?.bytes.fill(0);
    expect(rendered).toEqual(trustedModel);
    if (!release) throw new Error("Renderer not held");
    release(report);
    const result = await pending;
    expect(result.runId).toBe(runId);
    expect(result.manifest.identity).toEqual(trustedModel.identity);
    expect(result.manifest.timing).toEqual(trustedModel.timing);
    const validation = result.files.find((f) => f.name === "validation.json"),
      reportView = result.files.find((f) => f.name === "request-report.pdf"),
      manifestView = result.files.find((f) => f.name === "manifest.json"),
      sums = result.files.find((f) => f.name === "SHA256SUMS");
    if (!validation || !reportView || !manifestView || !sums) throw new Error("Missing result");
    expect(validation.bytes).toEqual(trustedBytes);
    const archive = Buffer.from(result.zip.bytes),
      manifestBytes = Buffer.from(manifestView.bytes),
      sumsBytes = Buffer.from(sums.bytes),
      reportBytes = Buffer.from(reportView.bytes);
    report.bytes.fill(0);
    expect(reportView.bytes).toEqual(reportBytes);
    validation.bytes.fill(0);
    reportView.bytes.fill(0);
    result.manifest.identity.runId = id;
    expect(result.zip.bytes).toEqual(archive);
    expect(manifestView.bytes).toEqual(manifestBytes);
    expect(sums.bytes).toEqual(sumsBytes);
    result.zip.bytes.fill(0);
    expect(manifestView.bytes).toEqual(manifestBytes);
    expect(sums.bytes).toEqual(sumsBytes);
  });

  it.each([
    "size",
    "hash",
    "media",
    "order",
    "extra input",
    "extra file",
    "model",
    "descriptor",
    "getter",
  ])("rejects invalid %s synchronously before renderer work", async (change) => {
    const { assembleUsRequestPackage } = await composer();
    const original = inputs(),
      first = original.preReportFiles[0];
    if (!first) throw new Error("Missing input");
    if (change === "size") first.byteSize++;
    if (change === "hash") first.bytes.fill(0);
    if (change === "media") first.mediaType = "application/octet-stream";
    if (change === "order") original.preReportFiles = [];
    if (change === "extra input") Object.assign(original, { extra: true });
    if (change === "extra file") Object.assign(first, { extra: true });
    if (change === "model") original.model.identity.runRevision = 0;
    if (change === "descriptor") original.model.preReportFiles = [];
    if (change === "getter")
      Object.defineProperty(original, "model", {
        get: () => {
          throw new Error("private@example.test");
        },
      });
    const render = vi.spyOn(renderer, "renderUsRequestReportPdf");
    await expect(assembleUsRequestPackage(original)).rejects.toHaveProperty("status", 503);
    expect(render).not.toHaveBeenCalled();
  });

  it("sanitizes technical renderer exceptions and never returns a partial package", async () => {
    const { assembleUsRequestPackage } = await composer();
    vi.spyOn(renderer, "renderUsRequestReportPdf").mockRejectedValue(
      new Error("private@example.test object://private"),
    );
    await expect(assembleUsRequestPackage(inputs())).rejects.toMatchObject({
      response: { code: "us_request_report_render_failed" },
      status: 503,
    });
  });

  it("retains the finite model error class rather than relabeling invalid models", async () => {
    const { assembleUsRequestPackage } = await composer();
    const original = inputs();
    original.model.identity.runRevision = 0;
    await expect(assembleUsRequestPackage(original)).rejects.toMatchObject({
      response: { code: "us_request_package_model_invalid" },
      status: 503,
    });
  });

  it("sanitizes non-JSON renderer exception responses without a secondary serialization failure", async () => {
    const { assembleUsRequestPackage } = await composer();
    const privateResponse = { contact: "private@example.test", unsupported: undefined };
    vi.spyOn(renderer, "renderUsRequestReportPdf").mockRejectedValue(
      new ServiceUnavailableException(privateResponse),
    );
    await expect(assembleUsRequestPackage(inputs())).rejects.toMatchObject({
      response: { code: "us_request_report_render_failed" },
      status: 503,
    });
  });
});
