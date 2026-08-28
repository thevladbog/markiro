import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { pathToFileURL } from "node:url";

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const VERSION_ID = /^[A-Za-z0-9._+/=-]{1,256}$/;
const PLAN_KEY =
  /^(production\/plans\/[0-9]+\/[1-9][0-9]*\/[0-9a-f]{40}\/(?:true|false)-(?:true|false)\/)(production\.tfplan|production-plan\.json)$/;
const ABSENCE_NAMES = new Set(["NotFound", "NoSuchKey", "NoSuchVersion"]);

function invalid() {
  throw new Error("terraform plan escrow cleanup failed");
}

function exactString(value, pattern) {
  const match = typeof value === "string" ? pattern.exec(value) : null;
  if (!match || match[0] !== value) invalid();
  return value;
}

export function isExplicitObjectAbsence(error) {
  return (
    error instanceof S3ServiceException &&
    error.$metadata?.httpStatusCode === 404 &&
    ABSENCE_NAMES.has(error.name)
  );
}

export async function cleanupTerraformPlanEscrow({ client, bucket, objects }) {
  try {
    exactString(bucket, BUCKET);
    if (
      !client ||
      typeof client.send !== "function" ||
      !Array.isArray(objects) ||
      objects.length !== 2
    ) {
      invalid();
    }
    const seen = new Set();
    const prefixes = new Set();
    const filenames = new Set();
    const validated = [];
    for (const object of objects) {
      if (!object || typeof object !== "object" || Array.isArray(object)) invalid();
      if (Object.keys(object).sort().join(",") !== "key,versionId") invalid();
      const key = exactString(object.key, PLAN_KEY);
      const versionId = exactString(object.versionId, VERSION_ID);
      const match = PLAN_KEY.exec(key);
      if (!match || match[0] !== key || seen.has(key)) invalid();
      seen.add(key);
      prefixes.add(match[1]);
      filenames.add(match[2]);
      validated.push({ key, versionId });
    }
    if (
      prefixes.size !== 1 ||
      filenames.size !== 2 ||
      !filenames.has("production.tfplan") ||
      !filenames.has("production-plan.json")
    ) {
      invalid();
    }
    for (const { key, versionId } of validated) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
      );
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
        );
        invalid();
      } catch (error) {
        if (!isExplicitObjectAbsence(error)) invalid();
      }
    }
  } catch {
    invalid();
  }
}

async function main() {
  const [, , command, bucket, ...pairs] = process.argv;
  if (command !== "cleanup" || !bucket || pairs.length < 2 || pairs.length % 2 !== 0) invalid();
  const objects = [];
  for (let index = 0; index < pairs.length; index += 2) {
    objects.push({ key: pairs[index], versionId: pairs[index + 1] });
  }
  const client = new S3Client({
    endpoint: "https://storage.yandexcloud.net",
    region: "ru-central1",
    forcePathStyle: true,
  });
  await cleanupTerraformPlanEscrow({ client, bucket, objects });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch {
    process.stderr.write("terraform plan escrow cleanup failed\n");
    process.exitCode = 1;
  }
}
