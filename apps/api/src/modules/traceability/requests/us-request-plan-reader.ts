import { createHash } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { UsPlanArtifactStore } from "../plans/us-plan-artifacts";
import { parseUsPlanPublishedRow } from "../plans/us-plan-published";
import {
  requireUsRequestPackageEvidence,
  type UsTraceExportRunRow,
} from "./us-request-run-evidence";

export type UsRequestPinnedPlanResult =
  | { readonly kind: "absent"; readonly code: "plan_absent" }
  | {
      readonly kind: "pdf";
      readonly planVersionId: string;
      readonly sha256: string;
      readonly byteSize: number;
      readonly bytes: Buffer;
    };

/** Internal saved-package input reader; evidence verification grants no authorization. */
export class UsRequestPlanReader {
  constructor(
    private readonly db: Db,
    private readonly artifacts: Pick<UsPlanArtifactStore, "readVerified"> | null,
  ) {}

  async read(
    run: UsTraceExportRunRow,
    expectedTenantId: string,
  ): Promise<UsRequestPinnedPlanResult> {
    // Compatibility and saved-run failures precede I/O and keep their own codes.
    const frozen = requireUsRequestPackageEvidence(run, expectedTenantId);
    const pin = frozen.validationSnapshot.plan;
    if (pin === null) {
      if (frozen.mode !== "available_records_incomplete")
        throw new ServiceUnavailableException({ code: "us_request_run_stored_invalid" });
      return { kind: "absent", code: "plan_absent" };
    }
    try {
      const published = await this.db.transaction(
        async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
          const [row] = await tx
            .select()
            .from(schema.traceabilityPlanVersions)
            .where(
              and(
                eq(schema.traceabilityPlanVersions.tenantId, expectedTenantId),
                eq(schema.traceabilityPlanVersions.id, pin.id),
              ),
            )
            .limit(1);
          if (!row) throw new Error("missing_pinned_plan");
          const parsed = parseUsPlanPublishedRow(row);
          if (parsed.artifact.sha256 !== pin.pdfSha256) throw new Error("pinned_hash_mismatch");
          return parsed;
        },
        { accessMode: "read only" },
      );
      // Release the metadata transaction before bounded private object I/O.
      if (!this.artifacts) throw new Error("missing_plan_reader");
      const bytes = Buffer.from(
        await this.artifacts.readVerified(
          { tenantId: expectedTenantId, versionId: published.id },
          published.artifact,
        ),
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== published.artifact.byteSize || sha256 !== pin.pdfSha256)
        throw new Error("pinned_bytes_mismatch");
      return { kind: "pdf", planVersionId: pin.id, sha256, byteSize: bytes.length, bytes };
    } catch {
      throw new ServiceUnavailableException({ code: "us_request_plan_read_failed" });
    }
  }
}
