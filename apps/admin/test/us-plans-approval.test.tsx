import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createUsBrowserClient } from "../src/us/client.js";
import { PlanView } from "../src/us/plans/view.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { draft, list, profile, published, renderPlanUi } from "./us-plans-fixtures.js";

const saved = (() => {
  if (draft.status !== "draft") throw new Error("draft fixture");
  return draft;
})();
function setup(
  options: { synthetic?: boolean; available?: boolean; strict?: boolean; workspace?: boolean } = {},
) {
  let approved = false;
  let discarded = false;
  const current = {
    ...saved,
    provenance: options.synthetic ? ("trusted_synthetic" as const) : ("operational" as const),
  };
  const effective = { ...published, id: saved.id, versionNumber: saved.versionNumber };
  const receipt = {
    id: saved.id,
    versionNumber: saved.versionNumber,
    status: "effective",
    approvedAt: published.approvedAt,
    sha256: published.artifact.sha256,
  };
  const send = vi.fn<typeof fetch>(async (path, init) => {
    const url = String(path);
    if (url.endsWith("/access"))
      return Response.json({
        capabilities: ["traceability.read", "traceability.qa.manage", "traceability.export.read"],
      });
    if (url.endsWith("/plans"))
      return Response.json({
        ...list,
        items: discarded
          ? []
          : approved
            ? [{ ...list.items[0], id: saved.id, versionNumber: 3 }]
            : list.items.filter((item) => item.id === saved.id),
        publicationAvailability:
          options.available === false ? "artifact_storage_unconfigured" : "available",
      });
    if (url.endsWith("/validate"))
      return Response.json({
        versionId: saved.id,
        draftRevision: current.draftRevision,
        issues: [],
        publicationAvailability: "available",
      });
    if (url.endsWith("/approve")) {
      approved = true;
      return Response.json(receipt);
    }
    if (url.endsWith("/discard")) {
      discarded = true;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith(`/plans/${saved.id}`)) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { sections: typeof saved.sections };
        current.draftRevision += 1;
        current.sections = body.sections;
        const ack = Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== "provenance"),
        );
        return Response.json(ack);
      }
      return Response.json(approved ? effective : current);
    }
    throw new Error("unexpected route");
  });
  const props = {
    client: createUsBrowserClient(send),
    profile,
    canManageQa: true,
    canExport: true,
    onForbidden: vi.fn(async () => undefined),
    onSessionLost: vi.fn(),
    onDirtyChange: vi.fn(),
    onMutationPendingChange: vi.fn(),
    onOpenProfile: vi.fn(),
    onOpenLocations: vi.fn(),
    onOpenProducts: vi.fn(),
  };
  const node = options.workspace ? (
    <MasterDataWorkspace
      client={props.client}
      profile={profile}
      organization={{ id: "tenant", name: "Tenant" }}
      onBack={vi.fn()}
      onSessionLost={props.onSessionLost}
    />
  ) : (
    <PlanView {...props} />
  );
  const ui = renderPlanUi(options.strict ? <StrictMode>{node}</StrictMode> : node);
  return { send, props, ui, receipt };
}
async function open() {
  await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
  return screen.getByRole("dialog");
}
async function ready(dialog: HTMLElement) {
  for (const check of within(dialog).getAllByRole("checkbox")) await userEvent.click(check);
  await userEvent.click(within(dialog).getByRole("button", { name: "Check for approval" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
}
function calls(send: ReturnType<typeof setup>["send"], suffix: string) {
  return send.mock.calls.filter(([url]) => String(url).endsWith(suffix));
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("can validate and approve after a StrictMode effect remount", async () => {
  setup({ strict: true });
  const dialog = await open();
  await ready(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("heading", { name: "v3 · Effective" })).toBeTruthy();
});

it.each([0, 1, 2, 3])(
  "blocks a real-tenant approval when confirmation %i is unchecked even after an empty issue response",
  async (missing) => {
    const { send } = setup();
    const dialog = await open();
    const checkboxes = within(dialog).getAllByRole("checkbox");
    for (const [index, check] of checkboxes.entries())
      if (index !== missing) await userEvent.click(check);
    await userEvent.click(within(dialog).getByRole("button", { name: "Check for approval" }));
    await within(dialog).findByText(/This saved revision passed/);
    const approve = within(dialog).getByRole("button", { name: "Approve" });
    expect(approve.hasAttribute("disabled")).toBe(true);
    const last = checkboxes[missing];
    if (!last) throw new Error("missing checkbox");
    await userEvent.click(last);
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(calls(send, "/approve")).toHaveLength(0);
  },
);

it("renders approval-time validation findings and handles expired sessions without claiming publication", async () => {
  const { send, props } = setup();
  const dialog = await open();
  await ready(dialog);
  send.mockResolvedValueOnce(
    Response.json(
      {
        code: "us_plan_validation_failed",
        issues: [
          { section: "farmActivity", code: "farm_scope_unsupported", path: "farmActivity.status" },
        ],
      },
      { status: 409 },
    ),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await within(dialog).findByText(/Farm activity: Declare/)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
    true,
  );
  send.mockResolvedValueOnce(Response.json({ code: "session_required" }, { status: 401 }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Check for approval" }));
  await waitFor(() => expect(props.onSessionLost).toHaveBeenCalledOnce());
  expect(screen.queryByRole("heading", { name: "v3 · Effective" })).toBeNull();
});

it("keeps an intent when the dialog reopens but resets confirmations and key after a saved revision change", async () => {
  const { send } = setup();
  let dialog = await open();
  await ready(dialog);
  send.mockRejectedValueOnce(new Error("lost response"));
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  await within(dialog).findByRole("alert");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  dialog = screen.getByRole("dialog");
  send.mockRejectedValueOnce(new Error("lost response again"));
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  await within(dialog).findByRole("alert");
  expect(calls(send, "/approve")[0]?.[1]?.body).toBe(calls(send, "/approve")[1]?.[1]?.body);
  await userEvent.keyboard("{Escape}");
  fireEvent.change(screen.getByLabelText("System of record"), {
    target: { value: "Saved revision two" },
  });
  expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Saved revision 2");
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  dialog = screen.getByRole("dialog");
  for (const check of within(dialog).getAllByRole("checkbox"))
    expect(check.getAttribute("aria-checked")).toBe("false");
  await ready(dialog);
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  await screen.findByRole("heading", { name: "v3 · Effective" });
  const first = JSON.parse(String(calls(send, "/approve")[0]?.[1]?.body)) as {
    idempotencyKey: string;
  };
  const last = JSON.parse(String(calls(send, "/approve")[2]?.[1]?.body)) as {
    idempotencyKey: string;
    expectedRevision: number;
  };
  expect(last.idempotencyKey).not.toBe(first.idempotencyKey);
  expect(last.expectedRevision).toBe(2);
});

it.each([true, false])(
  "recovers approval only after access refresh establishes restored=%s",
  async (restored) => {
    const { send } = setup({ workspace: true });
    await userEvent.click(await screen.findByRole("button", { name: "Plan" }));
    const dialog = await open();
    await ready(dialog);
    const base = send.getMockImplementation();
    if (!base) throw new Error("missing transport");
    let recover!: (response: Response) => void;
    let denied = false;
    send.mockImplementation((path, init) => {
      if (String(path).endsWith("/approve") && !denied) {
        denied = true;
        return Promise.resolve(Response.json({ code: "forbidden" }, { status: 403 }));
      }
      if (String(path).endsWith("/access"))
        return new Promise<Response>((resolve) => {
          recover = resolve;
        });
      return base(path, init);
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls(send, "/access")).toHaveLength(2));
    expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
      true,
    );
    await act(async () =>
      recover(
        Response.json({
          capabilities: restored
            ? ["traceability.read", "traceability.qa.manage", "traceability.export.read"]
            : ["traceability.read", "traceability.export.read"],
        }),
      ),
    );
    if (!restored) {
      expect(
        within(dialog).getByRole("button", { name: "Check for approval" }).hasAttribute("disabled"),
      ).toBe(true);
      return;
    }
    await userEvent.click(within(dialog).getByRole("button", { name: "Check for approval" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("heading", { name: "v3 · Effective" })).toBeTruthy();
  },
);

it("retries a failed post-approval refresh without sending another mutation", async () => {
  const { send } = setup();
  const dialog = await open();
  await ready(dialog);
  const base = send.getMockImplementation();
  if (!base) throw new Error("missing transport");
  let failRefresh = true;
  send.mockImplementation((path, init) => {
    if (String(path).endsWith("/plans") && failRefresh) {
      failRefresh = false;
      return Promise.reject(new Error("refresh offline"));
    }
    return base(path, init);
  });
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  await within(dialog).findByRole("alert");
  expect(screen.queryByRole("heading", { name: "v3 · Effective" })).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
    true,
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Refresh server state" }));
  expect(await screen.findByRole("heading", { name: "v3 · Effective" })).toBeTruthy();
  expect(calls(send, "/approve")).toHaveLength(1);
});

it("requires four fresh operational assertions and server validation, then reloads immutable detail", async () => {
  const { send } = setup();
  await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  // Advisory confirmations from Task 5 must never grant approval.
  for (const check of screen.getAllByRole("checkbox")) await userEvent.click(check);
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/You may approve your own draft/)).toBeTruthy();
  expect(within(dialog).getByText(/server records your user ID and approval time/)).toBeTruthy();
  for (const check of within(dialog).getAllByRole("checkbox"))
    expect(check.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(calls(send, "/approve")).toHaveLength(0);
  await ready(dialog);
  expect(JSON.parse(String(calls(send, "/validate")[0]?.[1]?.body))).toEqual({
    expectedRevision: 1,
    confirmations: { procedures: true, backupAndRecovery: true, contact: true, nonFarmScope: true },
  });
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("heading", { name: "v3 · Effective" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  expect(screen.getByText("PDF SHA-256")).toBeTruthy();
  expect(calls(send, "/plans")).toHaveLength(2);
  expect(calls(send, `/plans/${saved.id}`)).toHaveLength(2);
});

it("uses server synthetic provenance without a client demo toggle", async () => {
  const { send } = setup({ synthetic: true });
  const dialog = await open();
  expect(within(dialog).getByText("Synthetic demo — not an operational record")).toBeTruthy();
  expect(within(dialog).getAllByRole("checkbox")).toHaveLength(4);
  await userEvent.click(within(dialog).getByRole("button", { name: "Check for approval" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("heading", { name: "v3 · Effective" })).toBeTruthy();
  expect(JSON.parse(String(calls(send, "/approve")[0]?.[1]?.body))).toEqual({
    expectedRevision: 1,
    idempotencyKey: expect.any(String),
    confirmations: {
      procedures: false,
      backupAndRecovery: false,
      contact: false,
      nonFarmScope: false,
    },
  });
});

it("blocks approval without storage and during unsaved edits while leaving editor and inspection usable", async () => {
  const { send } = setup({ available: false });
  await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  expect((await screen.findByRole("button", { name: "Approve" })).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.getAllByText(/artifact storage is not configured/).length).toBeGreaterThan(0);
  expect(
    screen.getByRole("button", { name: "Preview saved revision" }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.change(screen.getByLabelText("System of record"), { target: { value: "Local work" } });
  expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(false);
  expect(calls(send, "/approve")).toHaveLength(0);
});

it("preserves an ambiguous approval intent across retry and suppresses duplicate clicks", async () => {
  const { send } = setup();
  const dialog = await open();
  await ready(dialog);
  let reject!: (reason: Error) => void;
  send.mockImplementationOnce(
    () =>
      new Promise<Response>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const approve = within(dialog).getByRole("button", { name: "Approve" });
  fireEvent.click(approve);
  fireEvent.click(approve);
  expect(calls(send, "/approve")).toHaveLength(1);
  await act(async () => reject(new Error("connection lost")));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  for (const check of within(dialog).getAllByRole("checkbox"))
    expect(check.hasAttribute("disabled")).toBe(true);
  await userEvent.click(approve);
  expect(await screen.findByRole("heading", { name: "v3 · Effective" })).toBeTruthy();
  expect(calls(send, "/approve")[0]?.[1]?.body).toBe(calls(send, "/approve")[1]?.[1]?.body);
});

it.each([
  "us_plan_revision_conflict",
  "us_plan_configuration_conflict",
  "us_plan_artifact_storage_unconfigured",
])("preserves the draft on %s", async (code) => {
  const { send } = setup();
  const dialog = await open();
  await ready(dialog);
  send.mockResolvedValueOnce(
    Response.json({ code }, { status: code.endsWith("unconfigured") ? 503 : 409 }),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.queryByRole("heading", { name: "v3 · Effective" })).toBeNull();
  expect(screen.getByLabelText("System of record").getAttribute("value")).toBe("Frozen system");
  expect(calls(send, "/plans")).toHaveLength(1);
});

it("renders safe server validation issues and never enables approval for them", async () => {
  const { send } = setup();
  const dialog = await open();
  for (const check of within(dialog).getAllByRole("checkbox")) await userEvent.click(check);
  send.mockResolvedValueOnce(
    Response.json({
      versionId: saved.id,
      draftRevision: 1,
      issues: [
        { section: "pointOfContact", code: "required_field", path: "pointOfContact.phone" },
        { section: "plan", code: "private text", path: "secret" },
      ],
      publicationAvailability: "available",
    }),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Check for approval" }));
  expect(await within(dialog).findByText(/Point of contact: Complete/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/private text|secret/);
  expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
    true,
  );
});

it("rejects validation of another revision and offers an explicit reload", async () => {
  const { send } = setup({ synthetic: true });
  const dialog = await open();
  send.mockResolvedValueOnce(
    Response.json({
      versionId: saved.id,
      draftRevision: 2,
      issues: [],
      publicationAvailability: "available",
    }),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Check for approval" }));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Reload saved draft" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
    true,
  );
});

it("refreshes access after approval denial and keeps the draft", async () => {
  const { send, props } = setup();
  const dialog = await open();
  await ready(dialog);
  send.mockResolvedValueOnce(Response.json({ code: "forbidden" }, { status: 403 }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(props.onForbidden).toHaveBeenCalledOnce());
  expect(within(dialog).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.queryByRole("heading", { name: "v3 · Effective" })).toBeNull();
});

it("requires explicit revision-checked discard and preserves the draft after failure", async () => {
  const { send } = setup();
  await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  await userEvent.click(await screen.findByRole("button", { name: "Discard draft" }));
  expect(calls(send, "/discard")).toHaveLength(0);
  const dialog = screen.getByRole("alertdialog");
  send.mockResolvedValueOnce(Response.json({ code: "us_plan_revision_conflict" }, { status: 409 }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Discard draft" }));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  expect(screen.getByLabelText("System of record")).toBeTruthy();
  expect(JSON.parse(String(calls(send, "/discard")[0]?.[1]?.body))).toEqual({
    expectedRevision: 1,
  });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard draft" }),
  );
  expect(await screen.findByRole("heading", { name: "No plan yet" })).toBeTruthy();
});
