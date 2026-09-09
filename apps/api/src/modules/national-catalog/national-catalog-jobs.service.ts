import type { NationalCatalogImportService } from "./national-catalog-import.service";
import type { NationalCatalogImportPreviewService } from "./national-catalog-import-preview.service";
import type { NationalCatalogImportApplyService } from "./national-catalog-import-apply.service";
import type { NationalCatalogImageService } from "./national-catalog-image.service";
import type { NationalCatalogLinkRefreshService } from "./national-catalog-link-refresh.service";
import {
  catalogJobSchema,
  type CatalogJob,
  type NationalCatalogJobRepository,
} from "./national-catalog-job-repository";
export const CATALOG_QUEUES = {
  enumerate: "national-catalog-import-enumerate",
  prepare: "national-catalog-import-prepare",
  candidate: "national-catalog-import-image",
  accepted_image: "national-catalog-import-image",
  apply: "national-catalog-import-apply",
  refresh: "national-catalog-link-refresh",
} as const;
export const CATALOG_REPAIR_QUEUE = "national-catalog-import-repair";
export type CatalogJobSender = (
  queue: string,
  payload: CatalogJob,
  key: string,
) => Promise<unknown>;
export class NationalCatalogJobsService {
  constructor(
    private readonly repository: Pick<NationalCatalogJobRepository, "claim">,
    private readonly sessions: Pick<NationalCatalogImportService, "resume">,
    private readonly previews: Pick<NationalCatalogImportPreviewService, "resumePreparation">,
    private readonly applies: Pick<NationalCatalogImportApplyService, "resume">,
    private readonly images: Pick<
      NationalCatalogImageService,
      "resume" | "apply" | "releaseExpired"
    >,
    private readonly refreshes: Pick<NationalCatalogLinkRefreshService, "resume">,
  ) {}
  async repair(
    send: CatalogJobSender,
  ): Promise<{ selected: number; sent: number; failed: number }> {
    const jobs = await this.repository.claim(100);
    let sent = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        await send(
          CATALOG_QUEUES[job.kind],
          job,
          [job.kind, job.tenantId, job.workId, job.stepId].join(":"),
        );
        sent++;
      } catch {
        failed++;
      }
    }
    await this.images.releaseExpired(new Date(), 50);
    return { selected: jobs.length, sent, failed };
  }
  async execute(input: unknown): Promise<void> {
    const job = catalogJobSchema.parse(input);
    switch (job.kind) {
      case "enumerate":
        return this.sessions.resume(job.tenantId, job.sessionId, job.stepId);
      case "prepare":
        return this.previews.resumePreparation(job.tenantId, job.sessionId, job.workId, job.stepId);
      case "candidate":
        return this.images.resume(
          job.tenantId,
          job.sessionId,
          job.previewId,
          job.candidateId,
          job.stepId,
        );
      case "apply":
        return this.applies.resume(job.tenantId, job.workId);
      case "accepted_image":
        return this.images.apply(job.tenantId, job.operationId, job.previewId);
      case "refresh":
        return this.refreshes.resume(job.tenantId, job.workId, job.stepId);
    }
  }
}
