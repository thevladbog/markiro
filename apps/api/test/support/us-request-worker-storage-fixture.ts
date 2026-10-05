import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { loadUsRequestPackageArtifactStorageConfig } from "../../src/modules/traceability/requests/us-request-package-artifact-config";
import {
  UsRequestPackageArtifactStore,
  type UsRequestPackageArtifactS3Transport,
} from "../../src/modules/traceability/requests/us-request-package-artifacts";

export const storageEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  MARKIRO_DEPLOYMENT_EDITION: "US",
  US_REQUEST_PACKAGE_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_REQUEST_PACKAGE_S3_REGION: "us-east-1",
  US_REQUEST_PACKAGE_S3_BUCKET: "markiro-us-request-fixture",
  US_REQUEST_PACKAGE_S3_ACCESS_KEY_ID: "synthetic-us-request-access",
  US_REQUEST_PACKAGE_S3_SECRET_ACCESS_KEY: "synthetic-us-request-secret",
  US_REQUEST_PACKAGE_S3_FORCE_PATH_STYLE: "true",
});

export function createUsRequestWorkerStorageFixture(
  wrap?: (transport: UsRequestPackageArtifactS3Transport) => UsRequestPackageArtifactS3Transport,
) {
  const config = loadUsRequestPackageArtifactStorageConfig(storageEnvironment());
  if (!config) throw new Error("fixture unavailable");
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const calls: {
    kind: "put" | "get" | "head" | "delete";
    command: Parameters<UsRequestPackageArtifactS3Transport["send"]>[0];
    signal: AbortSignal;
  }[] = [];
  const bodies: Readable[] = [];
  const faults: {
    before:
      | ((command: Parameters<UsRequestPackageArtifactS3Transport["send"]>[0]) => Promise<void>)
      | null;
    after:
      | ((
          command: Parameters<UsRequestPackageArtifactS3Transport["send"]>[0],
          result: unknown,
        ) => Promise<unknown>)
      | null;
  } = { before: null, after: null };
  const finish = async (
    command: Parameters<UsRequestPackageArtifactS3Transport["send"]>[0],
    result: unknown,
  ) => (faults.after ? faults.after(command, result) : result);
  const transport: UsRequestPackageArtifactS3Transport = {
    async send(command, { abortSignal }) {
      const kind =
        command instanceof PutObjectCommand
          ? "put"
          : command instanceof GetObjectCommand
            ? "get"
            : command instanceof DeleteObjectCommand
              ? "delete"
              : "head";
      calls.push({ kind, command, signal: abortSignal });
      await faults.before?.(command);
      if (abortSignal.aborted) throw new Error("aborted fixture operation");
      if (command.input.Bucket !== config.bucket || !command.input.Key)
        throw new Error("invalid fixture command");
      const key = command.input.Key;
      if (command instanceof PutObjectCommand) {
        if (
          command.input.IfNoneMatch !== "*" ||
          command.input.ACL !== undefined ||
          !(command.input.Body instanceof Uint8Array) ||
          typeof command.input.ContentType !== "string"
        )
          throw new Error("unsafe fixture put");
        if (objects.has(key))
          throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
        objects.set(key, {
          bytes: Buffer.from(command.input.Body),
          contentType: command.input.ContentType,
        });
        return finish(command, {});
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(key);
        return finish(command, {});
      }
      const object = objects.get(key);
      if (!object) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      if (command instanceof HeadObjectCommand)
        return finish(command, {
          ContentLength: object.bytes.length,
          ContentType: object.contentType,
        });
      const body = Readable.from([Buffer.from(object.bytes)]);
      bodies.push(body);
      return finish(command, {
        Body: body,
        ContentLength: object.bytes.length,
        ContentType: object.contentType,
      });
    },
  };
  const store = new UsRequestPackageArtifactStore(config, wrap ? wrap(transport) : transport);
  return {
    config,
    store,
    objects,
    calls,
    bodies,
    transport,
    faults,
    destroy() {
      store.destroy();
      for (const body of bodies) body.destroy();
      objects.clear();
      faults.before = null;
      faults.after = null;
    },
  };
}
