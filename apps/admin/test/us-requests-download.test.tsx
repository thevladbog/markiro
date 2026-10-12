import { cleanup, screen, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RequestDownloadButton } from "../src/us/requests/download.js";
import { renderPlanUi } from "./us-plans-fixtures.js";
import {
  deferred,
  requestRun,
  requestDetail,
  requestsFixture,
  renderRequests,
} from "./us-requests-fixtures.js";
import { UsClientError, createUsBrowserClient } from "../src/us/client.js";
import { createHash, webcrypto } from "node:crypto";
const artifact = {
  kind: "plan_pdf" as const,
  name: "plan.pdf" as const,
  mediaType: "application/pdf" as const,
  byteSize: 3,
  sha256: "a".repeat(64),
};
beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:owned"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("uses a fixed kind name and displays descriptor evidence", () => {
  renderPlanUi(
    <RequestDownloadButton
      artifact={artifact}
      disabled={false}
      active={false}
      onDownload={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Download Plan PDF" })).toBeTruthy();
  expect(screen.getByText(artifact.sha256)).toBeTruthy();
});
async function open() {
  const client = requestsFixture();
  vi.mocked(client.requests.getRun).mockResolvedValue(
    requestRun({ status: "ready", completedAt: "2026-10-05T00:00:00.000Z", artifacts: [artifact] }),
  );
  const ui = renderRequests({
    client,
    canExport: true,
    entry: { requestId: requestDetail().id, runId: requestRun().runId },
  });
  await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
  await screen.findByRole("button", { name: "Download Plan PDF" });
  return { client, ui };
}
it("permits export auditors, owns one download and revokes every URL after release", async () => {
  const { client } = await open();
  const pending = deferred<{ bytes: Uint8Array; filename: string; sha256: string }>();
  vi.mocked(client.requests.download).mockReturnValue(pending.promise);
  const button = screen.getByRole("button", { name: "Download Plan PDF" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(client.requests.download).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("button", { name: /^Download / }).length).toBe(6);
  await act(async () =>
    pending.resolve({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "plan.pdf",
      sha256: artifact.sha256,
    }),
  );
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:owned");
});
it.each([
  { canExport: false },
  { authorityPending: true },
  { entry: { requestId: requestDetail().id } },
  { organizationId: "other" },
])("fences verified late bytes across changed authority/selection/tenant %j", async (next) => {
  const { client, ui } = await open();
  const pending = deferred<{ bytes: Uint8Array; filename: string; sha256: string }>();
  vi.mocked(client.requests.download).mockReturnValue(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Download Plan PDF" }));
  const signal = vi.mocked(client.requests.download).mock.calls[0]?.[2];
  ui.rerenderRequests(next);
  await act(async () =>
    pending.resolve({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "plan.pdf",
      sha256: artifact.sha256,
    }),
  );
  expect(signal?.aborted).toBe(true);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
});
it("blocks a forbidden release before waiting for capability refresh", async () => {
  const { client, ui } = await open();
  const refresh = deferred<void>();
  vi.mocked(ui.props.onForbidden).mockReturnValue(refresh.promise);
  vi.mocked(client.requests.download).mockRejectedValue(new UsClientError("forbidden"));
  await userEvent.click(screen.getByRole("button", { name: "Download Plan PDF" }));
  expect(
    (screen.getByRole("button", { name: "Download Plan PDF" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  await act(async () => refresh.resolve());
});
it("a late actual hash after saved request revision changes never releases a Blob", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const client = requestsFixture();
  const descriptor = { ...artifact, sha256 };
  vi.mocked(client.requests.getRun).mockResolvedValue(
    requestRun({
      status: "ready",
      completedAt: "2026-10-05T00:00:00.000Z",
      artifacts: [descriptor],
    }),
  );
  const hash = deferred<ArrayBuffer>();
  vi.spyOn(webcrypto.subtle, "digest").mockReturnValue(hash.promise);
  const send = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(bytes, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="plan.pdf"',
        "content-length": "3",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    }),
  );
  vi.mocked(client.requests.download).mockImplementation(
    createUsBrowserClient(send).requests.download,
  );
  renderRequests({
    client,
    canExport: true,
    entry: { requestId: requestDetail().id, runId: requestRun().runId },
  });
  await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
  await userEvent.click(await screen.findByRole("button", { name: "Download Plan PDF" }));
  await waitFor(() => expect(webcrypto.subtle.digest).toHaveBeenCalled());
  vi.mocked(client.requests.get).mockResolvedValue(requestDetail({ revision: 2 }));
  await userEvent.click(screen.getByRole("button", { name: "Refresh request" }));
  await waitFor(() => expect((send.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true));
  await act(async () => hash.resolve(new Uint8Array(32).buffer));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
});
it("an actual deferred send is cancelled by unmount before any release", async () => {
  const { client, ui } = await open();
  const pending = deferred<Response>();
  const send = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
  vi.mocked(client.requests.download).mockImplementation(
    createUsBrowserClient(send).requests.download,
  );
  fireEvent.click(screen.getByRole("button", { name: "Download Plan PDF" }));
  ui.unmount();
  await act(async () => pending.resolve(new Response(null, { status: 403 })));
  expect((send.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
});
it("a click failure still revokes its registered URL and displays no provider details", async () => {
  const { client } = await open();
  vi.mocked(client.requests.download).mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    filename: "plan.pdf",
    sha256: artifact.sha256,
  });
  vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(() => {
    throw new Error("PRIVATE PROVIDER KEY");
  });
  await userEvent.click(screen.getByRole("button", { name: "Download Plan PDF" }));
  await screen.findByText(/Download could not be verified/);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:owned");
  expect(screen.queryByText("PRIVATE PROVIDER KEY")).toBeNull();
});
it("rechecks current authority immediately before clicking and revokes a URL already created", async () => {
  const { client, ui } = await open();
  vi.mocked(client.requests.download).mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    filename: "plan.pdf",
    sha256: artifact.sha256,
  });
  vi.mocked(URL.createObjectURL).mockImplementation(() => {
    ui.rerenderRequests({ canExport: false });
    return "blob:owned";
  });
  await userEvent.click(screen.getByRole("button", { name: "Download Plan PDF" }));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:owned");
});
it.each(["not_ready", "storage", "export"])(
  "blocks a %s download before transport",
  async (reason) => {
    const client = requestsFixture();
    if (reason !== "not_ready")
      vi.mocked(client.requests.getRun).mockResolvedValue(
        requestRun({
          status: "ready",
          completedAt: "2026-10-05T00:00:00.000Z",
          artifacts: [artifact],
        }),
      );
    if (reason === "storage")
      vi.mocked(client.requests.get).mockResolvedValue(
        requestDetail({ availability: { build: "available", packageStorage: "unconfigured" } }),
      );
    renderRequests({
      client,
      canExport: reason !== "export",
      entry: { requestId: requestDetail().id, runId: requestRun().runId },
    });
    await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
    await screen.findByRole("region", { name: "Frozen run" });
    const button = screen.getByRole("button", { name: "Download Plan PDF" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(client.requests.download).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  },
);
