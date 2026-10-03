import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsPlanValidationResponse } from "@markiro/platform-contracts";
import { ThemeProvider } from "@markiro/ui";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
import { PlanInspection } from "../src/us/plans/inspection.js";
import { PlanView } from "../src/us/plans/view.js";
import { createUsBrowserClient } from "../src/us/client.js";
import { draft, list, profile, renderPlanUi } from "./us-plans-fixtures.js";

const saved = (() => {
  if (draft.status !== "draft") throw new Error("draft fixture");
  return draft;
})();
function rerender(ui: ReturnType<typeof renderPlanUi>, node: ReactNode) {
  ui.rerender(
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={ui.instance}>{node}</I18nextProvider>
    </ThemeProvider>,
  );
}
function pdf(revision = 1) {
  return new Response("%PDF-1.7\nDRAFT — not effective", {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="traceability-plan.pdf"',
      "X-Plan-Draft-Revision": String(revision),
    },
  });
}
function setup(issues: UsPlanValidationResponse["issues"] = []) {
  const send = vi.fn<typeof fetch>(async (path) => {
    const url = String(path);
    if (url.endsWith("/validate"))
      return Response.json({
        versionId: saved.id,
        draftRevision: 1,
        issues,
        publicationAvailability: "artifact_storage_unconfigured",
      });
    if (url.endsWith("/preview")) return pdf();
    if (url.endsWith("/plans")) return Response.json(list);
    if (url.endsWith(`/plans/${saved.id}`)) return Response.json(saved);
    throw new Error("unexpected transport route");
  });
  const props = {
    client: createUsBrowserClient(send),
    draft: saved,
    dirty: false,
    saving: false,
    canValidate: true,
    canExport: true,
    onSection: vi.fn(),
    onOpenLocations: vi.fn(),
    onForbidden: vi.fn(async () => undefined),
    onSessionLost: vi.fn(),
  };
  return { props, send };
}
beforeEach(() => {
  let sequence = 0;
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:preview-${++sequence}`);
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses exact server issues and navigates contact, farm, wording and location fixes safely", async () => {
  const { props, send } = setup([
    { code: "required_field", section: "pointOfContact", path: "pointOfContact.phone" },
    { code: "farm_scope_unsupported", section: "farmActivity", path: "farmActivity.status" },
    { code: "prohibited_claim", section: "ftlIdentification", path: "ftlIdentification.procedure" },
    {
      code: "tlc_source_location_required",
      section: "tlcAssignment",
      path: "tlcSourceLocationCount",
    },
    { code: "private server text", section: "plan", path: "<script>private path</script>" },
  ]);
  renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Validate saved revision" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Point of contact: Complete/ }));
  expect(props.onSection).toHaveBeenLastCalledWith("pointOfContact");
  await userEvent.click(screen.getByRole("button", { name: /Farm activity: Declare/ }));
  expect(props.onSection).toHaveBeenLastCalledWith("farmActivity");
  await userEvent.click(screen.getByRole("button", { name: /FTL identification: Remove/ }));
  expect(props.onSection).toHaveBeenLastCalledWith("ftlIdentification");
  await userEvent.click(screen.getByRole("button", { name: /TLC assignment: Configure/ }));
  expect(props.onOpenLocations).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toMatch(/private server text|private path|<script>/);
  expect(send.mock.calls[0]?.[1]?.body).toBe(
    '{"expectedRevision":1,"confirmations":{"procedures":false,"backupAndRecovery":false,"contact":false,"nonFarmScope":false}}',
  );
});

it("collects four explicit advisory confirmations for an operational tenant without implying approval", async () => {
  const { props, send } = setup();
  renderPlanUi(<PlanInspection {...props} draft={{ ...saved, provenance: "operational" }} />);
  for (const checkbox of screen.getAllByRole("checkbox")) {
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(checkbox);
  }
  await userEvent.click(screen.getByRole("button", { name: "Validate saved revision" }));
  expect(await screen.findByText(/No server issues reported/)).toBeTruthy();
  expect(send.mock.calls[0]?.[1]?.body).toBe(
    '{"expectedRevision":1,"confirmations":{"procedures":true,"backupAndRecovery":true,"contact":true,"nonFarmScope":true}}',
  );
  expect(screen.getByText(/Approval requires fresh confirmations/)).toBeTruthy();
  await userEvent.click(screen.getAllByRole("checkbox")[0]!);
  expect(screen.queryByText(/No server issues reported/)).toBeNull();
});

it("does not manufacture a wording violation for a server-permitted negative disclaimer", async () => {
  const { props } = setup();
  renderPlanUi(
    <PlanInspection
      {...props}
      draft={{
        ...saved,
        sections: { ...saved.sections, tlcAssignment: { procedure: "not FDA approved" } },
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Validate saved revision" }));
  expect(await screen.findByText(/No server issues reported/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["en-US", "es-US"])(
  "previews a saved revision without artifact storage in %s and keeps English PDF bytes",
  async (locale) => {
    const { props, send } = setup();
    renderPlanUi(<PlanInspection {...props} />, locale);
    const button = screen.getByRole("button", {
      name: locale === "en-US" ? "Preview saved revision" : "Vista previa de revisión guardada",
    });
    await userEvent.click(button);
    const link = await screen.findByRole("link", {
      name: locale === "en-US" ? "Open PDF in new tab" : "Abrir PDF en una pestaña nueva",
    });
    expect(link.getAttribute("href")).toBe("blob:preview-1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("DRAFT — not effective")).toBeTruthy();
    expect(
      screen.getByText(
        locale === "en-US" ? "Preview of saved revision 1" : "Vista previa de revisión guardada 1",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        locale === "en-US"
          ? "Synthetic demo — not an operational record"
          : "Demostración sintética — no es un registro operativo",
      ),
    ).toBeTruthy();
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      body: '{"expectedRevision":1}',
      cache: "no-store",
    });
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(document.body.textContent).not.toMatch(/usPlan\./);
  },
);

it.each([
  { dirty: true, saving: false },
  { dirty: false, saving: true },
])("blocks validation and preview while editor state is %j", async (state) => {
  const { props, send } = setup();
  renderPlanUi(<PlanInspection {...props} {...state} />);
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await userEvent.click(screen.getByRole("button", { name: "Validate saved revision" }));
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByText(/Save your changes before/)).toBeTruthy();
});

it("revokes object URLs on replacement, close and unmount", async () => {
  const { props } = setup();
  const ui = renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await screen.findByRole("link");
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await waitFor(() => expect(screen.getByRole("link").getAttribute("href")).toBe("blob:preview-2"));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  await userEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(screen.queryByRole("link")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await screen.findByRole("link");
  ui.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-3");
});

it("does not reopen a preview closed while replacement bytes are pending", async () => {
  const { props, send } = setup();
  renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await screen.findByRole("link");
  let resolve!: (response: Response) => void;
  send.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await userEvent.click(screen.getByRole("button", { name: "Close preview" }));
  await act(async () => resolve(pdf()));
  expect(screen.queryByRole("link")).toBeNull();
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
});

it("drops an in-flight preview after unmount without allocating a URL", async () => {
  const { props, send } = setup();
  let resolve!: (response: Response) => void;
  send.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const ui = renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  ui.unmount();
  await act(async () => resolve(pdf()));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("drops a preview and resets advisory statements when the saved revision advances", async () => {
  const { props, send } = setup();
  const ui = renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(screen.getAllByRole("checkbox")[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await screen.findByRole("link");
  rerender(ui, <PlanInspection {...props} draft={{ ...saved, draftRevision: 2 }} />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  expect(screen.getAllByRole("checkbox")[0]?.getAttribute("aria-checked")).toBe("false");
  send.mockResolvedValueOnce(pdf(2));
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  expect(await screen.findByText("Preview of saved revision 2")).toBeTruthy();
  expect(send.mock.calls[1]?.[1]?.body).toBe('{"expectedRevision":2}');
});

it("rejects validation captured for another version", async () => {
  const { props, send } = setup();
  send.mockResolvedValueOnce(
    Response.json({
      versionId: "11111111-1111-4111-8111-111111111111",
      draftRevision: 1,
      issues: [],
      publicationAvailability: "available",
    }),
  );
  renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Validate saved revision" }));
  expect(await screen.findByText(/Reload the draft before checking/)).toBeTruthy();
  expect(screen.queryByText(/No server issues reported/)).toBeNull();
});

it("reports transport failures with safe local copy and permits retry", async () => {
  const { props, send } = setup();
  send.mockRejectedValueOnce(new Error("private server details"));
  renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(document.body.textContent).not.toContain("private server details");
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  expect(await screen.findByRole("link")).toBeTruthy();
});

it("handles expired sessions without retaining preview bytes", async () => {
  const { props, send } = setup();
  renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await screen.findByRole("link");
  send.mockResolvedValueOnce(Response.json({ code: "session_required" }, { status: 401 }));
  await userEvent.click(screen.getByRole("button", { name: "Validate saved revision" }));
  await waitFor(() => expect(props.onSessionLost).toHaveBeenCalledOnce());
  expect(screen.queryByRole("link")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
});

it.each(["preview", "validate"])(
  "ignores a delayed %s response after local edits",
  async (operation) => {
    const { props, send } = setup();
    let resolve!: (response: Response) => void;
    send.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const ui = renderPlanUi(<PlanInspection {...props} />);
    await userEvent.click(
      screen.getByRole("button", {
        name: operation === "preview" ? "Preview saved revision" : "Validate saved revision",
      }),
    );
    rerender(ui, <PlanInspection {...props} dirty />);
    await act(async () =>
      resolve(
        operation === "preview"
          ? pdf()
          : Response.json({
              versionId: saved.id,
              draftRevision: 1,
              issues: [],
              publicationAvailability: "available",
            }),
      ),
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/No server issues reported/)).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  },
);

it.each(["preview", "validate"])("rejects mismatched saved revision from %s", async (operation) => {
  const { props, send } = setup();
  send.mockResolvedValueOnce(
    operation === "preview"
      ? pdf(2)
      : Response.json({
          versionId: saved.id,
          draftRevision: 2,
          issues: [],
          publicationAvailability: "available",
        }),
  );
  renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(
    screen.getByRole("button", {
      name: operation === "preview" ? "Preview saved revision" : "Validate saved revision",
    }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText(/No server issues reported/)).toBeNull();
});

it("refreshes access after export denial and removes an existing preview when export access disappears", async () => {
  const { props, send } = setup();
  const ui = renderPlanUi(<PlanInspection {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await screen.findByRole("link");
  send.mockResolvedValueOnce(Response.json({ code: "forbidden" }, { status: 403 }));
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  await waitFor(() => expect(props.onForbidden).toHaveBeenCalledOnce());
  expect(screen.queryByRole("link")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  rerender(ui, <PlanInspection {...props} canExport={false} />);
  expect(screen.queryByRole("button", { name: "Preview saved revision" })).toBeNull();
});

it("focuses the issue's editor section and prevents preview of unsaved local text in PlanView", async () => {
  const { props, send } = setup([
    { code: "required_field", section: "pointOfContact", path: "pointOfContact.phone" },
  ]);
  renderPlanUi(
    <PlanView
      client={props.client}
      profile={profile}
      canManageQa
      canExport
      onForbidden={props.onForbidden}
      onSessionLost={props.onSessionLost}
      onDirtyChange={vi.fn()}
      onOpenProfile={vi.fn()}
      onOpenLocations={props.onOpenLocations}
      onOpenProducts={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  await userEvent.click(await screen.findByRole("button", { name: "Validate saved revision" }));
  await userEvent.click(await screen.findByRole("button", { name: /Point of contact: Complete/ }));
  expect(screen.getByRole("tabpanel").getAttribute("aria-label")).toBe("Point of contact");
  expect(screen.getByRole("tabpanel")).toBe(document.activeElement);
  fireEvent.change(screen.getByLabelText("Contact phone"), { target: { value: "Unsaved phone" } });
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  expect(send.mock.calls.filter(([url]) => String(url).endsWith("/preview"))).toHaveLength(0);
});

it("makes draft preview available in read-only detail to export-capable users", async () => {
  const { props } = setup();
  renderPlanUi(
    <PlanView
      client={props.client}
      profile={profile}
      canManageQa={false}
      canExport
      onForbidden={props.onForbidden}
      onSessionLost={props.onSessionLost}
      onDirtyChange={vi.fn()}
      onOpenProfile={vi.fn()}
      onOpenLocations={props.onOpenLocations}
      onOpenProducts={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "View v3" }));
  await userEvent.click(await screen.findByRole("button", { name: "Preview saved revision" }));
  expect(await screen.findByRole("link", { name: "Open PDF in new tab" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Validate saved revision" })).toBeNull();
});

it("blocks preview during a pending save and previews only the newly acknowledged revision", async () => {
  const { props, send } = setup();
  renderPlanUi(
    <PlanView
      client={props.client}
      profile={profile}
      canManageQa
      canExport
      onForbidden={props.onForbidden}
      onSessionLost={props.onSessionLost}
      onDirtyChange={vi.fn()}
      onOpenProfile={vi.fn()}
      onOpenLocations={props.onOpenLocations}
      onOpenProducts={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  fireEvent.change(await screen.findByLabelText("System of record"), {
    target: { value: "New saved procedure" },
  });
  let acknowledge!: (response: Response) => void;
  send.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        acknowledge = done;
      }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  expect(send.mock.calls.filter(([url]) => String(url).endsWith("/preview"))).toHaveLength(0);
  await act(async () =>
    acknowledge(
      Response.json({
        id: saved.id,
        versionNumber: 3,
        status: "draft",
        schemaVersion: 1,
        draftRevision: 2,
        changeSummary: "Next version",
        createdBy: saved.createdBy,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        statementOwnership: "operator_pending",
        sections: {
          ...saved.sections,
          recordMaintenance: {
            ...saved.sections.recordMaintenance,
            systemOfRecord: "New saved procedure",
          },
        },
      }),
    ),
  );
  send.mockResolvedValueOnce(pdf(2));
  await userEvent.click(screen.getByRole("button", { name: "Preview saved revision" }));
  expect(await screen.findByText("Preview of saved revision 2")).toBeTruthy();
  expect(send.mock.calls.at(-1)?.[1]?.body).toBe('{"expectedRevision":2}');
});
