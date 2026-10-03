import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadUsPlanArtifactStorageConfig } from "../src/modules/traceability/plans/us-plan-artifact-config";
import {
  UsPlanArtifactStore,
  type UsPlanArtifactS3Transport,
  type UsPlanArtifactEvidence,
} from "../src/modules/traceability/plans/us-plan-artifacts";

const tenantId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const otherTenantId = "00000000-0000-4000-8000-000000000003";
const scope = { tenantId, versionId };
const pdf = () => {
  const bytes = Buffer.from("%PDF-1.7\nprivate synthetic plan\n%%EOF");
  return {
    bytes,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rendererVersion: "us-plan-pdf-v1" as const,
  };
};

class PrivateStore implements UsPlanArtifactS3Transport {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly puts: PutObjectCommand["input"][] = [];
  readonly deletes: string[] = [];
  fail:
    | "upload"
    | "upload-after-write"
    | "verification"
    | "read"
    | "cleanup"
    | "cleanup-verification"
    | null = null;
  alter: "bytes" | "size" | "contentType" | "stream-limit" | null = null;
  body: Readable | undefined;

  async send(
    command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand | HeadObjectCommand,
  ): Promise<unknown> {
    const key = command.input.Key;
    if (!key || command.input.Bucket !== "markiro-us-plan-artifacts")
      throw new Error("wrong private scope");
    if (command instanceof PutObjectCommand) {
      if (this.fail === "upload") throw new Error("private-secret-upload");
      if (this.objects.has(key) || command.input.IfNoneMatch !== "*") throw new Error("overwrite");
      if (
        !(command.input.Body instanceof Uint8Array) ||
        command.input.ContentType !== "application/pdf" ||
        command.input.ACL !== undefined
      )
        throw new Error("unsafe put");
      this.puts.push(command.input);
      this.objects.set(key, {
        bytes: Buffer.from(command.input.Body),
        contentType: "application/pdf",
      });
      if (this.fail === "upload-after-write") throw new Error("private-secret-ambiguous-upload");
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      if (this.fail === "cleanup") throw new Error("private-secret-cleanup");
      this.deletes.push(key);
      if (this.fail !== "cleanup-verification") this.objects.delete(key);
      return {};
    }
    const object = this.objects.get(key);
    if (!object) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    if (command instanceof HeadObjectCommand) return {};
    if (this.fail === "verification" || this.fail === "read")
      throw new Error("private-secret-read");
    this.body = Readable.from(
      this.alter === "stream-limit"
        ? [Buffer.alloc(object.bytes.length + 1)]
        : [this.alter === "bytes" ? Buffer.alloc(object.bytes.length) : object.bytes],
    );
    return {
      Body: this.body,
      ContentLength: this.alter === "size" ? object.bytes.length + 1 : object.bytes.length,
      ContentType: this.alter === "contentType" ? "text/html" : object.contentType,
    };
  }
}

function setup(rendererVersion: "us-plan-pdf-v1" | "us-plan-pdf-v2" = "us-plan-pdf-v1") {
  const config = loadUsPlanArtifactStorageConfig({
    NODE_ENV: "test",
    MARKIRO_DEPLOYMENT_EDITION: "US",
    US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
    US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
    US_PLAN_ARTIFACT_S3_BUCKET: "markiro-us-plan-artifacts",
    US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic-access",
    US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic-secret",
    US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
  });
  if (!config) throw new Error("missing synthetic config");
  const privateStore = new PrivateStore();
  const store = new UsPlanArtifactStore(config, privateStore);
  const attempt = store.createAttempt({ tenantId, versionId }, { ...pdf(), rendererVersion });
  return { store, privateStore, attempt };
}

const unreferenced = async (_evidence: UsPlanArtifactEvidence, remove: () => Promise<void>) => {
  await remove();
  return "deleted" as const;
};

afterEach(() => vi.useRealTimers());

