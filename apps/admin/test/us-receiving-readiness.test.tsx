import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { StrictMode } from "react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { receivingRecordSchema, type ReceivingRecord } from "@markiro/platform-contracts";
import { liveReadFixtureResponse } from "./support/us-receiving-live-fixture.js";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";

const id = "a0000000-0000-4000-8000-000000000001";
const path = "/api/us/traceability/receiving";
const record = {
  id,
  eventNumber: "REC-26-0001",
  status: "draft",
  revision: 1,
  draftVersion: 1,
  timeZone: "America/Chicago",
  createdBy: "actor",
  updatedBy: "actor",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  draft: {
    dateReceived: null,
    locationId: null,
    previousSourceLocationId: null,
    receivedAtNote: null,
    notes: null,
    items: [],
    documentIds: [],
  },
};
const complete = {
  eventId: id,
  draftVersion: 1,
  checkedAt: "2026-09-07T10:30:00.000Z",
  inputDigest: "a".repeat(64),
  ruleVersion: "receiving-readiness-v3",
  exemptReviewRequiredLines: [],
  profileCode: "US_FSMA204_PROCESSOR",
  state: "complete",
  issues: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup(
  options: {
    readOnly?: boolean;
    qa?: boolean;
    locale?: "en-US" | "es-US";
    handle?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  let current: ReceivingRecord = receivingRecordSchema.parse(record);
  const source: typeof fetch = async (url, init) => {
    const custom = options.handle?.(String(url), init);
    if (custom) return custom;
    if (url === "/api/us/traceability/access")
      return Response.json({
        capabilities: [
          "traceability.read",
          ...(options.readOnly ? [] : ["traceability.receiving.write"]),
          ...(options.qa ? ["traceability.qa.manage"] : []),
        ],
      });
    if (String(url).startsWith(`${path}?`)) {
      const header = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "draft"));
      return Response.json({
        items: [
          {
            ...header,
            dateReceived: null,
            locationId: null,
            previousSourceLocationId: null,
            lineCount: 0,
            documentCount: 0,
          },
        ],
        limit: 50,
        offset: 0,
      });
    }
    if (String(url).startsWith(`${path}/${id}/readiness`)) return Response.json(complete);
    if (url === `${path}/${id}` && init?.method === "GET") return Response.json(current);
    if ((url === path || url === `${path}/${id}`) && init?.method !== "GET") {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        ...record,
        draft: body.draft,
        draftVersion: body.expectedDraftVersion ? body.expectedDraftVersion + 1 : 1,
      });
    }
    return Response.json({ items: [], limit: 50, offset: 0 });
  };
  const send = vi.fn<typeof fetch>(async (url, init) => {
    const response = await source(url, init);
    if (init?.method && init.method !== "GET" && response.ok) {
      const parsed = receivingRecordSchema.safeParse(await response.clone().json());
      if (parsed.success) current = parsed.data;
    }
    return liveReadFixtureResponse(url, init, response);
  });
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: options.locale ?? "en-US",
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const onSessionLost = vi.fn();
  const view = render(
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <MasterDataWorkspace
            client={createUsBrowserClient(send)}
            organization={{ id: "synthetic", name: "North River Fresh Foods" }}
            profile={{
              code: "US_FSMA204_PROCESSOR",
              timeZone: "America/Chicago",
              retentionYears: 5,
              baselineVersion: "US-REG-2026-09-03",
              effectiveAt: record.createdAt,
            }}
            onBack={vi.fn()}
            onSessionLost={onSessionLost}
          />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", {
      name: options.locale === "es-US" ? "Recepción" : "Receiving",
    }),
  );
  await user.click(await screen.findByRole("button", { name: record.eventNumber }));
  await screen.findByRole("heading", { name: record.eventNumber });
  return { user, send, instance, onSessionLost, ...view };
}

function checkCalls(send: ReturnType<typeof vi.fn<typeof fetch>>) {
  return send.mock.calls.filter(([url]) => String(url).includes("/readiness"));
}

