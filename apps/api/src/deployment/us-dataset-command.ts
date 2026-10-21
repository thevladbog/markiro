import { z } from "zod";
import type { UsDatasetContext } from "../modules/traceability/demo/us-dataset-contract";
import { usSixMonthDefinition } from "../modules/traceability/demo/us-six-month-definition";
import {
  loadUsPlanArtifactStorageConfig,
  type UsPlanArtifactStorageConfig,
} from "../modules/traceability/plans/us-plan-artifact-config";
import {
  loadUsRequestPackageArtifactStorageConfig,
  type UsRequestPackageArtifactStorageConfig,
} from "../modules/traceability/requests/us-request-package-artifact-config";
import { loadUsDevelopmentEnv, type UsDevelopmentEnv } from "./entry-policy";

export type UsDatasetCommand = Readonly<{
  mode: "initialize" | "verify";
  context: UsDatasetContext;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  env: UsDevelopmentEnv;
  planStorage: UsPlanArtifactStorageConfig;
  packageStorage: UsRequestPackageArtifactStorageConfig;
}>;

const confirmation = "--confirm-local-synthetic-dataset";
const flags = new Set([
  "--database-name",
  "--database-user",
  "--tenant-id",
  "--owner-id",
  "--version",
  "--definition-digest",
]);
const uuid = z
  .string()
  .regex(/^[0-9a-f-]{36}$/)
  .uuid();
const contextSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    expectedDatabaseName: z.literal("markiro_us_dev"),
    expectedDatabaseUser: z.literal("markiro_us"),
  })
  .strict();

function invalidArguments(): never {
  throw new Error("us_dataset_command_arguments_invalid");
}

/** Pure local preflight only. Configurations remain internal to the executable. */
export function datasetCommandEnvironment(
  args: readonly string[],
  raw: NodeJS.ProcessEnv,
): UsDatasetCommand {
  const mode = args[0];
  if (mode !== "initialize" && mode !== "verify") return invalidArguments();
  const values = new Map<string, string>();
  let confirmed = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === confirmation) {
      if (mode !== "initialize" || confirmed) return invalidArguments();
      confirmed = true;
      continue;
    }
    if (flag === undefined || !flags.has(flag) || values.has(flag)) return invalidArguments();
    const value = args[++index];
    if (value === undefined || value === "" || value.startsWith("--")) return invalidArguments();
    values.set(flag, value);
  }
  if (
    (mode === "initialize" && !confirmed) ||
    values.size !== flags.size ||
    values.get("--version") !== usSixMonthDefinition.version ||
    values.get("--definition-digest") !== usSixMonthDefinition.digest
  )
    return invalidArguments();
  const parsed = contextSchema.safeParse({
    tenantId: values.get("--tenant-id"),
    actorUserId: values.get("--owner-id"),
    expectedDatabaseName: values.get("--database-name"),
    expectedDatabaseUser: values.get("--database-user"),
  });
  if (!parsed.success) return invalidArguments();

  let env: UsDevelopmentEnv;
  try {
    env = loadUsDevelopmentEnv(raw);
    if (new URL(env.DATABASE_URL).username !== "markiro_us") throw new Error();
  } catch {
    throw new Error("us_dataset_command_environment_invalid");
  }
  let planStorage: UsPlanArtifactStorageConfig | null;
  let packageStorage: UsRequestPackageArtifactStorageConfig | null;
  try {
    planStorage = loadUsPlanArtifactStorageConfig(raw);
    packageStorage = loadUsRequestPackageArtifactStorageConfig(raw);
  } catch {
    throw new Error("us_dataset_command_storage_unavailable");
  }
  if (!planStorage || !packageStorage) throw new Error("us_dataset_command_storage_unavailable");

  // Loaders return fresh frozen, WeakSet-branded configs; copying loses that validation brand.
  return Object.freeze({
    mode,
    context: Object.freeze(parsed.data),
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    env: Object.freeze({ ...env, planArtifactStorage: planStorage }),
    planStorage,
    packageStorage,
  });
}