describe("US private plan artifact attempts", () => {
  it.each(["us-plan-pdf-v1", "us-plan-pdf-v2"] as const)(
    "writes and reads %s private bytes with frozen evidence and unique server attempt keys",
    async (rendererVersion) => {
      const { store, privateStore, attempt } = setup(rendererVersion);
      const evidence = await store.putVerified(attempt);
      expect(evidence).toEqual({ ...attempt.artifact });
      expect(evidence.objectKey).toMatch(
        new RegExp(`^us/plans/${tenantId}/${versionId}/[a-f0-9-]{36}\\.pdf$`),
      );
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(evidence.rendererVersion).toBe(rendererVersion);
      expect(privateStore.puts[0]?.Metadata?.renderer).toBe(rendererVersion);
      expect(await store.readVerified({ tenantId, versionId }, evidence)).toEqual(pdf().bytes);
      const next = store.createAttempt({ tenantId, versionId }, pdf());
      expect(next.artifact.objectKey).not.toBe(evidence.objectKey);
      expect(privateStore.puts[0]?.ChecksumSHA256).toBe(
        Buffer.from(pdf().sha256, "hex").toString("base64"),
      );
      await expect(store.putVerified(attempt)).rejects.toThrow("us_plan_artifact_attempt_invalid");
    },
  );

  it.each(["../tenant", "tenant text", otherTenantId.replace(/-/g, "")])(
    "rejects non-server UUID scope %s",
    (badId) => {
      const { store } = setup();
      expect(() => store.createAttempt({ tenantId: badId, versionId }, pdf())).toThrow(
        "us_plan_artifact_scope_invalid",
      );
    },
  );

  it("refuses tampered renderer evidence and protects frozen bytes from caller mutation", async () => {
    const { store } = setup();
    expect(() =>
      store.createAttempt({ tenantId, versionId }, { ...pdf(), sha256: "0".repeat(64) }),
    ).toThrow("us_plan_artifact_pdf_invalid");
    const rendered = pdf();
    const attempt = store.createAttempt({ tenantId, versionId }, rendered);
    rendered.bytes.fill(0);
    const evidence = await store.putVerified(attempt);
    expect(await store.readVerified({ tenantId, versionId }, evidence)).toEqual(pdf().bytes);
  });

  it.each(["bytes", "size", "contentType", "stream-limit"] as const)(
    "refuses mismatching uploaded %s and closes the stream",
    async (alter) => {
      const { store, privateStore, attempt } = setup();
      privateStore.alter = alter;
      await expect(store.putVerified(attempt)).rejects.toThrow(
        "us_plan_artifact_verification_failed",
      );
      expect(privateStore.body?.destroyed).toBe(true);
      await expect(store.cleanupUnreferenced(attempt, unreferenced, scope)).resolves.toBe(
        "deleted",
      );
      expect(privateStore.objects.size).toBe(0);
    },
  );

  it.each(["upload", "verification"] as const)(
    "sanitizes %s failures without publishing or blind deletion",
    async (fail) => {
      const { store, privateStore, attempt } = setup();
      privateStore.fail = fail;
      await expect(store.putVerified(attempt)).rejects.toThrow(
        /^us_plan_artifact_(upload|verification)_failed$/,
      );
      expect(privateStore.deletes).toEqual([]);
      if (fail === "upload")
        await expect(store.cleanupUnreferenced(attempt, unreferenced, scope)).resolves.toBe(
          "not_owned",
        );
    },
  );

  it("denies other tenant/version keys and read failures with sanitized diagnostics", async () => {
    const { store, privateStore, attempt } = setup();
    const evidence = await store.putVerified(attempt);
    await expect(
      store.readVerified({ tenantId: otherTenantId, versionId }, evidence),
    ).rejects.toThrow("us_plan_artifact_scope_invalid");
    await expect(
      store.readVerified({ tenantId, versionId: otherTenantId }, evidence),
    ).rejects.toThrow("us_plan_artifact_scope_invalid");
    privateStore.fail = "read";
    await expect(store.readVerified({ tenantId, versionId }, evidence)).rejects.toThrow(
      /^us_plan_artifact_read_failed$/,
    );
    await expect(
      store.readVerified({ tenantId, versionId }, { ...evidence, byteSize: 8_000_001 }),
    ).rejects.toThrow("us_plan_artifact_evidence_invalid");
  });

  it("deletes only its created loser under an unreferenced guard, preserving referenced and other-tenant objects", async () => {
    const { store, privateStore, attempt } = setup();
    const winner = store.createAttempt({ tenantId, versionId }, pdf());
    const other = store.createAttempt({ tenantId: otherTenantId, versionId }, pdf());
    await store.putVerified(attempt);
    await store.putVerified(winner);
    await store.putVerified(other);
    store.markReferenced(winner);
    await expect(store.cleanupUnreferenced(winner, unreferenced, scope)).resolves.toBe(
      "referenced",
    );
    await expect(store.cleanupUnreferenced(other, unreferenced, scope)).rejects.toThrow(
      "us_plan_artifact_scope_invalid",
    );
    await expect(
      store.cleanupUnreferenced(other, async () => "referenced", {
        tenantId: otherTenantId,
        versionId,
      }),
    ).resolves.toBe("referenced");
    await expect(store.cleanupUnreferenced({ ...attempt }, unreferenced, scope)).rejects.toThrow(
      "us_plan_artifact_attempt_invalid",
    );
    await expect(store.cleanupUnreferenced(attempt, unreferenced, scope)).resolves.toBe("deleted");
    await expect(store.cleanupUnreferenced(attempt, unreferenced, scope)).resolves.toBe("deleted");
    expect(privateStore.deletes).toEqual([attempt.artifact.objectKey]);
    expect(privateStore.objects.has(winner.artifact.objectKey)).toBe(true);
    expect(privateStore.objects.has(other.artifact.objectKey)).toBe(true);
  });

  it.each(["cleanup", "cleanup-verification"] as const)(
    "keeps %s failure visible and retryable",
    async (fail) => {
      const { store, privateStore, attempt } = setup();
      await store.putVerified(attempt);
      privateStore.fail = fail;
      await expect(store.cleanupUnreferenced(attempt, unreferenced, scope)).rejects.toThrow(
        /^us_plan_artifact_cleanup_failed$/,
      );
      expect(() => store.markReferenced(attempt)).toThrow("us_plan_artifact_attempt_invalid");
      privateStore.fail = null;
      await expect(store.cleanupUnreferenced(attempt, unreferenced, scope)).resolves.toBe(
        "deleted",
      );
    },
  );

  it("does not interpret an ambiguous publication/guard error as authorization to delete", async () => {
    const { store, privateStore, attempt } = setup();
    await store.putVerified(attempt);
    await expect(
      store.cleanupUnreferenced(
        attempt,
        async () => {
          throw new Error("private-commit-error");
        },
        scope,
      ),
    ).rejects.toThrow(/^us_plan_artifact_cleanup_failed$/);
    expect(privateStore.objects.has(attempt.artifact.objectKey)).toBe(true);
    await expect(store.cleanupUnreferenced(attempt, async () => "deleted", scope)).rejects.toThrow(
      "us_plan_artifact_cleanup_failed",
    );
    expect(privateStore.deletes).toEqual([]);
  });

  it("bounds stalled provider operations independently of the transport and sanitizes timeout", async () => {
    vi.useFakeTimers();
    const { store, privateStore, attempt } = setup();
    privateStore.send = () => new Promise(() => {});
    const result = expect(store.putVerified(attempt)).rejects.toThrow(
      "us_plan_artifact_upload_failed",
    );
    await vi.advanceTimersByTimeAsync(15_001);
    await result;
  });

  it("preserves a possible orphan after an ambiguous upload rather than guessing ownership", async () => {
    const { store, privateStore, attempt } = setup();
    privateStore.fail = "upload-after-write";
    await expect(store.putVerified(attempt)).rejects.toThrow(/^us_plan_artifact_upload_failed$/);
    await expect(store.cleanupUnreferenced(attempt, unreferenced, scope)).resolves.toBe(
      "not_owned",
    );
    expect(privateStore.objects.has(attempt.artifact.objectKey)).toBe(true);
    expect(privateStore.deletes).toEqual([]);
  });

  it("bounds a stalled PDF stream and closes it on timeout", async () => {
    const { store, privateStore, attempt } = setup();
    const evidence = await store.putVerified(attempt);
    const stream = new Readable({ read() {} });
    privateStore.send = async () => ({
      Body: stream,
      ContentLength: evidence.byteSize,
      ContentType: "application/pdf",
    });
    vi.useFakeTimers();
    const result = expect(store.readVerified({ tenantId, versionId }, evidence)).rejects.toThrow(
      /^us_plan_artifact_read_failed$/,
    );
    await vi.advanceTimersByTimeAsync(15_001);
    await result;
    expect(stream.destroyed).toBe(true);
  });

  it("does not clean up an upload while its verification is still in flight", async () => {
    const { store, privateStore, attempt } = setup();
    const send = privateStore.send.bind(privateStore);
    let release = () => {};
    let started = () => {};
    const verificationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    privateStore.send = async (command) => {
      const response = await send(command);
      if (command instanceof GetObjectCommand) {
        started();
        await gate;
      }
      return response;
    };
    const upload = store.putVerified(attempt);
    await verificationStarted;
    try {
      await expect(store.cleanupUnreferenced(attempt, unreferenced, scope)).resolves.toBe(
        "not_owned",
      );
      expect(privateStore.deletes).toEqual([]);
    } finally {
      release();
    }
    await upload;
    store.markReferenced(attempt);
    expect(privateStore.objects.has(attempt.artifact.objectKey)).toBe(true);
  });

  it("rejects excess streamed bytes even without ContentLength", async () => {
    const { store, privateStore, attempt } = setup();
    const evidence = await store.putVerified(attempt);
    const stream = Readable.from([pdf().bytes, Buffer.from("extra")]);
    privateStore.send = async () => ({ Body: stream, ContentType: "application/pdf" });
    await expect(store.readVerified({ tenantId, versionId }, evidence)).rejects.toThrow(
      /^us_plan_artifact_read_failed$/,
    );
    expect(stream.destroyed).toBe(true);
  });

  it("rejects a copied configuration and another adapter's attempt", async () => {
    const { store, attempt } = setup();
    const other = setup();
    await expect(other.store.putVerified(attempt)).rejects.toThrow(
      "us_plan_artifact_attempt_invalid",
    );
    const config = loadUsPlanArtifactStorageConfig({
      NODE_ENV: "test",
      MARKIRO_DEPLOYMENT_EDITION: "US",
      US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
      US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
      US_PLAN_ARTIFACT_S3_BUCKET: "markiro-us-plan-artifacts",
      US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic-access",
      US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic-secret",
      US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
    });
    if (!config) throw new Error("missing config");
    expect(() => new UsPlanArtifactStore({ ...config }, new PrivateStore())).toThrow(
      /^us_plan_artifact_configuration_invalid$/,
    );
    expect(() =>
      store.createAttempt({ tenantId, versionId }, { ...pdf(), bytes: Buffer.alloc(8_000_001) }),
    ).toThrow("us_plan_artifact_pdf_invalid");
  });
});
