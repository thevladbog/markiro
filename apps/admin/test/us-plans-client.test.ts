import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient, UsPlanValidationError } from "../src/us/client.js";

const id = "11111111-1111-4111-8111-111111111111";
const root = "/api/us/traceability/plans";
const sections = {
  recordMaintenance: {
    systemOfRecord: "",
    formats: [],
    recordLocations: [],
    responsibleRoles: [],
    backupAndRecovery: "",
    narrative: [],
  },
  ftlIdentification: { procedure: "", reviewCadence: "" },
  tlcAssignment: { procedure: "" },
  pointOfContact: { name: "", title: "", phone: "", email: null },
  farmActivity: { status: "no", explanation: "" },
  reviewAndUpdate: { procedure: "" },
};
const draft = {
  id,
  versionNumber: 1,
  status: "draft",
  draftRevision: 2,
  schemaVersion: 1,
  sections,
  changeSummary: "",
  createdBy: id,
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:00Z",
  statementOwnership: "operator_pending",
};
const confirmations = {
  procedures: true,
  backupAndRecovery: true,
  contact: true,
  nonFarmScope: true,
};
const list = { items: [], effectiveImpact: null, publicationAvailability: "available" };

describe("strict Plan JSON client", () => {
  it("uses fixed routes and the session policy for all seven JSON operations", async () => {
    const validation = {
      versionId: id,
      draftRevision: 2,
      issues: [],
      publicationAvailability: "available",
    };
    const approval = {
      id,
      versionNumber: 1,
      status: "effective",
      approvedAt: "2026-10-03T00:00:00Z",
      sha256: "a".repeat(64),
    };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(list))
      .mockResolvedValueOnce(Response.json({ ...draft, provenance: "operational" }))
      .mockResolvedValueOnce(Response.json(draft))
      .mockResolvedValueOnce(Response.json(draft))
      .mockResolvedValueOnce(Response.json(validation))
      .mockResolvedValueOnce(Response.json(approval))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createUsBrowserClient(send);
    expect(await client.listPlans()).toEqual(list);
    expect(await client.getPlan(id)).toEqual({ ...draft, provenance: "operational" });
    expect(await client.createPlan({ sections, changeSummary: "" })).toEqual(draft);
    expect(await client.savePlan(id, { expectedRevision: 2, sections, changeSummary: "" })).toEqual(
      draft,
    );
    expect(await client.validatePlan(id, { expectedRevision: 2, confirmations })).toEqual(
      validation,
    );
    expect(
      await client.approvePlan(id, { expectedRevision: 2, confirmations, idempotencyKey: id }),
    ).toEqual(approval);
    expect(await client.discardPlan(id, { expectedRevision: 2 })).toBeUndefined();
    expect(send.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      [root, "GET"],
      [`${root}/${id}`, "GET"],
      [root, "POST"],
      [`${root}/${id}`, "PUT"],
      [`${root}/${id}/validate`, "POST"],
      [`${root}/${id}/approve`, "POST"],
      [`${root}/${id}/discard`, "POST"],
    ]);
    for (const [, init] of send.mock.calls)
      expect(init).toMatchObject({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
  });

  it("rejects browser attribution and invalid paths before sending", async () => {
    const send = vi.fn<typeof fetch>();
    const client = createUsBrowserClient(send);
    for (const extra of [
      "tenantId",
      "actorId",
      "provenance",
      "pdfKey",
      "approvedAt",
      "versionId",
    ]) {
      await expect(
        client.createPlan({ sections, changeSummary: "", [extra]: id }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        client.approvePlan(id, {
          expectedRevision: 2,
          confirmations,
          idempotencyKey: id,
          [extra]: id,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(client.getPlan(`${id}/pdf`)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      client.savePlan(id, { expectedRevision: 0, sections, changeSummary: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      client.validatePlan(id, { expectedRevision: 2, confirmations, sections }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      client.discardPlan(id, { expectedRevision: 2, tenantId: id }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [401, { message: "private" }, "session_required"],
    [403, { code: "us_plan_profile_unsupported" }, "forbidden"],
    [404, { code: "us_plan_version_not_found" }, "us_plan_version_not_found"],
    [409, { code: "us_plan_revision_conflict" }, "us_plan_revision_conflict"],
    [409, { code: "us_plan_revision_conflict", secret: "private" }, "conflict"],
    [409, { code: "unknown" }, "conflict"],
    [
      503,
      { code: "us_plan_artifact_storage_unconfigured" },
      "us_plan_artifact_storage_unconfigured",
    ],
    [503, { code: "unknown", message: "private" }, "unavailable"],
  ])("maps status %s to safe code %s", async (status, body, code) => {
    const client = createUsBrowserClient(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status })),
    );
    await expect(client.listPlans()).rejects.toMatchObject({ code, message: code });
  });

  it("retains only strict validation issues from a 409", async () => {
    const issues = [{ section: "pointOfContact", path: "pointOfContact.phone", code: "required" }];
    const client = createUsBrowserClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ code: "us_plan_validation_failed", issues }, { status: 409 }),
        ),
    );
    const result = await client
      .approvePlan(id, { expectedRevision: 2, confirmations, idempotencyKey: id })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(UsPlanValidationError);
    expect(result).toMatchObject({ code: "us_plan_validation_failed", issues });
    const unsafe = createUsBrowserClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { code: "us_plan_validation_failed", issues: [{ ...issues[0], message: "private" }] },
            { status: 409 },
          ),
        ),
    );
    await expect(unsafe.listPlans()).rejects.toMatchObject({ code: "conflict" });
  });

  it.each([
    Response.json({ ...list, tenantId: id }),
    new Response("invalid"),
    new Response(null, { status: 204 }),
  ])("rejects malformed success JSON", async (response) => {
    await expect(
      createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(response)).listPlans(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([Response.json({}), new Response(null, { status: 205 })])(
    "accepts only exact 204 for discard",
    async (response) => {
      await expect(
        createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(response)).discardPlan(id, {
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ code: "invalid_response" });
    },
  );
});
