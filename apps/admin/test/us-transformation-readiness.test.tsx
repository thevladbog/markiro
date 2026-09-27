import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  completeDraft,
  renderTransformation,
  transformationId,
} from "./support/us-transformation-ui-fixture.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("checks only the saved version and clears its digest after local edit", async () => {
  const { user, send } = await renderTransformation({ draft: completeDraft, canManageQa: true });
  await user.click(await screen.findByRole("button", { name: "Check readiness" }));
  await waitFor(() => expect(screen.getByText("Complete · v1")).toBeTruthy());
  expect(
    send.mock.calls.some(
      ([url]) =>
        String(url) ===
        `/api/us/traceability/transformation/${transformationId}/readiness?expectedDraftVersion=1`,
    ),
  ).toBe(true);
  expect(screen.getByRole("button", { name: "Finalize transformation" })).toBeTruthy();
  await user.type(screen.getByLabelText("Notes"), "Changed locally");
  expect(screen.queryByText("Complete · v1")).toBeNull();
  expect(screen.queryByRole("button", { name: "Finalize transformation" })).toBeNull();
  expect(screen.getByText("Save local changes before checking readiness.")).toBeTruthy();
});

it("renders typed 409 issues in their source groups and blocks finalization", async () => {
  const { user, send } = await renderTransformation({ draft: completeDraft, canManageQa: true });
  send.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${transformationId}`)
      return Response.json({
        id: transformationId,
        eventNumber: "TRN-26-0001",
        revision: 1,
        draftVersion: 1,
        status: "draft",
        timeZone: "America/Chicago",
        createdBy: "operator",
        updatedBy: "operator",
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:00.000Z",
        lifecycle: {
          rootId: transformationId,
          lifecycleVersion: 1,
          currentEventId: null,
          pendingDraftId: transformationId,
          previousRevisionId: null,
          amendmentReason: null,
          supersededByEventId: null,
          supersededAt: null,
          supersededBy: null,
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
        },
        draft: completeDraft,
      });
    if (url.includes("/readiness?"))
      return Response.json(
        {
          code: "event_incomplete",
          issues: [
            {
              severity: "error",
              group: "inputs",
              line: 1,
              field: "lotId",
              code: "lot_not_eligible",
              detail: null,
            },
            {
              severity: "error",
              group: "documents",
              line: null,
              field: "documentIds",
              code: "required",
              detail: null,
            },
          ],
        },
        { status: 409 },
      );
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  await user.click(await screen.findByRole("button", { name: "Check readiness" }));
  await waitFor(() => expect(screen.getByText(/lotId: lot_not_eligible/)).toBeTruthy());
  expect(screen.getByText(/documentIds: required/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Finalize transformation" })).toBeNull();
});
