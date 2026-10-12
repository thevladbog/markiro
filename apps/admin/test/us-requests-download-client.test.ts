import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { readUsRequestArtifactResponse } from "../src/us/requests/artifact-transport.js";
import type { UsRequestArtifact } from "../src/us/requests/types.js";

const runId = "b0000000-0000-4000-8000-000000000002";
const sample = new TextEncoder().encode("published bytes");
const kinds = [
  {
    kind: "xlsx",
    name: "records.xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    cap: 16 * 1024 * 1024,
  },
  { kind: "plan_pdf", name: "plan.pdf", mediaType: "application/pdf", cap: 8_000_000 },
  {
    kind: "validation_report",
    name: "validation.json",
    mediaType: "application/json",
    cap: 16 * 1024 * 1024,
  },
  {
    kind: "request_report",
    name: "request-report.pdf",
    mediaType: "application/pdf",
    cap: 4 * 1024 * 1024,
  },
  { kind: "manifest", name: "manifest.json", mediaType: "application/json", cap: 1024 * 1024 },
  { kind: "package_zip", name: "package.zip", mediaType: "application/zip", cap: 64 * 1024 * 1024 },
] as const;
function descriptor(file: (typeof kinds)[number], bytes = sample): UsRequestArtifact {
  return {
    kind: file.kind,
    name: file.name,
    mediaType: file.mediaType,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  } as UsRequestArtifact;
}
function artifactResponse(
  file: UsRequestArtifact,
  body: BodyInit | null = sample,
  headers: Record<string, string> = {},
  status = 200,
) {
  return new Response(body, {
    status,
    headers: {
      "content-type": file.mediaType,
      "content-disposition": `attachment; filename="${file.name}"`,
      "content-length": String(file.byteSize),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
function download(response: Response, file = descriptor(kinds[4]), signal?: AbortSignal) {
  return createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(response)).requests.download(
    runId,
    file,
    signal,
  );
}
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Mutations caught: removing download, widening fixed descriptors/routes, failing
// to check headers/actual bytes/hash, moving deadline cleanup before body/hash,
// and dropping cancellation or lock release. Hash expectations use node:crypto,
// independently of the production WebCrypto implementation.
describe("descriptor-verified Requests downloads", () => {
  for (const file of kinds) {
    it(`${file.kind}: returns exact bytes, fixed name and digest through a single authenticated GET`, async () => {
      const evidence = descriptor(file);
      const send = vi.fn<typeof fetch>().mockResolvedValue(artifactResponse(evidence));
      const result = await createUsBrowserClient(send).requests.download(runId, evidence);
      expect(Array.from(result.bytes)).toEqual(Array.from(sample));
      expect(result).toMatchObject({ filename: file.name, sha256: evidence.sha256 });
      expect(send.mock.calls).toEqual([
        [
          `/api/us/traceability/export-runs/${runId}/artifacts/${file.kind}`,
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: expect.any(AbortSignal),
          },
        ],
      ]);
    });
    it(`${file.kind}: accepts the exact cap`, async () => {
      const bytes = new Uint8Array(file.cap);
      bytes[0] = 7;
      bytes[file.cap - 1] = 9;
      const evidence = descriptor(file, bytes);
      const result = await download(artifactResponse(evidence, bytes), evidence);
      expect(result.bytes.byteLength).toBe(file.cap);
      expect(result.bytes[0]).toBe(7);
      expect(result.bytes[file.cap - 1]).toBe(9);
      expect(result.sha256).toBe(evidence.sha256);
    });
    it(`${file.kind}: refuses cap+1 descriptors before sending`, async () => {
      const send = vi.fn<typeof fetch>();
      await expect(
        createUsBrowserClient(send).requests.download(runId, {
          ...descriptor(file),
          byteSize: file.cap + 1,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(send).not.toHaveBeenCalled();
    });
    it(`${file.kind}: cancels actual cap+1 bytes before concatenation or hash`, async () => {
      const bytes = new Uint8Array(file.cap);
      const evidence = descriptor(file, bytes);
      let cancelled = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled++;
        },
      });
      const digest = vi.spyOn(webcrypto.subtle, "digest");
      await expect(download(artifactResponse(evidence, stream), evidence)).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(cancelled).toBe(1);
      expect(stream.locked).toBe(false);
      expect(digest).not.toHaveBeenCalled();
    });
    it(`${file.kind}: rejects an incorrect declared length before consuming bytes`, async () => {
      const evidence = descriptor(file);
      await expect(
        download(artifactResponse(evidence, sample, { "content-length": "1" }), evidence),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });
    it(`${file.kind}: rejects a truncated stream and releases its reader`, async () => {
      const evidence = descriptor(file);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(sample.subarray(0, 2));
          c.close();
        },
      });
      await expect(download(artifactResponse(evidence, stream), evidence)).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(stream.locked).toBe(false);
    });
    it(`${file.kind}: rejects a different digest after real hashing`, async () => {
      const evidence = { ...descriptor(file), sha256: "0".repeat(64) };
      await expect(download(artifactResponse(evidence), evidence)).rejects.toMatchObject({
        code: "invalid_response",
      });
    });
    it(`${file.kind}: rejects a different filename`, async () => {
      const evidence = descriptor(file);
      await expect(
        download(
          artifactResponse(evidence, sample, {
            "content-disposition": 'attachment; filename="other.pdf"',
          }),
          evidence,
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });
    it(`${file.kind}: rejects non-JSON MIME parameters`, async () => {
      const evidence = descriptor(file);
      await expect(
        download(
          artifactResponse(evidence, sample, {
            "content-type": `${file.mediaType}; boundary=private`,
          }),
          evidence,
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });
    for (const header of [
      "content-length",
      "content-disposition",
      "content-type",
      "cache-control",
      "x-content-type-options",
    ]) {
      it(`${file.kind}: refuses missing ${header}`, async () => {
        const evidence = descriptor(file);
        const response = artifactResponse(evidence);
        response.headers.delete(header);
        await expect(download(response, evidence)).rejects.toMatchObject({
          code: "invalid_response",
        });
      });
    }
    it.each(["-1", "1.5", "015", "15, 15"])(
      `${file.kind}: refuses malformed length %s`,
      async (length) => {
        const evidence = descriptor(file);
        await expect(
          download(artifactResponse(evidence, sample, { "content-length": length }), evidence),
        ).rejects.toMatchObject({ code: "invalid_response" });
      },
    );
    it.each(["opaque", "redirected", "206"])(`${file.kind}: refuses %s release`, async (mode) => {
      const evidence = descriptor(file);
      const response = artifactResponse(evidence, sample, {}, mode === "206" ? 206 : 200);
      if (mode === "redirected") Object.defineProperty(response, "redirected", { value: true });
      if (mode === "opaque") Object.defineProperty(response, "type", { value: "opaque" });
      await expect(download(response, evidence)).rejects.toMatchObject({
        code: "invalid_response",
      });
    });
  }
  it.each(["", "-1", "1.5", "015", "+15", "15, 15", "9007199254740993"])(
    "rejects malformed Content-Length %j",
    async (length) => {
      const evidence = descriptor(kinds[4]);
      await expect(
        download(artifactResponse(evidence, sample, { "content-length": length })),
      ).rejects.toMatchObject({ code: "invalid_response" });
    },
  );
  it.each([
    "content-length",
    "content-disposition",
    "content-type",
    "cache-control",
    "x-content-type-options",
  ])("rejects missing %s", async (header) => {
    const response = artifactResponse(descriptor(kinds[4]));
    response.headers.delete(header);
    await expect(download(response)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([
    { "content-disposition": 'inline; filename="manifest.json"' },
    { "content-disposition": "attachment; filename=manifest.json" },
    { "content-disposition": "attachment; filename*=UTF-8''manifest.json" },
    { "content-disposition": 'attachment; filename="../manifest.json"' },
    { "content-type": "text/html" },
    { "content-type": "application/json; charset=iso-8859-1" },
    { "content-type": "application/json; charset=utf-8; boundary=a" },
    { "cache-control": "public, max-age=0" },
    { "x-content-type-options": "sniff" },
  ])("rejects inconsistent release headers %j", async (headers) => {
    await expect(
      download(artifactResponse(descriptor(kinds[4]), sample, headers)),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([kinds[2], kinds[4]])("allows only utf-8 JSON charset for $kind", async (file) => {
    const evidence = descriptor(file);
    expect(
      Array.from(
        (
          await download(
            artifactResponse(evidence, sample, {
              "content-type": "application/json; charset=utf-8",
            }),
            evidence,
          )
        ).bytes,
      ),
    ).toEqual(Array.from(sample));
  });
  it.each([kinds[0], kinds[1], kinds[3], kinds[5]])(
    "rejects even charset on non-JSON $kind",
    async (file) => {
      const evidence = descriptor(file);
      await expect(
        download(
          artifactResponse(evidence, sample, {
            "content-type": `${file.mediaType}; charset=utf-8`,
          }),
          evidence,
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    },
  );
  it.each(["opaque", "opaqueredirect", "redirected", "206", "absent body"])(
    "rejects %s responses",
    async (mode) => {
      const response = artifactResponse(
        descriptor(kinds[4]),
        mode === "absent body" ? null : sample,
        {},
        mode === "206" ? 206 : 200,
      );
      if (mode === "redirected") Object.defineProperty(response, "redirected", { value: true });
      if (mode.startsWith("opaque")) Object.defineProperty(response, "type", { value: mode });
      await expect(download(response)).rejects.toMatchObject({ code: "invalid_response" });
    },
  );
  it("assembles one-byte chunks and releases the successful reader", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const byte of sample) c.enqueue(new Uint8Array([byte]));
        c.close();
      },
    });
    expect(
      Array.from((await download(artifactResponse(descriptor(kinds[4]), stream))).bytes),
    ).toEqual(Array.from(sample));
    expect(stream.locked).toBe(false);
  });
  it("bounds actual bytes to descriptor size independently of kind cap and survives cancel rejection", async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sample);
        c.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled++;
        return Promise.reject(new Error("private cancellation"));
      },
    });
    const digest = vi.spyOn(webcrypto.subtle, "digest");
    await expect(download(artifactResponse(descriptor(kinds[4]), stream))).rejects.toMatchObject({
      code: "invalid_response",
      message: "invalid_response",
    });
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(digest).not.toHaveBeenCalled();
  });
  it("hides raw stream failures and releases its lock", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("private storage details"));
      },
    });
    await expect(download(artifactResponse(descriptor(kinds[4]), stream))).rejects.toMatchObject({
      code: "unavailable",
      message: "unavailable",
    });
    expect(stream.locked).toBe(false);
  });
  it("hides raw crypto failures", async () => {
    vi.spyOn(webcrypto.subtle, "digest").mockRejectedValue(new Error("private crypto details"));
    await expect(download(artifactResponse(descriptor(kinds[4])))).rejects.toMatchObject({
      code: "unavailable",
      message: "unavailable",
    });
  });
  it("validates headers before reading and cancels/releases the rejected reader", async () => {
    let pulls = 0;
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(sample);
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      readUsRequestArtifactResponse(
        artifactResponse(descriptor(kinds[4]), stream, {
          "content-disposition": 'inline; filename="manifest.json"',
        }),
        descriptor(kinds[4]),
        {
          signal: controller.signal,
          makeError: (code) => Object.assign(new Error(code), { code }),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_response", message: "invalid_response" });
    expect(pulls).toBe(0);
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  for (const path of ["status206", "owned invalid header"] as const) {
    it.each(["external abort", "deadline"])(
      `${path}: never-settling cancellation cannot block safe failure or disposal after %s`,
      async (stop) => {
        vi.useFakeTimers();
        let cancelled = 0;
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
            return new Promise<never>(() => {});
          },
        });
        const evidence = descriptor(kinds[4]);
        const response = artifactResponse(
          evidence,
          stream,
          path === "owned invalid header" ? { "content-type": "text/html" } : {},
          path === "status206" ? 206 : 200,
        );
        const controller = new AbortController();
        const removeExternal = vi.spyOn(controller.signal, "removeEventListener");
        const removedTransport: ReturnType<typeof vi.spyOn>[] = [];
        const send = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
          if (init?.signal) removedTransport.push(vi.spyOn(init.signal, "removeEventListener"));
          return response;
        });
        const outcomes: unknown[] = [];
        void createUsBrowserClient(send)
          .requests.download(runId, evidence, controller.signal)
          .then(
            (value) => outcomes.push({ state: "resolved", value }),
            (error: unknown) => outcomes.push({ state: "rejected", error }),
          );
        await vi.advanceTimersByTimeAsync(0);
        expect(cancelled).toBe(1);
        if (stop === "external abort") controller.abort(new Error("private abort reason"));
        else await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(outcomes).toEqual([
          {
            state: "rejected",
            error: expect.objectContaining({
              code: "invalid_response",
              message: "invalid_response",
            }),
          },
        ]);
        expect(outcomes[0]).not.toHaveProperty("error.cause");
        expect(stream.locked).toBe(false);
        expect(removeExternal).toHaveBeenCalledWith("abort", expect.any(Function));
        if (path === "owned invalid header")
          expect(removedTransport[0]).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  }
  it("safely rejects an already locked reader without taking its ownership", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const response = artifactResponse(descriptor(kinds[4]), stream);
    const reader = stream.getReader();
    try {
      await expect(
        readUsRequestArtifactResponse(response, descriptor(kinds[4]), {
          signal: new AbortController().signal,
          makeError: (code) => Object.assign(new Error(code), { code }),
        }),
      ).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
      expect(stream.locked).toBe(true);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  });
  it.each([
    [404, "us_request_artifact_not_found"],
    [409, "us_request_run_not_ready"],
    [503, "us_request_download_unavailable"],
  ] as const)("decodes bounded safe error envelopes for status %s", async (status, code) => {
    await expect(download(Response.json({ code }, { status }))).rejects.toMatchObject({
      code: status === 503 ? "unavailable" : code,
    });
  });
  it("bounds error bodies and hides raw/unrecognized details", async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(16 * 1024 + 1));
      },
      cancel() {
        cancelled++;
      },
    });
    await expect(
      download(
        new Response(stream, { status: 503, headers: { "content-type": "application/json" } }),
      ),
    ).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
  });
  it.each([
    "https://provider.invalid/file",
    runId.toUpperCase(),
    `${runId}/`,
    "%62" + runId.slice(1),
  ])("refuses noncanonical run identifier %s", async (id) => {
    const send = vi.fn<typeof fetch>();
    await expect(
      createUsBrowserClient(send).requests.download(id, descriptor(kinds[4])),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { kind: "SHA256SUMS" },
    { name: "../manifest.json" },
    { mediaType: "text/html" },
    { byteSize: 0 },
    { sha256: "A".repeat(64) },
    { storageKey: "private" },
  ])("strictly parses descriptors before sending %j", async (override) => {
    const send = vi.fn<typeof fetch>();
    const evidence = { ...descriptor(kinds[4]), ...override };
    // Exercise the untrusted boundary without changing the production type.
    await expect(
      createUsBrowserClient(send).requests.download(runId, evidence as UsRequestArtifact),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    [401, "session_required"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [503, "unavailable"],
  ] as const)("safely maps download status %s", async (status, code) => {
    await expect(
      download(Response.json({ private: "raw provider message" }, { status })),
    ).rejects.toMatchObject({ code, message: code });
  });
  it("hides raw network failures", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("private network details"));
    await expect(
      createUsBrowserClient(send).requests.download(runId, descriptor(kinds[4])),
    ).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
  });
  it("aborts stalled headers at exactly thirty seconds", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const send = vi.fn<typeof fetch>().mockImplementation(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("private timeout"));
          });
        }),
    );
    const assertion = expect(
      createUsBrowserClient(send).requests.download(runId, descriptor(kinds[4])),
    ).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the same thirty-second deadline through a stalled body and releases the lock", async () => {
    vi.useFakeTimers();
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    const send = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return artifactResponse(descriptor(kinds[4]), stream);
    });
    const assertion = expect(
      createUsBrowserClient(send).requests.download(runId, descriptor(kinds[4])),
    ).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(cancelled).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("forwards external abort to the pending body, ignores cancel rejection and removes its listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
        return Promise.reject(new Error("private cancel"));
      },
    });
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(artifactResponse(descriptor(kinds[4]), stream));
    const assertion = expect(
      createUsBrowserClient(send).requests.download(runId, descriptor(kinds[4]), controller.signal),
    ).rejects.toMatchObject({ code: "unavailable" });
    await vi.waitFor(() => expect(stream.locked).toBe(true));
    controller.abort();
    await assertion;
    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("does not send an already aborted download", async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn<typeof fetch>();
    await expect(
      createUsBrowserClient(send).requests.download(runId, descriptor(kinds[4]), controller.signal),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });
  it("rechecks cancellation when verified reader completion precedes client release", async () => {
    const controller = new AbortController();
    const release = ReadableStreamDefaultReader.prototype.releaseLock;
    vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock").mockImplementation(function (
      this: ReadableStreamDefaultReader<Uint8Array>,
    ) {
      release.call(this);
      controller.abort();
    });
    await expect(
      download(artifactResponse(descriptor(kinds[4])), descriptor(kinds[4]), controller.signal),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each(["external", "deadline"])(
    "rejects a %s cancellation during hashing before releasing bytes",
    async (mode) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const evidence = descriptor(kinds[4]);
      const actualHash = await webcrypto.subtle.digest("SHA-256", sample);
      let finishHash: ((value: ArrayBuffer) => void) | undefined;
      const digest = vi.spyOn(webcrypto.subtle, "digest").mockImplementation(
        () =>
          new Promise((resolve) => {
            finishHash = resolve;
          }),
      );
      const promise = download(artifactResponse(evidence), evidence, controller.signal);
      const assertion = expect(promise).rejects.toMatchObject({ code: "unavailable" });
      let settled = false;
      void promise.catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(digest).toHaveBeenCalledOnce();
      if (mode === "external") controller.abort();
      else await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);
      try {
        expect(settled).toBe(true);
      } finally {
        finishHash?.(actualHash);
        await assertion;
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
