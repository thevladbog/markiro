import { createDb } from "@markiro/db";
import { assertUsHostedRelease, usHostedReleaseIdentity } from "./us-hosted-release-verifier";
import {
  assertUsHostedMaterial,
  usHostedApiMaterial,
  usHostedWorkerMaterial,
} from "./us-hosted-material-owner";

/** Closed hosted transport; readiness and acquired-pool cleanup belong to its service lifecycle. */
export function createUsHostedDatabase(
  release: unknown,
  material: unknown,
): ReturnType<typeof createDb> {
  try {
    assertUsHostedRelease(release);
    const { service } = usHostedReleaseIdentity(release);
    assertUsHostedMaterial(material, release, service);
    const values =
      service === "api"
        ? usHostedApiMaterial(material, release)
        : usHostedWorkerMaterial(material, release);
    const url = new URL("postgresql://postgres.us-demo.internal:5432/markiro_us_synthetic");
    url.username = `markiro_us_${service}`;
    url.password = values.database.password;
    return createDb(url.toString(), {
      max: service === "api" ? 5 : 2,
      connectionTimeoutMillis: 2000,
      statement_timeout: service === "api" ? 5000 : 15000,
      ssl: {
        ca: values.database.ca,
        rejectUnauthorized: true,
        servername: "postgres.us-demo.internal",
      },
    });
  } catch {
    throw new Error("us_hosted_database_invalid");
  }
}
