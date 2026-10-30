import * as hostedReleaseVerifier from "../src/deployment/us-hosted-release-verifier";
import * as hostedMaterialOwner from "../src/deployment/us-hosted-material-owner";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { compileFunction } from "node:vm";
import ts from "typescript";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsWorkerObjectEvidence } from "../src/modules/traceability/requests/us-request-worker-types";
import { createUsRequestWorkerStorageFixture } from "./support/us-request-worker-storage-fixture";
import * as artifactConfig from "../src/modules/traceability/requests/us-request-package-artifact-config";
import * as workerTypes from "../src/modules/traceability/requests/us-request-worker-types";
import * as requestObservation from "../src/modules/traceability/requests/us-request-read-observation";
import { UsRequestPackageArtifactStore } from "../src/modules/traceability/requests/us-request-package-artifacts";
import type * as artifactTypes from "../src/modules/traceability/requests/us-request-package-artifacts";
import {
  projectUsRequestPackageStorageReadFailureCode as projectStorageCode,
  takeUsRequestPackageStorageReadFailure as takeStorageFailure,
  takeUsRequestPackageTransportWitness as takeWitness,
  projectUsRequestPackageTransportWitness as projectWitness,
} from "../src/modules/traceability/requests/us-request-package-artifacts";

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

const readFailureCodes = [
  "us_request_package_storage_scope_invalid",
  "us_request_package_storage_evidence_invalid",
  "us_request_package_storage_timeout",
  "us_request_package_storage_checksum_mismatch",
  "us_request_package_storage_transport_failed",
  "us_request_package_storage_read_failed",
  "us_request_worker_unknown_failure",
];

it("carries the same owned read observation into the existing take-once witness", async () => {
  // The helper's real SDK acquisition is covered separately. This unit test
  // isolates the adapter wiring without opening its reserved provider port.
  const original = Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" });
  let observed: object | undefined;
  let finished = false,
    destroyed = false;
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => {
    throw original;
  });
  vi.spyOn(requestObservation, "createUsRequestReadObservation").mockImplementation(() => ({
    run<T>(token: object, action: () => Promise<T>): Promise<T> {
      observed = token;
      return action();
    },
    take(token: object, error: unknown) {
      return token === observed && error === original
        ? ("reused-before-response" as const)
        : undefined;
    },
    takeDetailed(token: object, error: unknown) {
      return token === observed && error === original
        ? { state: "reused-before-response" as const }
        : undefined;
    },
    finish(token: object) {
      if (token === observed) finished = true;
    },
    destroy() {
      destroyed = true;
    },
  }));
  const fixture = createUsRequestWorkerStorageFixture();
  const owned = new UsRequestPackageArtifactStore(fixture.config);
  try {
    const error: unknown = await owned
      .readVerified(scope, evidence())
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "us_request_package_storage_transport_failed" });
    expect(takeWitness(error)).toBe("await_send:code:ECONNRESET:reused-before-response");
    expect(takeWitness(error)).toBeUndefined();
    expect(finished).toBe(true);
  } finally {
    owned.destroy();
    fixture.destroy();
  }
  expect(destroyed).toBe(true);
});

for (const timing of [
  "idle-lt-6000:wait-lt-1000",
  "idle-lt-6000:wait-ge-1000",
  "idle-ge-6000:wait-lt-1000",
  "idle-ge-6000:wait-ge-1000",
] as const) {
  it(`carries the owned same-error timing bucket ${timing} through the existing witness`, async () => {
    const original = Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" });
    let observed: object | undefined;
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => {
      throw original;
    });
    vi.spyOn(requestObservation, "createUsRequestReadObservation").mockImplementation(() => ({
      run<T>(token: object, action: () => Promise<T>): Promise<T> {
        observed = token;
        return action();
      },
      take() {
        return "reused-before-response" as const;
      },
      takeDetailed(token: object, error: unknown) {
        return token === observed && error === original
          ? { state: "reused-before-response" as const, timing }
          : undefined;
      },
      finish() {},
      destroy() {},
    }));
    const fixture = createUsRequestWorkerStorageFixture();
    const store = new UsRequestPackageArtifactStore(fixture.config);
    try {
      const error: unknown = await store
        .readVerified(scope, evidence())
        .catch((value: unknown) => value);
      const witness = `await_send:code:ECONNRESET:reused-before-response:${timing}`;
      expect(takeWitness(error)).toBe(witness);
      expect(takeWitness(error)).toBeUndefined();
      expect(projectWitness(witness)).toBe(witness);
      expect(projectWitness(witness + ":private")).toBeUndefined();
    } finally {
      store.destroy();
      fixture.destroy();
    }
  });
}

