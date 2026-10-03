import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildUsPlanSnapshot } from "@markiro/domain";
import type {
  UsPlanDetailResponse,
  UsPlanDraftCreateBody,
  UsPlanDraftSaveBody,
  UsPlanListResponse,
} from "@markiro/platform-contracts";
import { createUsBrowserClient } from "../src/us/client.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { planCopy } from "../src/us/plans/copy.js";
import { draft, profile, published, renderPlanUi, sections } from "./us-plans-fixtures.js";

type Draft = Extract<UsPlanDetailResponse, { status: "draft" }>;
type Published = Exclude<UsPlanDetailResponse, Draft>;
type Locale = keyof typeof planCopy;
const englishPdf = new TextEncoder().encode("%PDF-1.7\nEnglish frozen traceability procedures");
const artifact = {
  sha256: createHash("sha256").update(englishPdf).digest("hex"),
  byteSize: englishPdf.length,
  rendererVersion: "synthetic-flow-fixture",
};

// This transport models saved revisions and immutable history. The actual client
// parses every response; it deliberately does not model server/legal acceptance.
function syntheticTransport(available = true) {
  const versions: UsPlanDetailResponse[] = [];
  const state = { failure: "", revoked: false };
  const availability = available ? "available" : "artifact_storage_unconfigured";
  const send = vi.fn<typeof fetch>(async (path, init) => {
    const url = String(path);
    if (url.endsWith("/access"))
      return Response.json({
        capabilities: state.revoked
          ? ["traceability.read"]
          : ["traceability.read", "traceability.qa.manage", "traceability.export.read"],
      });
    if (url.endsWith("/plans")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as UsPlanDraftCreateBody;
        if (draft.status !== "draft") throw new Error("draft fixture");
        const current: Draft = {
          ...draft,
          ...body,
          id: `11111111-1111-4111-8111-${String(versions.length + 1).padStart(12, "0")}`,
          versionNumber: versions.length + 1,
          draftRevision: 1,
        };
        versions.push(current);
        const ack = Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== "provenance"),
        );
        return Response.json(ack);
      }
      const items: UsPlanListResponse["items"] = versions.map((version) => {
        const base = {
          id: version.id,
          versionNumber: version.versionNumber,
          createdAt: version.createdAt,
          updatedAt: version.updatedAt,
          provenance: version.provenance,
        };
        return version.status === "draft"
          ? { ...base, status: "draft", draftRevision: version.draftRevision }
          : {
              ...base,
              status: version.status,
              approvedAt: version.approvedAt,
              supersededAt: version.supersededAt,
              retainThrough: version.retainThrough,
              artifact: version.artifact,
            };
      });
      return Response.json({ items, effectiveImpact: null, publicationAvailability: availability });
    }
    const current = versions.find((version) => url.includes(`/plans/${version.id}`));
    if (!current) return Response.json({ items: [], limit: 50, offset: 0 });
    if (url.endsWith("/preview") || url.endsWith("/pdf"))
      return new Response(englishPdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="traceability-plan.pdf"',
          ...(current.status === "draft"
            ? { "X-Plan-Draft-Revision": String(current.draftRevision) }
            : {}),
        },
      });
    if (current.status !== "draft") return Response.json(current);
    if (url.endsWith("/validate"))
      return Response.json({
        versionId: current.id,
        draftRevision: current.draftRevision,
        issues: [],
        publicationAvailability: availability,
      });
    if (url.endsWith("/approve")) {
      if (state.failure) {
        state.revoked = state.failure === "forbidden";
        return Response.json({ code: state.failure }, { status: state.revoked ? 403 : 409 });
      }
      for (const version of versions) {
        if (version.status === "effective") {
          version.status = "superseded";
          version.supersededAt = published.approvedAt;
          version.retainThrough = "2033-10-01";
        }
      }
      const effective: Published = {
        ...published,
        id: current.id,
        versionNumber: current.versionNumber,
        changeSummary: current.changeSummary,
        artifact,
        snapshot: buildUsPlanSnapshot(
          published.snapshot.configured,
          current.sections,
          "trusted_synthetic",
        ),
        comparisonAgainstCurrentConfiguredFacts: {
          changedSections: [],
          changedLocationIds: [],
          changedProductIds: [],
        },
      };
      versions[versions.indexOf(current)] = effective;
      return Response.json({
        id: effective.id,
        versionNumber: effective.versionNumber,
        status: "effective",
        approvedAt: effective.approvedAt,
        sha256: artifact.sha256,
      });
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as UsPlanDraftSaveBody;
      if (body.expectedRevision !== current.draftRevision)
        return Response.json({ code: "us_plan_revision_conflict" }, { status: 409 });
      current.sections = body.sections;
      current.changeSummary = body.changeSummary;
      current.draftRevision += 1;
      const ack = Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== "provenance"),
      );
      return Response.json(ack);
    }
    return Response.json(current);
  });
  return { send, state, versions };
}