describe("saved receiving readiness", () => {
  it.each([
    { rootId: id, expectedLifecycleVersion: 2, previousRevisionId: null },
    {
      rootId: "b0000000-0000-4000-8000-000000000001",
      expectedLifecycleVersion: 1,
      previousRevisionId: "b0000000-0000-4000-8000-000000000001",
    },
  ])(
    "requires reload for a schema-valid readiness with a different lifecycle: %j",
    async (lifecycle) => {
      const { user, send } = await setup({
        qa: true,
        handle: (url) =>
          url.includes("/readiness")
            ? Response.json({ ...complete, ruleVersion: "receiving-readiness-v4", ...lifecycle })
            : undefined,
      });
      await user.click(screen.getByRole("button", { name: "Check saved draft" }));
      await screen.findByRole("button", { name: "Reload saved event" });
      expect(screen.queryByText("Complete — no blockers in this saved-data check.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();
      expect(checkCalls(send)).toHaveLength(1);
    },
  );
  it.each([
    {
      locale: "en-US" as const,
      qa: true,
      notice: "Pending QA review for saved exempt lines: 1, 3.",
      check: "Check saved draft",
    },
    {
      locale: "es-US" as const,
      qa: false,
      notice: "Revisión de Calidad pendiente para las líneas exentas guardadas: 1, 3.",
      check: "Revisar borrador guardado",
    },
  ])("shows the current exact pending-QA line notice in $locale with QA=$qa", async (testCase) => {
    const { user } = await setup({
      locale: testCase.locale,
      qa: testCase.qa,
      handle: (url) =>
        url.includes("/readiness")
          ? Response.json({ ...complete, exemptReviewRequiredLines: [1, 3] })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: testCase.check }));
    expect(await screen.findByText(testCase.notice)).toBeTruthy();
  });

  it("does not show a pending-QA notice for an ordinary-only readiness result", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText("Complete — no blockers in this saved-data check.");
    expect(screen.queryByText(/Pending QA review/)).toBeNull();
  });

  it("removes the pending-QA notice when the checked generation becomes stale", async () => {
    const { user } = await setup({
      handle: (url) =>
        url.includes("/readiness")
          ? Response.json({ ...complete, exemptReviewRequiredLines: [1, 3] })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText("Pending QA review for saved exempt lines: 1, 3.");
    await user.type(screen.getByLabelText("Receiving notes"), "Edit");
    expect(screen.queryByText("Pending QA review for saved exempt lines: 1, 3.")).toBeNull();
  });

  it("does not show a pending-QA notice from a late readiness response after editing", async () => {
    let resolve: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const { user } = await setup({
      handle: (url) => (url.includes("/readiness") ? pending : undefined),
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await user.type(screen.getByLabelText("Receiving notes"), "Edit while checking");
    await act(async () =>
      resolve?.(Response.json({ ...complete, exemptReviewRequiredLines: [1, 3] })),
    );
    expect(screen.queryByText("Pending QA review for saved exempt lines: 1, 3.")).toBeNull();
  });

  it("groups errors by header, line and documents and labels prior findings as stale", async () => {
    const { user, send } = await setup({
      handle: (url) =>
        url.includes("/readiness")
          ? Response.json({
              ...complete,
              state: "blocked",
              issues: [
                {
                  severity: "error",
                  group: "header",
                  line: null,
                  field: "previousSource",
                  code: "incomplete_description",
                  detail: "phoneNumber",
                },
                {
                  severity: "error",
                  group: "lines",
                  line: 1,
                  field: "product",
                  code: "format",
                  detail: "gtin",
                },
                {
                  severity: "error",
                  group: "lines",
                  line: 2,
                  field: "source",
                  code: "required",
                  detail: null,
                },
                {
                  severity: "error",
                  group: "documents",
                  line: null,
                  field: "documents",
                  code: "required",
                  detail: null,
                },
              ],
            })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText("4 required elements need attention.");
    const panel = screen.getByRole("region", { name: "Saved-draft data check" });
    expect(
      within(within(panel).getByRole("region", { name: "Header" })).getByText(
        "Previous source · Phone",
      ),
    ).toBeTruthy();
    expect(
      within(within(panel).getByRole("region", { name: "Lines" })).getByText(
        "Line 1 · Product · GTIN",
      ),
    ).toBeTruthy();
    expect(
      within(within(panel).getByRole("region", { name: "Lines" })).getByText("Line 2 · TLC source"),
    ).toBeTruthy();
    expect(
      within(within(panel).getByRole("region", { name: "Reference documents" })).getByText(
        "Link at least one reference document.",
      ),
    ).toBeTruthy();
    expect(checkCalls(send)[0]?.[0]).toBe(`${path}/${id}/readiness?expectedDraftVersion=1`);
    expect(checkCalls(send)[0]?.[1]?.method).toBe("GET");
    await user.type(screen.getByLabelText("Receiving notes"), "Edit");
    await screen.findByText("Previous findings — check again for current results");
    expect(within(panel).queryByText("4 required elements need attention.")).toBeNull();
    expect(within(panel).getByText("Line 2 · TLC source")).toBeTruthy();
    expect(checkCalls(send)).toHaveLength(1);
  });

  it("shows generic-profile warnings in Spanish without turning them into blockers", async () => {
    const { user } = await setup({
      locale: "es-US",
      handle: (url) =>
        url.includes("/readiness")
          ? Response.json({
              ...complete,
              profileCode: "US_GENERIC_LOT_TRACEABILITY",
              issues: [
                {
                  severity: "warning",
                  group: "documents",
                  line: null,
                  field: "documents",
                  code: "required",
                  detail: null,
                },
              ],
            })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Revisar borrador guardado" }));
    await screen.findByText(
      "Completo: esta revisión de los datos guardados no encontró bloqueos. 1 advertencia.",
    );
    const panel = screen.getByRole("region", { name: "Revisión de datos del borrador guardado" });
    expect(within(panel).getByText("Advertencia")).toBeTruthy();
    expect(
      within(panel).queryByText("Considere vincular al menos un documento de referencia."),
    ).not.toBeNull();
    expect(panel.textContent).not.toMatch(/receivingReadiness\./);
    expect(within(panel).queryByText("Obligatorio")).toBeNull();
  });

  it("checks only after an explicit click and hides success after edit, revert and save", async () => {
    const { user, send } = await setup();
    expect(checkCalls(send)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Check saved draft" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText("Complete — no blockers in this saved-data check.");
    expect(checkCalls(send)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /finalize|export/i })).toBeNull();
    await user.type(screen.getByLabelText("Receiving notes"), "Changed");
    expect(screen.queryByText("Complete — no blockers in this saved-data check.")).toBeNull();
    expect(screen.getByRole("button", { name: "Check saved draft" }).hasAttribute("disabled")).toBe(
      true,
    );
    await user.clear(screen.getByLabelText("Receiving notes"));
    expect(screen.queryByText("Complete — no blockers in this saved-data check.")).toBeNull();
    await screen.findByText("Previous check is out of date. Check the saved draft again.");
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText("Complete — no blockers in this saved-data check.");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(screen.queryByText("Complete — no blockers in this saved-data check.")).toBeNull();
    expect(checkCalls(send)).toHaveLength(2);
  });

  it("requires saving a new draft without silently creating it", async () => {
    const { user, send } = await setup();
    await user.click(screen.getByRole("button", { name: "Back to receiving" }));
    await user.click(await screen.findByRole("button", { name: "New receiving" }));
    expect(screen.getByRole("button", { name: "Check saved draft" }).hasAttribute("disabled")).toBe(
      true,
    );
    await screen.findByText("Save this draft before checking its data.");
    expect(
      send.mock.calls.filter(([, init]) => ["POST", "PUT"].includes(init?.method ?? "")),
    ).toHaveLength(0);
  });

  it("permits readers to check while saving remains unavailable", async () => {
    const { user } = await setup({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText("Complete — no blockers in this saved-data check.");
  });

  it("ignores an old in-flight result after input changes without locking the editor", async () => {
    let resolve: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const { user } = await setup({
      handle: (url) => (url.includes("/readiness") ? pending : undefined),
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText("Checking saved draft…");
    await user.type(screen.getByLabelText("Receiving notes"), "Keep this local note");
    await act(async () => resolve?.(Response.json(complete)));
    expect(screen.queryByText("Complete — no blockers in this saved-data check.")).toBeNull();
    expect((screen.getByLabelText("Receiving notes") as HTMLTextAreaElement).value).toBe(
      "Keep this local note",
    );
  });

  it("ignores a late result after a save advances the version and checks the new version explicitly", async () => {
    let resolve: ((response: Response) => void) | undefined;
    let checks = 0;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const { user, send } = await setup({
      handle: (url) => {
        if (!url.includes("/readiness")) return undefined;
        checks += 1;
        return checks === 1 ? pending : Response.json({ ...complete, draftVersion: 2 });
      },
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    await act(async () => resolve?.(Response.json(complete)));
    expect(screen.queryByText("Complete — no blockers in this saved-data check.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText("Complete — no blockers in this saved-data check.");
    expect(checkCalls(send)[1]?.[0]).toBe(`${path}/${id}/readiness?expectedDraftVersion=2`);
  });

  it("ignores a late session denial after the editor was closed", async () => {
    let resolve: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const { user, onSessionLost } = await setup({
      handle: (url) => (url.includes("/readiness") ? pending : undefined),
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await user.click(screen.getByRole("button", { name: "Back to receiving" }));
    await act(async () => resolve?.(Response.json({ code: "session_required" }, { status: 401 })));
    expect(onSessionLost).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Saved-draft data check" })).toBeNull();
  });

  it("hides an earlier success on failure and requires an explicit retry", async () => {
    let checks = 0;
    const { user, send } = await setup({
      handle: (url) => {
        if (!url.includes("/readiness")) return undefined;
        checks += 1;
        return checks === 1 ? Response.json(complete) : Promise.reject(new Error("offline"));
      },
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText("Complete — no blockers in this saved-data check.");
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText(
      "The check could not be completed. Your draft was not changed. Try checking again.",
    );
    expect(screen.queryByText("Complete — no blockers in this saved-data check.")).toBeNull();
    expect(checkCalls(send)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Check saved draft" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("keeps editor values on stale-version rejection and offers explicit reload", async () => {
    const { user, send } = await setup({
      handle: (url) =>
        url.includes("/readiness")
          ? Response.json({ code: "receiving_draft_conflict" }, { status: 409 })
          : undefined,
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await screen.findByText(
      "The saved draft changed. Reload the saved event before checking again.",
    );
    const readsBefore = send.mock.calls.filter(([url]) => url === `${path}/${id}`).length;
    await user.type(screen.getByLabelText("Receiving notes"), "Keep local input");
    expect(send.mock.calls.filter(([url]) => url === `${path}/${id}`)).toHaveLength(readsBefore);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Reload saved event" }));
    expect(confirm).toHaveBeenCalled();
    expect((screen.getByLabelText("Receiving notes") as HTMLTextAreaElement).value).toBe(
      "Keep local input",
    );
  });

  it("does not retry a failed check and drops data when read access is revoked", async () => {
    let checks = 0;
    const { user } = await setup({
      handle: (url) => {
        if (url.includes("/readiness")) {
          checks += 1;
          return Response.json({ code: "forbidden" }, { status: 403 });
        }
        if (checks && url === "/api/us/traceability/access")
          return Response.json({ capabilities: [] });
        return undefined;
      },
    });
    await user.click(screen.getByRole("button", { name: "Check saved draft" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: record.eventNumber })).toBeNull(),
    );
    expect(checks).toBe(1);
  });
});