it("drains a peer's queued idle close before an owned SDK private read acquisition", async () => {
  const shared = new SharedArrayBuffer(4);
  const signal = new Int32Array(shared);
  const peer = new Worker(resolve("test/support/us-request-native-peer-fixture.mjs"), {
    workerData: shared,
  });
  const [port]: unknown[] = await once(peer, "message");
  if (typeof port !== "number") throw new Error("Expected owned listener port");
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
    forcePathStyle: true,
    maxAttempts: 1,
  });
  // Capture the real SDK method before the adapter-only forwarding seam.
  const nativeSend = client.send.bind(client);
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
    if (!(command instanceof GetObjectCommand)) throw new Error("Expected private read");
    return nativeSend(command);
  });
  const fixture = createUsRequestWorkerStorageFixture();
  const store = new UsRequestPackageArtifactStore(fixture.config);
  try {
    expect(await store.readVerified(scope, evidence())).toEqual(bytes);
    await new Promise<void>((resolve) => setImmediate(resolve));
    peer.postMessage("expire");
    expect(Atomics.wait(signal, 0, 0, 2000)).not.toBe("timed-out");
    expect(Atomics.load(signal, 0)).toBe(1);
    expect(await store.readVerified(scope, evidence())).toEqual(bytes);
  } finally {
    store.destroy();
    fixture.destroy();
    client.destroy();
    const closed = once(peer, "exit");
    peer.postMessage("close");
    const [exit] = await closed;
    expect(exit).toBe(0);
  }
});

it("does not dispatch a queued owned SDK read after store destruction", async () => {
  let sends = 0;
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => {
    sends++;
    throw new Error("A destroyed read must not dispatch");
  });
  const fixture = createUsRequestWorkerStorageFixture();
  const store = new UsRequestPackageArtifactStore(fixture.config);
  try {
    const result = store.readVerified(scope, evidence());
    const rejected = expect(result).rejects.toMatchObject({
      message: "us_request_package_storage_timeout",
    });
    store.destroy();
    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sends).toBe(0);
  } finally {
    store.destroy();
    fixture.destroy();
  }
});

it("retains a private take-once witness from the actual failed send without changing its error", async () => {
  const s = createUsRequestWorkerStorageFixture(() => ({
    async send() {
      throw { code: "ECONNRESET", name: "TimeoutError", $metadata: { httpStatusCode: 503 } };
    },
  }));
  try {
    const error: unknown = await s.store.readVerified(scope, evidence()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "us_request_package_storage_transport_failed" });
    Object.freeze(error);
    const descriptors = Object.getOwnPropertyDescriptors(error);
    expect(takeWitness(error)).toBe("await_send:code:ECONNRESET");
    expect(takeWitness(error)).toBeUndefined();
    expect(Object.getOwnPropertyDescriptors(error)).toEqual(descriptors);
    expect(takeStorageFailure(error)).toBe("us_request_package_storage_transport_failed");
  } finally {
    s.destroy();
  }
});

