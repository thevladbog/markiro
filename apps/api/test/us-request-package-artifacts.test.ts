import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsWorkerObjectEvidence } from "../src/modules/traceability/requests/us-request-worker-types";
import { createUsRequestWorkerStorageFixture } from "./support/us-request-worker-storage-fixture";

const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
};
const attemptId = "33333333-3333-4333-8333-333333333333";
const bytes = Buffer.from("synthetic private package");
const evidence = (data: Uint8Array = bytes): UsWorkerObjectEvidence => ({
  ...scope,
  id: "44444444-4444-4444-8444-444444444444",
  attemptId,
  name: "manifest.json",
  kind: "manifest",
  mediaType: "application/json",
  objectKey: `us/requests/${scope.tenantId}/${scope.runId}/${attemptId}/manifest.json`,
  byteSize: data.byteLength,
  sha256: createHash("sha256").update(data).digest("hex"),
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded private request package storage", () => {
  it("conditionally creates, reads actual bytes and never overwrites a collision", async () => {
    const s = createUsRequestWorkerStorageFixture();
    try {
      await s.store.putVerified(scope, evidence(), bytes);
      expect(await s.store.readVerified(scope, evidence())).toEqual(bytes);
      await expect(s.store.putVerified(scope, evidence(), bytes)).rejects.toMatchObject({
        message: "us_request_package_storage_collision",
      });
      expect(s.objects.size).toBe(1);
      expect(s.calls.map((call) => call.kind)).toEqual(["put", "get", "get", "put"]);
      const put = s.calls[0]?.command;
      expect(put).toBeInstanceOf(PutObjectCommand);
      if (!(put instanceof PutObjectCommand)) throw new Error("put missing");
      expect(put.input).toMatchObject({
        Key: evidence().objectKey,
        IfNoneMatch: "*",
        ContentLength: bytes.length,
        ContentType: "application/json",
      });
      expect(put.input.ACL).toBeUndefined();
      expect(s.bodies.every((body) => body.destroyed)).toBe(true);
      expect(s.calls.every((call) => call.signal.aborted)).toBe(true);
    } finally {
      s.destroy();
    }
  });

  it("copies caller buffers before the first await", async () => {
    let release: (() => void) | undefined;
    const s = createUsRequestWorkerStorageFixture((transport) => ({
      async send(command, options) {
        if (command instanceof PutObjectCommand)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return transport.send(command, options);
      },
    }));
    try {
      const input = Buffer.from(bytes),
        expected = evidence(input);
      const pending = s.store.putVerified(scope, expected, input);
      input.fill(0);
      release?.();
      await pending;
      expect(await s.store.readVerified(scope, expected)).toEqual(bytes);
    } finally {
      s.destroy();
    }
  });

  it.each(["put", "read", "delete"] as const)(
    "rejects foreign and malformed evidence before %s transport",
    async (operation) => {
      const s = createUsRequestWorkerStorageFixture();
      try {
        for (const invalid of [
          {
            ...evidence(),
            tenantId: "55555555-5555-4555-8555-555555555555",
            objectKey: evidence().objectKey.replace(
              scope.tenantId,
              "55555555-5555-4555-8555-555555555555",
            ),
          },
          { ...evidence(), objectKey: "us/plans/private.pdf" },
          { ...evidence(), attemptId: "../private" },
          { ...evidence(), name: "SHA256SUMS" },
          { ...evidence(), kind: "plan_pdf" },
          { ...evidence(), mediaType: "text/plain" },
          { ...evidence(), sha256: "secret" },
          { ...evidence(), privateKey: "secret" },
        ]) {
          // The external boundary must handle malformed persisted data too.
          const value = invalid as UsWorkerObjectEvidence;
          await expect(
            operation === "put"
              ? s.store.putVerified(scope, value, bytes)
              : operation === "read"
                ? s.store.readVerified(scope, value)
                : s.store.removeFenced(scope, value),
          ).rejects.toThrow(/^us_request_package_storage_(evidence|scope)_invalid$/);
        }
        expect(s.calls).toHaveLength(0);
      } finally {
        s.destroy();
      }
    },
  );

  it("rejects byte mismatch before upload and accepts the exact manifest bound", async () => {
    const s = createUsRequestWorkerStorageFixture();
    try {
      await expect(s.store.putVerified(scope, evidence(), Buffer.from("wrong"))).rejects.toThrow(
        "us_request_package_storage_checksum_mismatch",
      );
      expect(s.calls).toHaveLength(0);
      const exact = Buffer.alloc(1_048_576, 65);
      await s.store.putVerified(scope, evidence(exact), exact);
      const oversized = Buffer.alloc(1_048_577, 65);
      await expect(s.store.putVerified(scope, evidence(oversized), oversized)).rejects.toThrow(
        "us_request_package_storage_evidence_invalid",
      );
      expect(s.objects.size).toBe(1);
    } finally {
      s.destroy();
    }
  });

  it.each([
    "wrong-type",
    "lying-length",
    "truncated",
    "oversized",
    "wrong-hash",
    "stream-failure",
    "invalid-chunk",
  ])("rejects %s read-back and closes its body", async (fault) => {
    const body =
      fault === "stream-failure"
        ? Readable.from(
            (async function* () {
              yield bytes.subarray(0, 1);
              throw new Error("private provider content");
            })(),
          )
        : Readable.from([
            fault === "truncated"
              ? bytes.subarray(0, 1)
              : fault === "oversized"
                ? Buffer.alloc(bytes.length + 1)
                : fault === "wrong-hash"
                  ? Buffer.alloc(bytes.length)
                  : fault === "invalid-chunk"
                    ? "private chunk"
                    : bytes,
          ]);
    const s = createUsRequestWorkerStorageFixture((transport) => ({
      async send(command, options) {
        if (command instanceof GetObjectCommand)
          return {
            Body: body,
            ContentType: fault === "wrong-type" ? "text/plain" : "application/json",
            ContentLength: fault === "lying-length" ? 1 : bytes.length,
          };
        return transport.send(command, options);
      },
    }));
    try {
      await expect(s.store.putVerified(scope, evidence(), bytes)).rejects.toThrow(
        /^us_request_package_storage_(evidence_invalid|checksum_mismatch|read_failed)$/,
      );
      expect(body.destroyed).toBe(true);
      expect(s.objects.size).toBe(1);
    } finally {
      s.destroy();
      body.destroy();
    }
  });

  it("does not use HEAD metadata as byte verification", async () => {
    const s = createUsRequestWorkerStorageFixture();
    try {
      await s.store.putVerified(scope, evidence(), bytes);
      const stored = s.objects.get(evidence().objectKey);
      if (!stored) throw new Error("object missing");
      stored.bytes.fill(0);
      await expect(s.store.readVerified(scope, evidence())).rejects.toThrow(
        "us_request_package_storage_checksum_mismatch",
      );
    } finally {
      s.destroy();
    }
  });

  it("deletes only the validated package key and repeats missing deletion safely", async () => {
    const s = createUsRequestWorkerStorageFixture();
    try {
      await s.store.putVerified(scope, evidence(), bytes);
      s.objects.set("us/plans/original.pdf", { bytes, contentType: "application/pdf" });
      await s.store.removeFenced(scope, evidence());
      await s.store.removeFenced(scope, evidence());
      expect([...s.objects.keys()]).toEqual(["us/plans/original.pdf"]);
      expect(
        s.calls
          .filter((call) => call.kind === "delete")
          .every((call) => call.command.input.Key === evidence().objectKey),
      ).toBe(true);
    } finally {
      s.destroy();
    }
  });

  it.each([
    [{ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }, null],
    [new Error("private provider key credentials"), "us_request_package_storage_delete_failed"],
  ] as const)("handles finite deletion outcomes without provider details", async (error, code) => {
    const s = createUsRequestWorkerStorageFixture(() => ({
      async send() {
        throw error;
      },
    }));
    try {
      if (code === null)
        await expect(s.store.removeFenced(scope, evidence())).resolves.toBeUndefined();
      else
        await expect(s.store.removeFenced(scope, evidence())).rejects.toThrow(
          new RegExp(`^${code}$`),
        );
    } finally {
      s.destroy();
    }
  });

  it("destroy aborts live body I/O and clears its timer", async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    const s = createUsRequestWorkerStorageFixture(() => ({
      async send() {
        return { Body: body, ContentType: "application/json", ContentLength: bytes.length };
      },
    }));
    try {
      const outcome = s.store.readVerified(scope, evidence()).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      s.store.destroy();
      s.store.destroy();
      expect(await outcome).toMatchObject({ message: "us_request_package_storage_timeout" });
      expect(body.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await expect(s.store.readVerified(scope, evidence())).rejects.toThrow(
        "us_request_worker_unknown_failure",
      );
    } finally {
      s.destroy();
      body.destroy();
    }
  });

  it.each(["put", "get", "body", "delete"])(
    "bounds %s to 15 seconds, aborts and clears timers",
    async (boundary) => {
      vi.useFakeTimers();
      const body = new Readable({ read() {} });
      let signal: AbortSignal | undefined;
      const s = createUsRequestWorkerStorageFixture((transport) => ({
        async send(command, options) {
          if (
            (boundary === "put" && command instanceof PutObjectCommand) ||
            (boundary === "get" && command instanceof GetObjectCommand) ||
            (boundary === "delete" && command instanceof DeleteObjectCommand)
          ) {
            signal = options.abortSignal;
            return new Promise<never>(() => {});
          }
          if (boundary === "body" && command instanceof GetObjectCommand) {
            signal = options.abortSignal;
            return { Body: body, ContentType: "application/json", ContentLength: bytes.length };
          }
          return transport.send(command, options);
        },
      }));
      try {
        const pending =
          boundary === "delete"
            ? s.store.removeFenced(scope, evidence())
            : s.store.putVerified(scope, evidence(), bytes);
        const outcome = pending.then(
          () => null,
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await outcome).toMatchObject({ message: "us_request_package_storage_timeout" });
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        if (boundary === "body") expect(body.destroyed).toBe(true);
      } finally {
        s.destroy();
        body.destroy();
      }
    },
  );

  it("closes a late GET body without returning post-abort evidence", async () => {
    vi.useFakeTimers();
    let release: ((value: unknown) => void) | undefined;
    const s = createUsRequestWorkerStorageFixture((transport) => ({
      async send(command, options) {
        if (command instanceof GetObjectCommand)
          return new Promise((resolve) => {
            release = resolve;
          });
        return transport.send(command, options);
      },
    }));
    try {
      const pending = s.store.putVerified(scope, evidence(), bytes);
      const outcome = pending.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await outcome).toMatchObject({ message: "us_request_package_storage_timeout" });
      const body = Readable.from([bytes]);
      release?.({ Body: body, ContentType: "application/json", ContentLength: bytes.length });
      await vi.advanceTimersByTimeAsync(0);
      expect(body.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      s.destroy();
    }
  });

  it("sanitizes unknown provider errors and only classifies positive transport failures", async () => {
    for (const [error, code] of [
      [new Error("private key credentials provider response"), "us_request_worker_unknown_failure"],
      [{ code: "ECONNRESET", message: "private" }, "us_request_package_storage_transport_failed"],
    ] as const) {
      const s = createUsRequestWorkerStorageFixture(() => ({
        async send() {
          throw error;
        },
      }));
      try {
        await expect(s.store.putVerified(scope, evidence(), bytes)).rejects.toThrow(
          new RegExp(`^${code}$`),
        );
      } finally {
        s.destroy();
      }
    }
  });

  it("returns a generic iterator on timeout even when next never settles", async () => {
    vi.useFakeTimers();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: returned,
        };
      },
    };
    const s = createUsRequestWorkerStorageFixture(() => ({
      async send() {
        return { Body: body, ContentType: "application/json", ContentLength: bytes.length };
      },
    }));
    try {
      const outcome = s.store.readVerified(scope, evidence()).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await outcome).toMatchObject({ message: "us_request_package_storage_timeout" });
      expect(returned).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      s.destroy();
    }
  });

  it("rejects a late result when blocked work delays the timer callback", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const s = createUsRequestWorkerStorageFixture((transport) => ({
      async send(command, options) {
        if (command instanceof PutObjectCommand) elapsed = 15_001;
        return transport.send(command, options);
      },
    }));
    try {
      await expect(s.store.putVerified(scope, evidence(), bytes)).rejects.toThrow(
        "us_request_package_storage_timeout",
      );
      expect(s.calls.map((call) => call.kind)).toEqual(["put"]);
    } finally {
      s.destroy();
    }
  });

  it.each([
    [
      "records.xlsx",
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      16_777_216,
    ],
    ["plan.pdf", "plan_pdf", "application/pdf", 8_000_000],
    ["validation.json", "validation_report", "application/json", 16_777_216],
    ["request-report.pdf", "request_report", "application/pdf", 4_194_304],
    ["manifest.json", "manifest", "application/json", 1_048_576],
    ["package.zip", "package_zip", "application/zip", 67_108_864],
  ] as const)(
    "enforces the exact %s file limit with actual read-back",
    async (name, kind, mediaType, limit) => {
      const s = createUsRequestWorkerStorageFixture();
      try {
        const exact = Buffer.alloc(limit, 65);
        const item: UsWorkerObjectEvidence = {
          ...evidence(exact),
          name,
          kind,
          mediaType,
          objectKey: `us/requests/${scope.tenantId}/${scope.runId}/${attemptId}/${name}`,
        };
        await s.store.putVerified(scope, item, exact);
        expect(s.objects.get(item.objectKey)?.bytes.length).toBe(limit);
        await expect(
          s.store.putVerified(scope, { ...item, byteSize: limit + 1 }, exact),
        ).rejects.toThrow("us_request_package_storage_evidence_invalid");
        expect(s.calls.map((call) => call.kind)).toEqual(["put", "get"]);
      } finally {
        s.destroy();
      }
    },
  );
});
