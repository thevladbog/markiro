import { test, expect } from "@playwright/test";
import {
  platformCapabilitiesForRole,
  platformReportSchema,
} from "../../../packages/platform-contracts/src/index.js";

for (const attachment of [true, false]) {
  test(`downloads in the current tab after an asynchronous POST (attachment=${attachment})`, async ({
    page,
    context,
    baseURL,
  }) => {
    const report = platformReportSchema.parse({
      id: "81111111-1111-4111-8111-111111111111",
      parameters: {
        reportType: "shifts",
        tenantIds: ["report-fixture"],
        fromDate: "2026-09-01",
        toDate: "2026-09-01",
        timezone: "Europe/Moscow",
        periodBasis: "events",
        privacy: "pseudonymous",
      },
      status: "ready",
      createdAt: "2026-09-01T00:00:00Z",
      snapshotAt: "2026-09-01T00:01:00Z",
      completedAt: "2026-09-01T00:02:00Z",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      errorCode: null,
      rowCount: 0,
      byteSize: 22,
      filename: "shifts.zip",
    });
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const fileUrl = `${baseURL}/report-fixture.zip`;
    // All API requests are intercepted: this test never contacts a real tenant backend.
    await context.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === "/api/platform-auth/get-session") {
          await route.fulfill({
            json: {
              session: { id: "fixture-session", expiresAt: "2027-01-01T00:00:00Z" },
              user: {
                id: "fixture-admin",
                email: "fixture@example.invalid",
                name: "Fixture",
                twoFactorEnabled: true,
              },
            },
          });
        } else if (path === "/api/platform/me") {
          await route.fulfill({
            json: {
              userId: "fixture-admin",
              role: "platform_admin",
              capabilities: platformCapabilitiesForRole.platform_admin,
              twoFactorReady: true,
            },
          });
        } else if (path === "/api/platform/tenants") {
          await route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } });
        } else if (path === "/api/platform/reports") {
          await route.fulfill({ json: { items: [report], nextOffset: null } });
        } else if (
          path === `/api/platform/reports/${report.id}/download` &&
          request.method() === "POST"
        ) {
          await responseGate;
          await route.fulfill({
            json: { url: fileUrl, filename: "shifts.zip", expiresInSeconds: 300 },
          });
        } else {
          await route.abort();
          throw new Error(`Unexpected fixture request: ${request.method()} ${path}`);
        }
      },
    );
    const zip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
    await context.route(fileUrl, (route) =>
      route.fulfill(
        attachment
          ? {
              contentType: "application/zip",
              headers: { "Content-Disposition": 'attachment; filename="shifts.zip"' },
              body: zip,
            }
          : { contentType: "text/html", body: "<h1>Report destination</h1>" },
      ),
    );
    await page.goto("/reports");
    await page.getByRole("button", { name: "RU", exact: true }).click();
    const downloadButton = page.getByRole("button", { name: /скачать/i });
    const requestPending = page.waitForRequest(
      (request) => request.url().endsWith(`/${report.id}/download`) && request.method() === "POST",
    );
    await downloadButton.click();
    await requestPending;
    await expect(page).toHaveURL("/reports");
    // Wait for real transient activation to expire, not an arbitrary sleep. The download
    // must not depend on permission to open a popup after this asynchronous response.
    await page.waitForFunction(() => !navigator.userActivation.isActive);
    const completion = attachment ? page.waitForEvent("download") : page.waitForURL(fileUrl);
    if (!releaseResponse) throw new Error("Response gate was not initialized");
    releaseResponse();
    const download = await completion;
    if (download) {
      expect(download.suggestedFilename()).toBe("shifts.zip");
      expect(await download.failure()).toBeNull();
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(zip);
    } else {
      await expect(page.getByRole("heading", { name: "Report destination" })).toBeVisible();
    }
    expect(context.pages()).toEqual([page]);
  });
}