const transportCases = [
  [{ code: "ECONNRESET" }, "await_send:code:ECONNRESET", "consume_body:code:ECONNRESET"],
  [{ code: "ECONNREFUSED" }, "await_send:code:ECONNREFUSED", "consume_body:code:ECONNREFUSED"],
  [{ code: "ETIMEDOUT" }, "await_send:code:ETIMEDOUT", "consume_body:code:ETIMEDOUT"],
  [{ code: "EPIPE" }, "await_send:code:EPIPE", "consume_body:code:EPIPE"],
  [{ code: "ENETUNREACH" }, "await_send:code:ENETUNREACH", "consume_body:code:ENETUNREACH"],
  [{ code: "EHOSTUNREACH" }, "await_send:code:EHOSTUNREACH", "consume_body:code:EHOSTUNREACH"],
  [{ name: "TimeoutError" }, "await_send:name:TimeoutError", "consume_body:name:TimeoutError"],
  [
    { name: "RequestTimeout" },
    "await_send:name:RequestTimeout",
    "consume_body:name:RequestTimeout",
  ],
  [{ $metadata: { httpStatusCode: 408 } }, "await_send:status:408", "consume_body:status:408"],
  [{ $metadata: { httpStatusCode: 429 } }, "await_send:status:429", "consume_body:status:429"],
  [{ $metadata: { httpStatusCode: 500 } }, "await_send:status:500", "consume_body:status:500"],
  [{ $metadata: { httpStatusCode: 502 } }, "await_send:status:502", "consume_body:status:502"],
  [{ $metadata: { httpStatusCode: 503 } }, "await_send:status:503", "consume_body:status:503"],
  [{ $metadata: { httpStatusCode: 504 } }, "await_send:status:504", "consume_body:status:504"],
] as const;
async function failedRead(raw: unknown, body = false) {
  const s = createUsRequestWorkerStorageFixture(() => ({
    async send() {
      if (!body) throw raw;
      return {
        Body: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                throw raw;
              },
            };
          },
        },
        ContentType: "application/json",
        ContentLength: bytes.length,
      };
    },
  }));
  try {
    return await s.store.readVerified(scope, evidence()).catch((error: unknown) => error);
  } finally {
    s.destroy();
  }
}
it("captures all 28 independent first-match literals at the actual send or body boundary", async () => {
  expect(transportCases).toHaveLength(14);
  for (const [raw, send, body] of transportCases)
    for (const [postSend, want] of [
      [false, send],
      [true, body],
    ] as const) {
      const error = await failedRead(Object.freeze(raw), postSend);
      expect(error).toMatchObject({ code: "us_request_package_storage_transport_failed" });
      expect(takeWitness(error)).toBe(want);
      expect(takeWitness(error)).toBeUndefined();
      expect(projectWitness(want)).toBe(want);
    }
});

