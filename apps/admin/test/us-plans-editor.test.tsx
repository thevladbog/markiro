import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { UsPlanDraftSaveBody } from "@markiro/platform-contracts";
import { PlanEditor } from "../src/us/plans/editor.js";
import { PlanView } from "../src/us/plans/view.js";
import { UsClientError } from "../src/us/client.js";
import {
  draft,
  sections,
  profile,
  renderPlanUi,
  clientFixture,
  list,
  published,
} from "./us-plans-fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup() {
  if (draft.status !== "draft") throw new Error("draft fixture");
  const savedDraft = draft;
  const onSave = vi.fn(async (_id: string, body: UsPlanDraftSaveBody) => ({
    ...savedDraft,
    ...body,
    draftRevision: body.expectedRevision + 1,
  }));
  const props = {
    draft: savedDraft,
    profile,
    onSave,
    onDirtyChange: vi.fn(),
    onOpenProfile: vi.fn(),
    onOpenLocations: vi.fn(),
    onOpenProducts: vi.fn(),
    onReload: vi.fn(async () => savedDraft),
    canManageQa: true,
    onForbidden: vi.fn(async () => undefined),
    onSessionLost: vi.fn(),
  };
  return { props, onSave };
}
it("edits all six sections as plain text and saves only acknowledged revisions with nullable email", async () => {
  const { props, onSave } = setup();
  renderPlanUi(<PlanEditor {...props} />);
  expect(screen.getByRole("heading", { name: "v3 · DRAFT — not effective" })).toBe(
    document.activeElement,
  );
  expect(screen.getAllByRole("tab")).toHaveLength(6);
  fireEvent.change(screen.getByLabelText("System of record"), {
    target: { value: "<b>Operator</b>" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Add Record formats" }));
  fireEvent.change(screen.getByLabelText("Record formats 2"), { target: { value: "CSV\nPDF" } });
  await userEvent.click(screen.getByRole("tab", { name: "FTL identification" }));
  fireEvent.change(screen.getByLabelText("Procedure"), { target: { value: "Identify" } });
  await userEvent.click(screen.getByRole("tab", { name: "TLC assignment" }));
  fireEvent.change(screen.getByLabelText("Procedure"), { target: { value: "Assign" } });
  await userEvent.click(screen.getByRole("tab", { name: "Point of contact" }));
  fireEvent.change(screen.getByLabelText("Contact email"), { target: { value: "" } });
  await userEvent.click(screen.getByRole("tab", { name: "Farm activity" }));
  await userEvent.selectOptions(screen.getByLabelText("Farm activity status"), "unknown");
  expect(screen.getByText(/Yes or unknown blocks/)).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "Review and update" }));
  fireEvent.change(screen.getByLabelText("Procedure"), { target: { value: "Review" } });
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(onSave).toHaveBeenLastCalledWith(
    draft.id,
    expect.objectContaining({
      expectedRevision: 1,
      sections: expect.objectContaining({
        recordMaintenance: expect.objectContaining({
          systemOfRecord: "<b>Operator</b>",
          formats: ["PDF", "CSV\nPDF"],
        }),
        pointOfContact: expect.objectContaining({ email: null }),
        farmActivity: expect.objectContaining({ status: "unknown" }),
        ftlIdentification: expect.objectContaining({ procedure: "Identify" }),
        tlcAssignment: { procedure: "Assign" },
        reviewAndUpdate: { procedure: "Review" },
      }),
    }),
  );
  expect(await screen.findByText("Saved revision 2")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Procedure"), { target: { value: "Review again" } });
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(onSave).toHaveBeenLastCalledWith(
    draft.id,
    expect.objectContaining({ expectedRevision: 2 }),
  );
});

it.each(["en-US", "es-US"])(
  "keeps every section and labelled control keyboard accessible in %s at narrow width",
  async (locale) => {
    const { props } = setup();
    vi.stubGlobal("innerWidth", 375);
    const { container } = renderPlanUi(<PlanEditor {...props} />, locale);
    const tabs = screen.getAllByRole("tab");
    tabs[0]?.focus();
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(tabs[5]);
    expect(screen.getByRole("tabpanel").id).toBe(tabs[5]?.getAttribute("aria-controls"));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs[0]);
    for (const tab of tabs) {
      await userEvent.click(tab);
      for (const control of screen.getAllByRole("textbox")) {
        expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
        const help = control.getAttribute("aria-describedby");
        if (help)
          for (const id of help.split(" ")) expect(document.getElementById(id)).not.toBeNull();
      }
    }
    expect(container.textContent).not.toMatch(/usPlan\.|[А-Яа-яЁё]/);
    vi.unstubAllGlobals();
  },
);
it("bounds array rows at 50 and permits removal without merging paragraphs", async () => {
  const { props } = setup();
  props.draft = {
    ...props.draft,
    sections: {
      ...props.draft.sections,
      recordMaintenance: {
        ...sections.recordMaintenance,
        narrative: Array.from({ length: 50 }, (_, i) => `Paragraph ${i}`),
      },
    },
  };
  renderPlanUi(<PlanEditor {...props} />);
  expect(screen.getByRole("button", { name: "Add Procedures" }).hasAttribute("disabled")).toBe(
    true,
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove Procedures 1" }));
  expect(screen.getByLabelText("Procedures 1").getAttribute("maxlength")).toBe("4096");
  expect((screen.getByLabelText("Procedures 1") as HTMLTextAreaElement).value).toBe("Paragraph 1");
  expect(screen.getByRole("button", { name: "Add Procedures" }).hasAttribute("disabled")).toBe(
    false,
  );
});
it("requires a change summary for later versions and distinguishes current context and synthetic statements", async () => {
  const { props, onSave } = setup();
  renderPlanUi(<PlanEditor {...props} />);
  expect(screen.getByText("Synthetic demo — not an operational record")).toBeTruthy();
  expect(screen.getByText("Derived from configuration")).toBeTruthy();
  expect(screen.getByText("Operator statement — not confirmed")).toBeTruthy();
  expect(screen.getByText("America/Los_Angeles")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Change summary"), { target: { value: " " } });
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText(/required from version 2/)).toBeTruthy();
});
it("retains local text on stale save and reloads only after explicit discard", async () => {
  const { props, onSave } = setup();
  onSave.mockRejectedValue(new UsClientError("us_plan_revision_conflict"));
  renderPlanUi(<PlanEditor {...props} />);
  fireEvent.change(screen.getByLabelText("System of record"), {
    target: { value: "Keep my text" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect((screen.getByLabelText("System of record") as HTMLInputElement).value).toBe(
    "Keep my text",
  );
  expect(props.onReload).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Reload and discard local edits" }));
  await waitFor(() =>
    expect((screen.getByLabelText("System of record") as HTMLInputElement).value).toBe(
      "Frozen system",
    ),
  );
});
it("locks writes and refreshes access after a forbidden save while preserving local text", async () => {
  const { props, onSave } = setup();
  onSave.mockRejectedValue(new UsClientError("forbidden"));
  renderPlanUi(<PlanEditor {...props} />);
  fireEvent.change(screen.getByLabelText("System of record"), {
    target: { value: "Keep after 403" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(props.onForbidden).toHaveBeenCalledOnce();
  expect((screen.getByLabelText("System of record") as HTMLInputElement).value).toBe(
    "Keep after 403",
  );
  expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(true);
});
it.each([false, true])(
  "creates a server-acknowledged draft with effective prefill=%s",
  async (prefill) => {
    if (draft.status !== "draft") throw new Error("draft fixture");
    const { client } = clientFixture();
    vi.spyOn(client, "listPlans").mockResolvedValue({
      ...list,
      items: prefill ? list.items.filter((item) => item.status === "effective") : [],
    });
    const create = vi.spyOn(client, "createPlan").mockResolvedValue(draft);
    renderPlanUi(
      <PlanView
        client={client}
        profile={profile}
        canManageQa
        canExport={false}
        onForbidden={vi.fn(async () => undefined)}
        onSessionLost={vi.fn()}
        onDirtyChange={vi.fn()}
        onOpenProfile={vi.fn()}
        onOpenProducts={vi.fn()}
        onOpenLocations={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New draft" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "New draft" }));
    await screen.findByRole("button", { name: "Save draft" });
    expect(create).toHaveBeenCalledWith({
      changeSummary: "",
      sections: prefill
        ? published.snapshot.sections
        : {
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
            farmActivity: { status: "unknown", explanation: "" },
            reviewAndUpdate: { procedure: "" },
          },
    });
  },
);
