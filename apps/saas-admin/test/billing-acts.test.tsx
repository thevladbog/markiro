import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, PLATFORM_ADMIN_ME, renderSaasApp } from "./render.js";

const TENANT_ID = "21111111-1111-4111-8111-111111111121";
const REQUEST_ID = "11111111-1111-4111-8111-111111111121";
const ACT_ID = "51111111-1111-4111-8111-111111111121";
const USER_ID = "61111111-1111-4111-8111-111111111121";
const now = "2026-08-28T08:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("platform billing act issue", () => {
  it("rejects non-PDF and oversized files before creating an act", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    renderSaasApp({
      initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
    });

    const input = await screen.findByLabelText("PDF акта");
    await user.upload(input, new File(["text"], "act.pdf", { type: "text/plain" }));
    expect(screen.getByRole("alert").textContent).toContain("только PDF");

    await user.upload(
      input,
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "oversized.pdf", {
        type: "application/pdf",
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain("5 МиБ");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("creates, uploads, and shows issued only from issued API metadata", async () => {
    const calls: Array<{ path: string; body: BodyInit | null | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ path: url, body: init?.body });
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/billing/acts")) {
          return jsonResponse(201, act("draft", null));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`)) {
          return jsonResponse(
            201,
            act("issued", {
              id: "71111111-1111-4111-8111-111111111121",
              revision: 1,
              state: "ready",
              contentType: "application/pdf",
              byteSize: 4,
              sha256: "a".repeat(64),
              uploadedByPlatformUserId: USER_ID,
              readyAt: now,
              createdAt: now,
              updatedAt: now,
            }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({
      initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
    });

    await user.type(await screen.findByLabelText("Номер акта"), "ACT-42");
    await user.type(screen.getByLabelText("Начало периода"), "2026-08-01");
    await user.type(screen.getByLabelText("Конец периода"), "2026-08-31");
    await user.upload(
      screen.getByLabelText("PDF акта"),
      new File(["%PDF"], "act.pdf", { type: "application/pdf" }),
    );
    expect(screen.queryByText("Акт выпущен")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));

    expect(await screen.findByText("Акт выпущен")).toBeDefined();
    const issue = calls.find((call) => call.path.endsWith("/issue"));
    expect(issue?.body).toBeInstanceOf(FormData);
    expect((issue?.body as FormData).get("file")).toBeInstanceOf(File);
    expect((issue?.body as FormData).get("idempotencyKey")).toMatch(/[0-9a-f-]{36}/);
    await waitFor(() => expect(calls).toHaveLength(3));
  });

  it("retries the exact issue attempt without creating a duplicate act", async () => {
    const createBodies: string[] = [];
    const issueBodies: FormData[] = [];
    let issueCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/billing/acts")) {
          if (typeof init?.body === "string") createBodies.push(init.body);
          return jsonResponse(201, act("draft", null));
        }
        if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`)) {
          if (init?.body instanceof FormData) issueBodies.push(init.body);
          issueCount += 1;
          if (issueCount === 1) return jsonResponse(503, { code: "storage_unavailable" });
          return jsonResponse(201, act("issued", readyDocument()));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderSaasApp({
      initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
    });

    await user.type(await screen.findByLabelText("Номер акта"), "ACT-42");
    await user.type(screen.getByLabelText("Начало периода"), "2026-08-01");
    await user.type(screen.getByLabelText("Конец периода"), "2026-08-31");
    await user.upload(
      screen.getByLabelText("PDF акта"),
      new File(["%PDF"], "act.pdf", { type: "application/pdf" }),
    );
    await user.click(screen.getByRole("button", { name: "Выпустить акт" }));
    await user.click(await screen.findByRole("button", { name: "Продолжить выпуск черновика" }));

    expect(await screen.findByText("Акт выпущен")).toBeDefined();
    expect(createBodies).toHaveLength(1);
    expect(issueBodies).toHaveLength(2);
    expect(issueBodies[0]?.get("idempotencyKey")).toBe(issueBodies[1]?.get("idempotencyKey"));
  });

  it.each(["billing_act_service_not_completed", "billing_act_period_not_closed"])(
    "retains a terminally rejected draft for %s and resumes without another create",
    async (terminalCode) => {
      let createCount = 0;
      let issueCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
          if (url.endsWith("/api/platform/billing/acts")) {
            createCount += 1;
            return jsonResponse(201, act("draft", null));
          }
          if (url.endsWith(`/api/platform/billing/acts/${ACT_ID}/issue`)) {
            issueCount += 1;
            if (issueCount === 1) {
              return jsonResponse(409, { code: terminalCode });
            }
            return jsonResponse(201, act("issued", readyDocument()));
          }
          throw new Error(`Unexpected request: ${url}`);
        }),
      );
      const user = userEvent.setup();
      const rendered = renderSaasApp({
        initialEntry: `/billing-acts/new?tenantId=${TENANT_ID}&requestId=${REQUEST_ID}`,
      });
      const invalidate = vi.spyOn(rendered.queryClient, "invalidateQueries");

      const number = await screen.findByLabelText("Номер акта");
      await user.type(number, "ACT-42");
      await user.type(screen.getByLabelText("Начало периода"), "2026-08-01");
      await user.type(screen.getByLabelText("Конец периода"), "2026-08-31");
      await user.upload(
        screen.getByLabelText("PDF акта"),
        new File(["%PDF"], "act.pdf", { type: "application/pdf" }),
      );
      await user.click(screen.getByRole("button", { name: "Выпустить акт" }));

      expect(await screen.findByText("Черновик акта сохранён")).toBeDefined();
      expect(number).toHaveProperty("disabled", true);
      await user.type(number, "-changed");
      expect(number).toHaveProperty("value", "ACT-42");
      expect(createCount).toBe(1);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["platform", "billing", "acts"] });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["platform", "billing", "requests", REQUEST_ID],
      });

      await user.click(screen.getByRole("button", { name: "Продолжить выпуск черновика" }));
      expect(await screen.findByText("Акт выпущен")).toBeDefined();
      expect(createCount).toBe(1);
      expect(issueCount).toBe(2);
    },
  );
});

function readyDocument() {
  return {
    id: "71111111-1111-4111-8111-111111111121",
    revision: 1,
    state: "ready",
    contentType: "application/pdf",
    byteSize: 4,
    sha256: "a".repeat(64),
    uploadedByPlatformUserId: USER_ID,
    readyAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function act(status: "draft" | "issued", document: unknown) {
  return {
    id: ACT_ID,
    tenantId: TENANT_ID,
    requestId: REQUEST_ID,
    invoiceId: null,
    orderedServiceId: null,
    number: "ACT-42",
    status,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    createdByPlatformUserId: USER_ID,
    issuedByPlatformUserId: status === "issued" ? USER_ID : null,
    issuedAt: status === "issued" ? now : null,
    cancelledByPlatformUserId: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    document,
  };
}