it("keeps the eager own-descriptor trace and original first-match and fallback decisions", async () => {
  for (const [fields, want] of [
    [{ code: "ECONNRESET", name: "TimeoutError", status: 503 }, "await_send:code:ECONNRESET"],
    [{ code: "private", name: "TimeoutError", status: 503 }, "await_send:name:TimeoutError"],
    [{ code: "private", name: "RequestTimeout", status: 503 }, "await_send:name:RequestTimeout"],
    [{ code: "private", name: "private", status: 503 }, "await_send:status:503"],
    [{ code: 408, name: "private", status: "503" }, undefined],
  ] as const) {
    const reads: string[] = [];
    const metadata = new Proxy(
      { httpStatusCode: fields.status },
      {
        getOwnPropertyDescriptor(target, key) {
          reads.push(`metadata:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const raw = new Proxy(
      { code: fields.code, name: fields.name, $metadata: metadata },
      {
        getPrototypeOf(target) {
          reads.push("prototype");
          return Reflect.getPrototypeOf(target);
        },
        getOwnPropertyDescriptor(target, key) {
          reads.push(`error:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get() {
          throw new Error("unexpected raw get");
        },
      },
    );
    const error = await failedRead(raw);
    expect(takeWitness(error)).toBe(want);
    expect(error).toMatchObject({
      code: want
        ? "us_request_package_storage_transport_failed"
        : "us_request_package_storage_read_failed",
    });
    expect(reads).toEqual([
      "prototype",
      "error:code",
      "error:name",
      "error:$metadata",
      "metadata:httpStatusCode",
    ]);
  }
  let getters = 0;
  const raw = Object.defineProperty(Object.create({ code: "ECONNRESET" }), "name", {
    get() {
      getters++;
      throw Error("private getter");
    },
  });
  expect(takeWitness(await failedRead(raw))).toBeUndefined();
  expect(getters).toBe(0);
  for (const [trapAt, expectedReads] of [
    ["code", ["code"]],
    ["name", ["code", "name"]],
    ["$metadata", ["code", "name", "$metadata"]],
    ["httpStatusCode", ["code", "name", "$metadata", "httpStatusCode"]],
  ] as const) {
    const sentinel = new Error("private trap");
    const reads: string[] = [];
    const descriptor = (target: object, key: string | symbol) => {
      reads.push(String(key));
      if (key === trapAt) throw sentinel;
      return Reflect.getOwnPropertyDescriptor(target, key);
    };
    const metadata = new Proxy({ httpStatusCode: 503 }, { getOwnPropertyDescriptor: descriptor });
    const trapped = new Proxy(
      { code: "ECONNRESET", name: "TimeoutError", $metadata: metadata },
      { getOwnPropertyDescriptor: descriptor },
    );
    expect(await failedRead(trapped)).toBe(sentinel);
    expect(reads).toEqual(expectedReads);
    expect(takeWitness(sentinel)).toBeUndefined();
  }
});

it("never inspects alleged witness errors or primitive candidates and consumes genuine frozen errors once", async () => {
  let traps = 0;
  const hit = () => {
    traps++;
    throw Error("private sentinel");
  };
  const proxy = new Proxy(
    {},
    { get: hit, getPrototypeOf: hit, has: hit, ownKeys: hit, getOwnPropertyDescriptor: hit },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const error = await failedRead({ name: "TimeoutError" });
  if (!(error instanceof Error)) throw new Error("actual mapped error missing");
  Object.freeze(error);
  const descriptors = Object.getOwnPropertyDescriptors(error);
  for (const value of [
    proxy,
    revoked.proxy,
    null,
    undefined,
    1,
    Symbol("private"),
    () => error,
    { cause: error },
    Object.create(error),
    new Error("us_request_package_storage_transport_failed"),
  ]) {
    expect(takeWitness(value)).toBeUndefined();
    expect(projectWitness(value)).toBeUndefined();
  }
  for (const [, send, body] of transportCases)
    for (const value of [send, body]) {
      expect(projectWitness(value)).toBe(value);
      for (const invalid of [
        Object(value),
        ` ${value}`,
        `${value}\n`,
        `${value}:private`,
        { verificationTransportWitness: value },
      ])
        expect(projectWitness(invalid)).toBeUndefined();
    }
  expect(takeWitness(error)).toBe("await_send:name:TimeoutError");
  expect(takeWitness(error)).toBeUndefined();
  expect(Object.getOwnPropertyDescriptors(error)).toEqual(descriptors);
  expect(traps).toBe(0);
});

it("closes read stages on deadlines and ignores late send and body failures without resurrecting witnesses", async () => {
  vi.useFakeTimers();
  for (const bodyPhase of [false, true]) {
    let rejectLate: ((error: unknown) => void) | undefined;
    const pendingIO = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const s = createUsRequestWorkerStorageFixture(() => ({
      async send() {
        if (!bodyPhase) return pendingIO;
        return {
          Body: {
            [Symbol.asyncIterator]() {
              return { next: () => pendingIO };
            },
          },
          ContentType: "application/json",
          ContentLength: bytes.length,
        };
      },
    }));
    try {
      const pending = s.store.readVerified(scope, evidence()).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      const error = await pending;
      expect(error).toMatchObject({ code: "us_request_package_storage_timeout" });
      expect(takeWitness(error)).toBeUndefined();
      rejectLate?.({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(0);
      expect(takeWitness(error)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      s.destroy();
    }
  }
});

it("does not attach witnesses to nonread operations and clears stale witness on same-error passthrough", async () => {
  const original = await failedRead({ code: "ECONNRESET" });
  const s = createUsRequestWorkerStorageFixture(() => ({
    async send() {
      throw original;
    },
  }));
  try {
    expect(await s.store.readVerified(scope, evidence()).catch((e: unknown) => e)).toBe(original);
    expect(takeWitness(original)).toBeUndefined();
  } finally {
    s.destroy();
  }
  const t = createUsRequestWorkerStorageFixture(() => ({
    async send() {
      throw { code: "ECONNRESET" };
    },
  }));
  try {
    for (const call of [
      () => t.store.putVerified(scope, evidence(), bytes),
      () => t.store.removeFenced(scope, evidence()),
    ]) {
      const error: unknown = await call().catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "us_request_package_storage_transport_failed" });
      expect(takeWitness(error)).toBeUndefined();
    }
    t.store.destroy();
    expect(
      takeWitness(await t.store.readVerified(scope, evidence()).catch((e: unknown) => e)),
    ).toBeUndefined();
  } finally {
    t.destroy();
  }
});

it("the actual adapter rejects phase, first-match and take-consumption semantic mutants", async () => {
  const current = readFileSync(
    "src/modules/traceability/requests/us-request-package-artifacts.ts",
    "utf8",
  );
  const require = createRequire(resolve("package.json"));
  for (const [before, after, repeated] of [
    [
      'case "ECONNRESET":\n          capture.witness =\n            capture.phase === "await_send"',
      'case "ECONNRESET":\n          capture.witness =\n            capture.phase !== "await_send"',
      false,
    ],
    [
      'captureTransportMatch(capture, "code", code)',
      'captureTransportMatch(capture, "status", code)',
      false,
    ],
    [
      "const witness = transportWitnesses.get(error);\n  transportWitnesses.delete(error);",
      "const witness = transportWitnesses.get(error);",
      true,
    ],
  ] as const) {
    expect(current.split(before)).toHaveLength(2);
    const js = ts.transpileModule(current.replace(before, after), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mutant: typeof artifactTypes = compileFunction(`${js};return exports;`, [
      "exports",
      "require",
    ])({}, (path: string): unknown =>
      path === "../../../deployment/us-hosted-release-verifier"
        ? hostedReleaseVerifier
        : path === "../../../deployment/us-hosted-material-owner"
          ? hostedMaterialOwner
          : path === "./us-request-package-artifact-config"
            ? artifactConfig
            : path === "./us-request-worker-types"
              ? workerTypes
              : path === "./us-request-read-observation"
                ? requestObservation
                : require(path),
    );
    const fixture = createUsRequestWorkerStorageFixture();
    const store = new mutant.UsRequestPackageArtifactStore(fixture.config, {
      async send() {
        throw { code: "ECONNRESET", name: "TimeoutError" };
      },
    });
    try {
      const error: unknown = await store.readVerified(scope, evidence()).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "us_request_package_storage_transport_failed" });
      const first = mutant.takeUsRequestPackageTransportWitness(error);
      if (repeated) {
        expect(first).toBe("await_send:code:ECONNRESET");
        expect(mutant.takeUsRequestPackageTransportWitness(error)).toBe(first);
      } else expect(first).not.toBe("await_send:code:ECONNRESET");
    } finally {
      store.destroy();
      fixture.destroy();
    }
  }
});

it("takes authentic direct-read factory failures once without changing errors or inspecting impostors", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  let traps = 0;
  const hit = () => {
    traps++;
    throw new Error("private sentinel");
  };
  const proxy = new Proxy(
    {},
    { get: hit, getPrototypeOf: hit, ownKeys: hit, getOwnPropertyDescriptor: hit, has: hit },
  );
  for (const code of readFailureCodes) {
    elapsed = 0;
    const s = createUsRequestWorkerStorageFixture(() => ({
      async send() {
        if (code.endsWith("transport_failed"))
          throw { code: "ECONNRESET", message: "private sentinel" };
        if (code.endsWith("read_failed")) throw new Error("private sentinel");
        if (code.endsWith("timeout")) elapsed = 15_001;
        return {
          Body: code.endsWith("checksum_mismatch") ? Buffer.alloc(bytes.length) : bytes,
          ContentType: "application/json",
          ContentLength: bytes.length,
        };
      },
    }));
    try {
      if (code === "us_request_worker_unknown_failure") s.store.destroy();
      const error: unknown = await s.store
        .readVerified(
          code.endsWith("scope_invalid")
            ? { ...scope, tenantId: "55555555-5555-4555-8555-555555555555" }
            : scope,
          code.endsWith("evidence_invalid")
            ? { ...evidence(), mediaType: "text/plain" }
            : evidence(),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("actual read failure missing");
      Object.freeze(error);
      const descriptors = Object.getOwnPropertyDescriptors(error);
      const prototype: unknown = Object.getPrototypeOf(error);
      for (const forged of [
        proxy,
        Object.defineProperty({}, "code", { get: hit }),
        { code },
        Object.create(error),
        new Error(code),
        { cause: error },
        undefined,
        null,
        code,
        1,
        Symbol("private"),
        () => error,
      ])
        expect(takeStorageFailure(forged)).toBeUndefined();
      expect(takeStorageFailure(error)).toBe(code);
      expect(takeStorageFailure(error)).toBeUndefined();
      expect(Object.getOwnPropertyDescriptors(error)).toEqual(descriptors);
      expect(Object.getPrototypeOf(error)).toBe(prototype);
      expect(error).toMatchObject({ message: code, code });
      expect(takeWitness(error)).toBe(
        code.endsWith("transport_failed") ? "await_send:code:ECONNRESET" : undefined,
      );
    } finally {
      s.destroy();
    }
  }
  expect(traps).toBe(0);
});

it("validates only the seven primitive storage codes and never grants error provenance", () => {
  for (const code of readFailureCodes) {
    expect(projectStorageCode(code)).toBe(code);
    expect(takeStorageFailure(new Error(code))).toBeUndefined();
  }
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error("private");
      },
    },
  );
  for (const value of [
    undefined,
    null,
    1,
    [],
    hostile,
    Object(readFailureCodes[0]),
    { code: readFailureCodes[0] },
    "us_request_package_storage_collision",
    "us_request_package_storage_delete_failed",
    "us_request_package_storage_configuration_invalid",
    "us_request_package_storage_operational_verification_required",
    "private sentinel",
    ...readFailureCodes.flatMap((code) => [` ${code}`, `${code}\n`, `${code}/private`]),
  ])
    expect(projectStorageCode(value)).toBeUndefined();
  expect(traps).toBe(0);
});

it("never registers authentic excluded collision and deletion failures as read evidence", async () => {
  const s = createUsRequestWorkerStorageFixture();
  try {
    await s.store.putVerified(scope, evidence(), bytes);
    const collision: unknown = await s.store
      .putVerified(scope, evidence(), bytes)
      .catch((error: unknown) => error);
    expect(collision).toMatchObject({ message: "us_request_package_storage_collision" });
    expect(takeStorageFailure(collision)).toBeUndefined();
    s.faults.before = async () => {
      throw new Error("private sentinel");
    };
    const deletion: unknown = await s.store
      .removeFenced(scope, evidence())
      .catch((error: unknown) => error);
    expect(deletion).toMatchObject({ message: "us_request_package_storage_delete_failed" });
    expect(takeStorageFailure(deletion)).toBeUndefined();
  } finally {
    s.destroy();
  }
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
