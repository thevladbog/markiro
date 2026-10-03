import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { PlanView } from "../src/us/plans/view.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { list, profile, published, renderPlanUi } from "./us-plans-fixtures.js";

const bytes = new TextEncoder().encode("%PDF-1.7\nExact stored English PDF");
function pdf() {
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="traceability-plan.pdf"',
    },
  });
}
function setup(available = true, locale = "en-US", superseded = false, workspace = false) {
  const detail = {
    ...published,
    status: superseded ? "superseded" : "effective",
    supersededAt: superseded ? published.approvedAt : null,
    retainThrough: superseded ? "2031-10-01" : null,
    artifact: {
      ...published.artifact,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
    },
  };
  const send = vi.fn<typeof fetch>(async (path) => {
    if (String(path).endsWith("/access"))
      return Response.json({
        capabilities: ["traceability.read", "traceability.qa.manage", "traceability.export.read"],
      });
    if (String(path).endsWith("/plans"))
      return Response.json({
        ...list,
        publicationAvailability: available ? "available" : "artifact_storage_unconfigured",
      });
    if (String(path).endsWith("/pdf")) return pdf();
    return Response.json(detail);
  });
  const props = {
    client: createUsBrowserClient(send),
    profile,
    canManageQa: true,
    canExport: true,
    onForbidden: vi.fn(async () => undefined),
    onSessionLost: vi.fn(),
    onDirtyChange: vi.fn(),
    onOpenProfile: vi.fn(),
    onOpenLocations: vi.fn(),
    onOpenProducts: vi.fn(),
  };
  const ui = renderPlanUi(
    workspace ? (
      <MasterDataWorkspace
        client={props.client}
        profile={profile}
        organization={{ id: "tenant", name: "Tenant" }}
        onBack={vi.fn()}
        onSessionLost={props.onSessionLost}
      />
    ) : (
      <PlanView {...props} />
    ),
    locale,
  );
  return { send, props, ui };
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:published");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["en-US", "es-US"])(
  "downloads exact immutable bytes with versioned filename in %s and revokes the URL",
  async (locale) => {
    const { send } = setup(true, locale, true);
    await userEvent.click(
      await screen.findByRole("button", { name: locale === "en-US" ? "View v2" : "Ver v2" }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: locale === "en-US" ? "Download published PDF" : "Descargar PDF publicado",
      }),
    );
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce());
    const anchor = vi.mocked(HTMLAnchorElement.prototype.click).mock.instances[0];
    if (!(anchor instanceof HTMLAnchorElement)) throw new Error("download anchor missing");
    expect(anchor?.download).toBe("traceability-plan-v2.pdf");
    expect(anchor?.href).toBe("blob:published");
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const blob: unknown = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    if (!(blob instanceof Blob)) throw new Error("missing PDF blob");
    const downloaded = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        reader.result instanceof ArrayBuffer
          ? resolve(reader.result)
          : reject(new Error("invalid blob result"));
      reader.onerror = () => reject(new Error("unreadable blob"));
      reader.readAsArrayBuffer(blob);
    });
    expect(Array.from(new Uint8Array(downloaded))).toEqual(Array.from(bytes));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:published"));
    expect(send.mock.calls.filter(([url]) => String(url).endsWith("/preview"))).toHaveLength(0);
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  },
);

it("disables only published download when storage is not configured", async () => {
  const { send } = setup(false);
  await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
  const download = await screen.findByRole("button", { name: "Download published PDF" });
  expect(download.hasAttribute("disabled")).toBe(true);
  await userEvent.click(download);
  expect(screen.getAllByText(/artifact storage is not configured/).length).toBeGreaterThan(0);
  expect(screen.getByText("Frozen snapshot")).toBeTruthy();
  expect(send.mock.calls.filter(([url]) => String(url).endsWith("/pdf"))).toHaveLength(0);
});

it.each([true, false])(
  "restores published download only after refreshed export access, restored=%s",
  async (restored) => {
    const { send } = setup(true, "en-US", false, true);
    await userEvent.click(await screen.findByRole("button", { name: "Plan" }));
    await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
    const download = await screen.findByRole("button", { name: "Download published PDF" });
    const base = send.getMockImplementation();
    if (!base) throw new Error("missing transport");
    let recover!: (response: Response) => void;
    let denied = false;
    send.mockImplementation((path, init) => {
      if (String(path).endsWith("/pdf") && !denied) {
        denied = true;
        return Promise.resolve(Response.json({ code: "forbidden" }, { status: 403 }));
      }
      if (String(path).endsWith("/access"))
        return new Promise<Response>((resolve) => {
          recover = resolve;
        });
      return base(path, init);
    });
    await userEvent.click(download);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Download published PDF" })).toBeNull(),
    );
    await act(async () =>
      recover(
        Response.json({
          capabilities: restored
            ? ["traceability.read", "traceability.export.read"]
            : ["traceability.read"],
        }),
      ),
    );
    if (!restored) {
      expect(screen.queryByRole("button", { name: "Download published PDF" })).toBeNull();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      return;
    }
    await userEvent.click(await screen.findByRole("button", { name: "Download published PDF" }));
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:published");
  },
);

it.each([403, 503])("handles raced download %i without creating a URL", async (status) => {
  const { send, props } = setup();
  await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
  const download = await screen.findByRole("button", { name: "Download published PDF" });
  send.mockResolvedValueOnce(
    Response.json(
      { code: status === 403 ? "forbidden" : "us_plan_artifact_storage_unconfigured" },
      { status },
    ),
  );
  await userEvent.click(download);
  expect(
    await screen.findByText(status === 403 ? /Your access changed/ : /Publication unavailable/, {
      selector: '[role="alert"]',
    }),
  ).toBeTruthy();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  if (status === 403) expect(props.onForbidden).toHaveBeenCalledOnce();
});

it("rejects PDF bytes that differ from the frozen hash and length", async () => {
  const { send } = setup();
  await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
  const download = await screen.findByRole("button", { name: "Download published PDF" });
  send.mockResolvedValueOnce(
    new Response("%PDF-other bytes", {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="traceability-plan.pdf"',
      },
    }),
  );
  await userEvent.click(download);
  expect(
    await screen.findByText(/The published PDF could not/, { selector: '[role="alert"]' }),
  ).toBeTruthy();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("does not allocate a download URL after detail closes with a pending request", async () => {
  const { send } = setup();
  await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
  const download = await screen.findByRole("button", { name: "Download published PDF" });
  let resolve!: (response: Response) => void;
  send.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await userEvent.click(download);
  await userEvent.click(screen.getByRole("button", { name: "Close version" }));
  await act(async () => resolve(pdf()));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
