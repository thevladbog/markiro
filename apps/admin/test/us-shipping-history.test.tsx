import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  finalizedRecord,
  renderShipping,
  revisionId,
  shippingId,
} from "./support/us-shipping-ui-fixture.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("requires a QA reason to start an amendment and shows the pending revision", async () => {
  const { user, requestBodies } = await renderShipping({
    initial: finalizedRecord(),
    canManageQa: true,
  });
  await user.click(await screen.findByRole("button", { name: "Start amendment" }));
  const confirm = screen.getByRole("button", { name: "Confirm amendment" });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  await user.type(screen.getByLabelText("QA reason"), "Correct quantity");
  await user.click(confirm);
  await waitFor(() => expect(requestBodies.some(({ path }) => path.endsWith("/amend"))).toBe(true));
  expect(await screen.findByRole("heading", { name: "SHP-26-0001" })).toBeTruthy();
  expect(screen.getAllByText("Revision 2").length).toBeGreaterThan(0);
  expect(requestBodies.find(({ path }) => path.endsWith("/amend"))?.body).toMatchObject({
    reason: "Correct quantity",
    expectedLifecycleVersion: 2,
  });
  expect(screen.getByRole("button", { name: "Revision 1" })).toBeTruthy();
  expect(revisionId).toBeTruthy();
});

it("requires a QA reason to void and preserves the reason in the detail", async () => {
  const { user, requestBodies } = await renderShipping({
    initial: finalizedRecord(),
    canManageQa: true,
  });
  await user.click(await screen.findByRole("button", { name: "Void shipment" }));
  expect(screen.getByRole("button", { name: "Confirm void" }).hasAttribute("disabled")).toBe(true);
  await user.type(screen.getByLabelText("QA reason"), "Duplicate shipment entry");
  await user.click(screen.getByRole("button", { name: "Confirm void" }));
  await waitFor(() => expect(requestBodies.some(({ path }) => path.endsWith("/void"))).toBe(true));
  expect(await screen.findByText("Duplicate shipment entry")).toBeTruthy();
  expect(screen.getByText(/excluded from current trace/i)).toBeTruthy();
});

it("lets QA cancel a pending amendment without voiding its current predecessor", async () => {
  const { user, requestBodies } = await renderShipping({
    initial: finalizedRecord(),
    canManageQa: true,
  });
  await user.click(await screen.findByRole("button", { name: "Start amendment" }));
  await user.type(screen.getByLabelText("QA reason"), "Correct quantity");
  await user.click(screen.getByRole("button", { name: "Confirm amendment" }));
  expect(await screen.findByText("Pending draft")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel amendment" }));
  expect(screen.getByRole("dialog", { name: "Cancel amendment" }).textContent).toContain(
    "predecessor remains the current finalized shipment",
  );
  await user.type(screen.getByLabelText("QA reason"), "Cancel incorrect amendment");
  await user.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  await waitFor(() =>
    expect(requestBodies.some(({ path }) => path.endsWith(`/${revisionId}/void`))).toBe(true),
  );
  expect(
    requestBodies.find(({ path }) => path.endsWith(`/${revisionId}/void`))?.body,
  ).toMatchObject({
    expectedDraftVersion: 1,
    expectedLifecycleVersion: 3,
    reason: "Cancel incorrect amendment",
  });
  expect(await screen.findByText("Cancel incorrect amendment")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revision 1" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Revision 1" }));
  await waitFor(() => expect(screen.getAllByText("Current revision").length).toBeGreaterThan(0));
  expect(screen.queryByText("Pending draft")).toBeNull();
  expect(shippingId).toBeTruthy();
});
