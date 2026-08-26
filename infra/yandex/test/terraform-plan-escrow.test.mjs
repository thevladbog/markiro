import assert from "node:assert/strict";
import test from "node:test";

import { NoSuchKey, NotFound, S3ServiceException } from "@aws-sdk/client-s3";

import {
  cleanupTerraformPlanEscrow,
  isExplicitObjectAbsence,
} from "../scripts/terraform-plan-escrow.mjs";

function metadata(httpStatusCode) {
  return { httpStatusCode, requestId: "fixture", attempts: 1, totalRetryDelay: 0 };
}

function modeled(ErrorType, httpStatusCode = 404) {
  return new ErrorType({ message: "bounded fixture", $metadata: metadata(httpStatusCode) });
}

function exactObjects() {
  const prefix = "production/plans/123/1/" + "a".repeat(40) + "/false-false/";
  return [
    { key: `${prefix}production.tfplan`, versionId: "version-a" },
    { key: `${prefix}production-plan.json`, versionId: "version-b" },
  ];
}

test("escrow cleanup accepts only explicit pinned-SDK absence responses", () => {
  assert.equal(isExplicitObjectAbsence(modeled(NotFound)), true);
  assert.equal(isExplicitObjectAbsence(modeled(NoSuchKey)), true);
  assert.equal(
    isExplicitObjectAbsence(
      new S3ServiceException({
        name: "NoSuchVersion",
        $fault: "client",
        $metadata: metadata(404),
        message: "bounded fixture",
      }),
    ),
    true,
  );

  for (const error of [
    modeled(NotFound, 401),
    modeled(NoSuchKey, 403),
    new S3ServiceException({
      name: "TooManyRequests",
      $fault: "client",
      $metadata: metadata(429),
      message: "bounded fixture",
    }),
    new S3ServiceException({
      name: "InternalError",
      $fault: "server",
      $metadata: metadata(500),
      message: "bounded fixture",
    }),
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
    Object.assign(new Error("transport"), { code: "ECONNRESET" }),
    new Error("unknown"),
  ]) {
    assert.equal(isExplicitObjectAbsence(error), false);
  }
});

test("escrow cleanup deletes and verifies both exact object versions", async () => {
  const sent = [];
  const client = {
    async send(command) {
      sent.push(command);
      if (command.constructor.name === "HeadObjectCommand") throw modeled(NotFound);
      return {};
    },
  };
  const objects = exactObjects();

  await cleanupTerraformPlanEscrow({ client, bucket: "state-bucket", objects });

  assert.deepEqual(
    sent.map((command) => ({ name: command.constructor.name, input: command.input })),
    [
      {
        name: "DeleteObjectCommand",
        input: { Bucket: "state-bucket", Key: objects[0].key, VersionId: "version-a" },
      },
      {
        name: "HeadObjectCommand",
        input: { Bucket: "state-bucket", Key: objects[0].key, VersionId: "version-a" },
      },
      {
        name: "DeleteObjectCommand",
        input: { Bucket: "state-bucket", Key: objects[1].key, VersionId: "version-b" },
      },
      {
        name: "HeadObjectCommand",
        input: { Bucket: "state-bucket", Key: objects[1].key, VersionId: "version-b" },
      },
    ],
  );
});

test("escrow cleanup fails for auth, throttle, server, timeout, transport, and unknown head errors", async () => {
  for (const headError of [
    modeled(NotFound, 403),
    new S3ServiceException({
      name: "SlowDown",
      $fault: "client",
      $metadata: metadata(429),
      message: "bounded",
    }),
    new S3ServiceException({
      name: "InternalError",
      $fault: "server",
      $metadata: metadata(503),
      message: "bounded",
    }),
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
    Object.assign(new Error("transport"), { code: "ECONNRESET" }),
    new Error("unknown"),
  ]) {
    const client = {
      async send(command) {
        if (command.constructor.name === "HeadObjectCommand") throw headError;
        return {};
      },
    };
    await assert.rejects(
      cleanupTerraformPlanEscrow({
        client,
        bucket: "state-bucket",
        objects: exactObjects(),
      }),
      /terraform plan escrow cleanup failed/,
    );
  }
});

test("escrow cleanup accepts exactly one binary and JSON pair under the same run prefix", async () => {
  const [binary, json] = exactObjects();

  for (const objects of [
    [binary],
    [binary, { ...binary, versionId: "version-b" }],
    [
      binary,
      {
        ...json,
        key: json.key.replace("/123/", "/124/"),
      },
    ],
    [binary, { ...json, versionId: "version-b\n" }],
  ]) {
    const sent = [];
    const client = {
      async send(command) {
        sent.push(command);
        if (command.constructor.name === "HeadObjectCommand") throw modeled(NotFound);
        return {};
      },
    };
    await assert.rejects(
      cleanupTerraformPlanEscrow({ client, bucket: "state-bucket", objects }),
      /terraform plan escrow cleanup failed/,
    );
    assert.equal(sent.length, 0);
  }
  const sent = [];
  const client = {
    async send(command) {
      sent.push(command);
    },
  };
  await assert.rejects(
    cleanupTerraformPlanEscrow({ client, bucket: "state-bucket\n", objects: [binary, json] }),
    /terraform plan escrow cleanup failed/,
  );
  assert.equal(sent.length, 0);
});
