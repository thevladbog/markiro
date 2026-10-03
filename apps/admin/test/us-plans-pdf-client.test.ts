import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const id = "11111111-1111-4111-8111-111111111111";
const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
function pdf(body: BodyInit = bytes, headers: Record<string, string> = {}) {
  return new Response(body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="traceability-plan.pdf"',
      "X-Plan-Draft-Revision": "2",
      ...headers,
    },
  });
}
describe("Plan PDF transport", () => {
  it("accepts the byte ceiling and a matching bounded length", async () => {
    const atLimit = new Uint8Array(8_000_000);
    atLimit.set(bytes);
    const result = await createUsBrowserClient(
      vi.fn<typeof fetch>().mockResolvedValue(pdf(atLimit, { "Content-Length": "8000000" })),
    ).downloadPlanPdf(id);
    expect(result.bytes.length).toBe(8_000_000);
    expect(Array.from(result.bytes.subarray(0, 5))).toEqual([37, 80, 68, 70, 45]);
  });
  it("rejects a missing preview revision or a different saved revision", async () => {
    const missing = pdf();
    missing.headers.delete("X-Plan-Draft-Revision");
    for (const response of [missing, pdf(bytes, { "X-Plan-Draft-Revision": "3" })]) {
      await expect(
        createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(response)).previewPlanPdf(
          id,
          { expectedRevision: 2 },
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("rejects redirected binary responses and absent bodies", async () => {
    const redirected = pdf();
    Object.defineProperty(redirected, "redirected", { value: true });
    const absent = new Response(null, { headers: pdf().headers });
    for (const response of [redirected, absent]) {
      await expect(
        createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(response)).downloadPlanPdf(
          id,
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("bounds the PDF request timeout without exposing the transport error", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn<typeof fetch>().mockImplementation(
        (_path, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("private transport detail")),
            );
          }),
      );
      const result = createUsBrowserClient(send).downloadPlanPdf(id);
      const assertion = expect(result).rejects.toMatchObject({
        code: "unavailable",
        message: "unavailable",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it("previews only a saved revision and downloads through fixed session routes", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(pdf()).mockResolvedValueOnce(pdf());
    const client = createUsBrowserClient(send);
    const preview = await client.previewPlanPdf(id, { expectedRevision: 2 });
    expect(Array.from(preview.bytes)).toEqual(Array.from(bytes));
    expect(preview).toMatchObject({ filename: "traceability-plan.pdf", draftRevision: 2 });
    const download = await client.downloadPlanPdf(id);
    expect(Array.from(download.bytes)).toEqual(Array.from(bytes));
    expect(download).toMatchObject({ filename: "traceability-plan.pdf", draftRevision: null });
    expect(send.mock.calls[0]).toEqual([
      `/api/us/traceability/plans/${id}/preview`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
        body: '{"expectedRevision":2}',
      }),
    ]);
    expect(send.mock.calls[1]).toEqual([
      `/api/us/traceability/plans/${id}/pdf`,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      }),
    ]);
  });
  it("rejects extra preview fields and invalid download IDs without fetching", async () => {
    const send = vi.fn<typeof fetch>();
    const client = createUsBrowserClient(send);
    await expect(
      client.previewPlanPdf(id, { expectedRevision: 2, sections: {} }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(client.downloadPlanPdf("https://signed.example/pdf")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { "Content-Type": "text/html" },
    { "Content-Disposition": 'attachment; filename="unsafe.pdf"' },
    { "Content-Length": "8000001" },
    { "Content-Length": "-1" },
    { "Content-Length": "1" },
    { "X-Plan-Draft-Revision": "0" },
    { "X-Plan-Draft-Revision": "1.5" },
    { "X-Plan-Draft-Revision": "9007199254740993" },
  ])("rejects malformed PDF headers %j", async (headers) => {
    await expect(
      createUsBrowserClient(
        vi.fn<typeof fetch>().mockResolvedValue(pdf(bytes, headers)),
      ).previewPlanPdf(id, { expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each(["", "HTML page"])('rejects invalid signature "%s"', async (body) => {
    await expect(
      createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(pdf(body))).downloadPlanPdf(id),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([{}, { "Content-Length": "5" }])(
    "cancels oversized actual streams with headers %j",
    async (headers) => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.enqueue(new Uint8Array(8_000_000));
        },
        cancel,
      });
      await expect(
        createUsBrowserClient(
          vi.fn<typeof fetch>().mockResolvedValue(pdf(stream, headers)),
        ).downloadPlanPdf(id),
      ).rejects.toMatchObject({ code: "invalid_response" });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it.each([
    [401, "session_required"],
    [403, "forbidden"],
    [404, "us_plan_version_not_found"],
    [409, "us_plan_revision_conflict"],
    [503, "us_plan_artifact_storage_unconfigured"],
  ])("safely maps PDF status %s", async (status, code) => {
    const response = Response.json({ code }, { status });
    await expect(
      createUsBrowserClient(vi.fn<typeof fetch>().mockResolvedValue(response)).downloadPlanPdf(id),
    ).rejects.toMatchObject({ code });
  });
});