function mount(locale: Locale, theme: "light" | "dark", available = true, generic = false) {
  localStorage.setItem("markiro.theme", theme);
  const transport = syntheticTransport(available);
  const ui = renderPlanUi(
    <MasterDataWorkspace
      client={createUsBrowserClient(transport.send)}
      profile={{ ...profile, code: generic ? "US_GENERIC_LOT_TRACEABILITY" : profile.code }}
      organization={{ id: "synthetic-tenant", name: "Synthetic tenant" }}
      onBack={vi.fn()}
      onSessionLost={vi.fn()}
    />,
    locale,
  );
  return { ...transport, ...ui };
}
function button(name: string) {
  return screen.getByRole("button", { name });
}
function versionText(template: string, version: number) {
  return template.replace("{{version}}", String(version));
}
async function enterDraft(copy: (typeof planCopy)[Locale]) {
  await userEvent.click(await screen.findByRole("button", { name: "Plan" }));
  expect(await screen.findByText(copy.empty)).toBeTruthy();
  await userEvent.click(button(copy.newDraft));
  await screen.findByLabelText(copy.fields.systemOfRecord);
}
async function saveText(copy: (typeof planCopy)[Locale], text: string) {
  const field = screen.getByLabelText(copy.fields.systemOfRecord);
  await userEvent.clear(field);
  await userEvent.type(field, text);
  await userEvent.click(button(copy.saveDraft));
  await screen.findByText(copy.savedRevision.replace("{{revision}}", "2"));
}
async function completeSections(copy: (typeof planCopy)[Locale]) {
  for (const field of ["formats", "recordLocations", "responsibleRoles", "narrative"] as const) {
    await userEvent.click(button(copy.addRow.replace("{{field}}", copy.fields[field])));
    await userEvent.type(
      screen.getByLabelText(`${copy.fields[field]} 1`),
      sections.recordMaintenance[field][0] ?? "Synthetic procedure",
    );
  }
  await userEvent.type(
    screen.getByLabelText(copy.fields.backupAndRecovery),
    sections.recordMaintenance.backupAndRecovery,
  );
  for (const section of ["ftlIdentification", "tlcAssignment", "reviewAndUpdate"] as const) {
    await userEvent.click(screen.getByRole("tab", { name: copy.fields[section] }));
    await userEvent.type(screen.getByLabelText(copy.fields.procedure), sections[section].procedure);
    if (section === "ftlIdentification")
      await userEvent.type(
        screen.getByLabelText(copy.fields.reviewCadence),
        sections.ftlIdentification.reviewCadence,
      );
  }
  await userEvent.click(screen.getByRole("tab", { name: copy.fields.pointOfContact }));
  for (const field of ["name", "title", "phone"] as const)
    await userEvent.type(screen.getByLabelText(copy.fields[field]), sections.pointOfContact[field]);
  await userEvent.click(screen.getByRole("tab", { name: copy.fields.farmActivity }));
  await userEvent.selectOptions(screen.getByLabelText(copy.fields.status), "no");
  await userEvent.type(
    screen.getByLabelText(copy.fields.explanation),
    sections.farmActivity.explanation,
  );
  await userEvent.click(screen.getByRole("tab", { name: copy.fields.recordMaintenance }));
}
async function checkApproval(copy: (typeof planCopy)[Locale]) {
  await userEvent.click(button(copy.approve));
  const dialog = screen.getByRole("dialog", { name: copy.approvalActions });
  for (const check of within(dialog).getAllByRole("checkbox")) await userEvent.click(check);
  await userEvent.click(within(dialog).getByRole("button", { name: copy.checkApproval }));
  await within(dialog).findByText(copy.approvalReady);
  return dialog;
}
async function blobBytes(blob: Blob) {
  return new Promise<number[]>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(Array.from(new Uint8Array(reader.result)))
        : reject(new Error("invalid blob"));
    reader.onerror = () => reject(new Error("unreadable blob"));
    reader.readAsArrayBuffer(blob);
  });
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:integrated-plan");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  localStorage.removeItem("markiro.theme");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const locale of ["en-US", "es-US"] as const) {
  for (const theme of ["light", "dark"] as const) {
    it(`completes saved revision, English PDF and retained v1/v2 history in ${locale}/${theme}`, async () => {
      const copy = planCopy[locale];
      const { send, versions, instance, container } = mount(locale, theme);
      await enterDraft(copy);
      expect(document.documentElement.dataset.theme).toBe(theme);
      expect(screen.getByRole("heading", { name: `v1 · ${copy.draftMark}` })).toBe(
        document.activeElement,
      );
      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        copy.fields.recordMaintenance,
        copy.fields.ftlIdentification,
        copy.fields.tlcAssignment,
        copy.fields.pointOfContact,
        copy.fields.farmActivity,
        copy.fields.reviewAndUpdate,
      ]);
      tabs[0]?.focus();
      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(tabs[5]);
      await userEvent.keyboard("{Home}");
      expect(document.activeElement).toBe(tabs[0]);
      const field = screen.getByLabelText(copy.fields.systemOfRecord);
      await userEvent.type(field, "Operator text stays English");
      await userEvent.tab();
      expect(document.activeElement).not.toBe(field);
      const alternate = locale === "en-US" ? "es-US" : "en-US";
      await act(() => instance.changeLanguage(alternate));
      expect(
        (screen.getByLabelText(planCopy[alternate].fields.systemOfRecord) as HTMLInputElement)
          .value,
      ).toBe("Operator text stays English");
      await act(() => instance.changeLanguage(locale));
      await completeSections(copy);
      await userEvent.click(button(copy.saveDraft));
      await screen.findByText(copy.savedRevision.replace("{{revision}}", "2"));
      await act(() => instance.changeLanguage(alternate));
      expect(
        screen.getByText(planCopy[alternate].savedRevision.replace("{{revision}}", "2")),
      ).toBeTruthy();
      await act(() => instance.changeLanguage(locale));
      await userEvent.click(button(copy.previewSaved));
      await screen.findByRole("link", { name: copy.openPreview });
      const previewBlob: unknown = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0];
      if (!(previewBlob instanceof Blob)) throw new Error("missing preview PDF");
      expect(await blobBytes(previewBlob)).toEqual(Array.from(englishPdf));
      await userEvent.click(button(copy.closePreview));
      await userEvent.click(button(copy.validateSaved));
      await screen.findByText(copy.noValidationIssues);
      const opener = button(copy.approve);
      await userEvent.click(opener);
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(document.activeElement).toBe(opener));
      const dialog = await checkApproval(copy);
      await userEvent.click(within(dialog).getByRole("button", { name: copy.approve }));
      await screen.findByRole("heading", { name: `v1 · ${copy.effective}` });
      expect(screen.getAllByText(copy.effective).some((node) => node.closest(".mk-chip--ok"))).toBe(
        true,
      );
      const first = JSON.stringify(versions[0]);
      await userEvent.click(button(copy.downloadPublished));
      await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce());
      const downloadBlob: unknown = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0];
      if (!(downloadBlob instanceof Blob)) throw new Error("missing published PDF");
      expect(await blobBytes(downloadBlob)).toEqual(Array.from(englishPdf));
      await userEvent.click(button(copy.newDraft));
      await screen.findByLabelText(copy.fields.systemOfRecord);
      expect((screen.getByLabelText(copy.fields.systemOfRecord) as HTMLInputElement).value).toBe(
        "Operator text stays English",
      );
      await userEvent.type(screen.getByLabelText(copy.changeSummary), "Reviewed v2 procedures");
      await saveText(copy, "Second version text");
      const secondDialog = await checkApproval(copy);
      await userEvent.click(within(secondDialog).getByRole("button", { name: copy.approve }));
      await screen.findByRole("heading", { name: `v2 · ${copy.effective}` });
      await userEvent.click(button(versionText(copy.view, 1)));
      await screen.findByRole("heading", { name: `v1 · ${copy.superseded}` });
      expect(screen.getByText("Operator text stays English")).toBeTruthy();
      const retained = versions[0];
      if (!retained || retained.status === "draft") throw new Error("missing retained version");
      expect({ ...retained, status: "effective", supersededAt: null, retainThrough: null }).toEqual(
        JSON.parse(first),
      );
      await userEvent.click(button(copy.downloadPublished));
      await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(2));
      const historicalBlob: unknown = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0];
      if (!(historicalBlob instanceof Blob)) throw new Error("missing historical PDF");
      expect(await blobBytes(historicalBlob)).toEqual(Array.from(englishPdf));
      expect(container.textContent).not.toMatch(/usPlan\.|[А-Яа-яЁё]/u);
      for (const [, init] of send.mock.calls)
        expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    });
  }
  it(`keeps editing and preview available without publication storage in ${locale}`, async () => {
    const copy = planCopy[locale];
    const { send } = mount(locale, "light", false);
    await enterDraft(copy);
    await saveText(copy, "Saved without store");
    await userEvent.click(button(copy.previewSaved));
    await screen.findByRole("link", { name: copy.openPreview });
    expect(button(copy.approve).hasAttribute("disabled")).toBe(true);
    await userEvent.click(button(copy.approve));
    expect(send.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(false);
    expect(screen.getAllByText(copy.publicationUnavailable).length).toBeGreaterThan(0);
  });
  for (const failure of ["us_plan_revision_conflict", "forbidden"] as const) {
    it(`preserves the draft and never claims approval after ${failure} in ${locale}`, async () => {
      const copy = planCopy[locale];
      const { state, send } = mount(locale, "dark");
      await enterDraft(copy);
      await saveText(copy, "Retain after conflict or revocation");
      const dialog = await checkApproval(copy);
      state.failure = failure;
      await userEvent.click(within(dialog).getByRole("button", { name: copy.approve }));
      await within(dialog).findByRole("alert");
      expect(screen.queryByRole("heading", { name: `v1 · ${copy.effective}` })).toBeNull();
      expect((screen.getByLabelText(copy.fields.systemOfRecord) as HTMLInputElement).value).toBe(
        "Retain after conflict or revocation",
      );
      expect(
        within(dialog).getByRole("button", { name: copy.approve }).hasAttribute("disabled"),
      ).toBe(true);
      if (failure === "forbidden") {
        await waitFor(() =>
          expect(send.mock.calls.filter(([url]) => String(url).endsWith("/access"))).toHaveLength(
            2,
          ),
        );
        await waitFor(() => expect(screen.queryByText(copy.approvalPending)).toBeNull());
        await userEvent.click(
          within(dialog).getAllByRole("button", { name: copy.cancel }).at(-1) as HTMLElement,
        );
        await waitFor(() =>
          expect(screen.queryByRole("button", { name: copy.approve })).toBeNull(),
        );
        expect(screen.queryByRole("button", { name: copy.previewSaved })).toBeNull();
      } else expect(within(dialog).getByRole("button", { name: copy.reloadSaved })).toBeTruthy();
    });
  }
  it(`omits Plan for the generic profile in ${locale}`, async () => {
    const { send } = mount(locale, "light", true, true);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
    expect(send.mock.calls.some(([url]) => String(url).includes("/plans"))).toBe(false);
  });
}

