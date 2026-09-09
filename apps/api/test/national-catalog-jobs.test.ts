import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  catalogJobSchema,
  type CatalogJob,
} from "../src/modules/national-catalog/national-catalog-job-repository";
import {
  CATALOG_QUEUES,
  NationalCatalogJobsService,
} from "../src/modules/national-catalog/national-catalog-jobs.service";
function fixture(jobs: CatalogJob[] = []) {
  const repository = { claim: vi.fn(async () => jobs) };
  const sessions = {
    releaseExpired: vi.fn(async () => 0),
    resume: vi.fn<() => Promise<void>>(async () => undefined),
  };
  const previews = { resumePreparation: vi.fn(async () => undefined) };
  const applies = { resume: vi.fn<() => Promise<void>>(async () => undefined) };
  const images = {
    resume: vi.fn<() => Promise<void>>(async () => undefined),
    apply: vi.fn(async () => undefined),
    releaseExpired: vi.fn(async () => 0),
  };
  const refreshes = { resume: vi.fn<() => Promise<void>>(async () => undefined) };
  return {
    repository,
    sessions,
    previews,
    applies,
    images,
    refreshes,
    service: new NationalCatalogJobsService(
      repository,
      sessions,
      previews,
      applies,
      images,
      refreshes,
    ),
  };
}
describe("National Catalog durable job dispatcher", () => {
  const tenantId = "tenant";
  const workId = randomUUID();
  const sessionId = randomUUID();
  const stepId = randomUUID();
  const previewId = randomUUID();
  const candidateId = randomUUID();
  const operationId = randomUUID();
  const jobs: CatalogJob[] = [
    { kind: "enumerate", tenantId, workId, sessionId, stepId },
    { kind: "prepare", tenantId, workId, sessionId, stepId },
    { kind: "candidate", tenantId, workId, sessionId, previewId, candidateId, stepId },
    { kind: "apply", tenantId, workId, stepId: "product" },
    { kind: "accepted_image", tenantId, workId, operationId, previewId, stepId: "image" },
    { kind: "refresh", tenantId, workId, stepId },
  ];
  it("dispatches every durable kind with exact identities and fences", async () => {
    const f = fixture();
    for (const job of jobs) await f.service.execute(job);
    expect(f.sessions.resume).toHaveBeenCalledWith(tenantId, sessionId, stepId);
    expect(f.previews.resumePreparation).toHaveBeenCalledWith(tenantId, sessionId, workId, stepId);
    expect(f.images.resume).toHaveBeenCalledWith(
      tenantId,
      sessionId,
      previewId,
      candidateId,
      stepId,
    );
    expect(f.applies.resume).toHaveBeenCalledWith(tenantId, workId);
    expect(f.images.apply).toHaveBeenCalledWith(tenantId, operationId, previewId);
    expect(f.refreshes.resume).toHaveBeenCalledWith(tenantId, workId, stepId);
  });
  it("retains work after success, duplicate sender and failure and bounds cleanup", async () => {
    const f = fixture(jobs);
    const original = structuredClone(jobs);
    const sender = vi.fn(async () => null);
    expect(await f.service.repair(sender)).toEqual({ selected: 6, sent: 6, failed: 0 });
    sender.mockRejectedValue(Error("queue down"));
    expect(await f.service.repair(sender)).toEqual({ selected: 6, sent: 0, failed: 6 });
    expect(jobs).toEqual(original);
    expect(f.repository.claim).toHaveBeenCalledWith(100);
    expect(f.images.releaseExpired).toHaveBeenCalledWith(expect.any(Date), 50);
    expect(sender).toHaveBeenCalledWith(
      CATALOG_QUEUES.enumerate,
      jobs[0],
      `enumerate:${tenantId}:${workId}:${stepId}`,
    );
  });
  it("rejects token/raw URL/actor and malformed job IDs", () => {
    for (const job of jobs)
      for (const extra of [
        { token: "secret" },
        { url: "https://secret.invalid" },
        { actor: { kind: "system" } },
      ])
        expect(catalogJobSchema.safeParse({ ...job, ...extra }).success).toBe(false);
    expect(catalogJobSchema.safeParse({ ...jobs[0], stepId: "wrong" }).success).toBe(false);
  });
  it("awaits service settlement before acknowledging a queue callback", async () => {
    const f = fixture();
    let release: () => void = () => {};
    f.sessions.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const work = f.service.execute(jobs[0]).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await work;
    expect(settled).toBe(true);
  });
});