it("assigns every Plan cabinet suite to check-only CI and removes stale blanket Plan copy", () => {
  const workflow = readFileSync(
    join(__dirname, "../../../.github/workflows/us-development.yml"),
    "utf8",
  );
  for (const file of [
    "client.test.ts",
    "pdf-client.test.ts",
    "navigation.test.tsx",
    "versions.test.tsx",
    "editor.test.tsx",
    "inspection.test.tsx",
    "approval.test.tsx",
    "download.test.tsx",
    "flow.test.tsx",
  ])
    expect(workflow).toContain(`test/us-plans-${file}`);
  expect(workflow.match(/test\/us-plan-pdf\.test\.ts/gu)).toHaveLength(1);
  expect(workflow.match(/test\/us-plan-approval\.e2e\.test\.ts/gu)).toHaveLength(1);
  const app = readFileSync(join(__dirname, "../src/us/app.tsx"), "utf8");
  expect(app).not.toContain("Plan, request, and regulatory export workflows are not yet complete.");
  expect(app).not.toContain(
    "Los flujos de plan, solicitud y exportación regulatoria aún no están completos.",
  );
});

it("lets localized Plan status and provenance chips wrap inside narrow version rows", () => {
  const css = readFileSync(join(__dirname, "../src/us/plans/plans.css"), "utf8");
  const mobile = css.slice(css.indexOf("@media (max-width: 640px)"));
  expect(mobile).toMatch(
    /\.us-plan-versions \.mk-chip\s*\{[^}]*white-space:\s*normal\s*!important/su,
  );
  expect(mobile).toMatch(/\.us-plan-versions \.mk-chip\s*\{[^}]*height:\s*auto\s*!important/su);
  expect(mobile).toMatch(/\.us-plan-versions \.mk-chip\s*\{[^}]*max-width:\s*100%/su);
});
