import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PlanView } from "../src/us/plans/view.js";
import { UsClientError } from "../src/us/client.js";
import { planCopy } from "../src/us/plans/copy.js";
import {
  actor,
  clientFixture,
  id,
  list,
  profile,
  published,
  renderPlanUi,
} from "./us-plans-fixtures.js";

afterEach(cleanup);
function setup(qa = false) {
  const { client } = clientFixture();
  const props = {
    client,
    canManageQa: qa,
    canExport: false,
    profile,
    onForbidden: vi.fn(async () => undefined),
    onSessionLost: vi.fn(),
    onDirtyChange: vi.fn(),
    onOpenProfile: vi.fn(),
    onOpenLocations: vi.fn(),
    onOpenProducts: vi.fn(),
  };
  return { client, props };
}
it("orders versions newest first, uses summary fields only, and explains retention and publication", async () => {
  const { client, props } = setup(true);
  const detail = vi.spyOn(client, "getPlan");
  renderPlanUi(<PlanView {...props} />);
  const table = await screen.findByRole("table");
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows.map((row) => within(row).getByRole("button").textContent)).toEqual([
    "View v3",
    "View v2",
    "View v1",
  ]);
  expect(within(table).getByText("Effective")).toBeTruthy();
  expect(within(table).getByText("Superseded")).toBeTruthy();
  expect(screen.getByText(/at least 7 calendar years/)).toBeTruthy();
  expect(screen.getByText(/Publication unavailable/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "New draft" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("v3 is open")).toBeTruthy();
  expect(detail).not.toHaveBeenCalled();
});
it("shows frozen facts, exact approver attribution and current impact separately, and returns focus", async () => {
  const { props } = setup();
  renderPlanUi(<PlanView {...props} />);
  await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
  const frozen = await screen.findByRole("region", { name: "Frozen snapshot" });
  expect(within(frozen).getByText("Frozen tenant")).toBeTruthy();
  expect(within(frozen).getByText("Frozen system")).toBeTruthy();
  expect(within(frozen).getAllByText(/Operator confirmed/).length).toBeGreaterThan(0);
  const approval = screen.getByRole("region", { name: "Approval record" });
  expect(within(approval).getByText(actor)).toBeTruthy();
  expect(within(approval).queryByText("Contact person")).toBeNull();
  expect(within(approval).getByText(published.artifact.sha256)).toBeTruthy();
  expect(within(approval).getByText(/UTC/)).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Current impact for v2" })).getByText(
      "Product classifications",
    ),
  ).toBeTruthy();
  expect(within(frozen).queryByText("Current impact for v2")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Close version" }));
  expect(screen.getByRole("button", { name: "View v2" })).toBe(document.activeElement);
});
it("distinguishes loading, failure, retry and successful empty response", async () => {
  const { client, props } = setup();
  let fail: (error: Error) => void = () => undefined;
  vi.spyOn(client, "listPlans")
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValue({ ...list, items: [], effectiveImpact: null });
  renderPlanUi(<PlanView {...props} />);
  expect(screen.getByText("Loading plan versions…")).toBeTruthy();
  expect(screen.queryByText("No plan yet")).toBeNull();
  await act(async () => fail(new Error("private detail")));
  expect(screen.getByRole("alert").textContent).toContain("Plan versions could not be loaded");
  expect(screen.queryByText("No plan yet")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No plan yet")).toBeTruthy();
  expect(screen.queryByText("private detail")).toBeNull();
});
it.each(["forbidden", "session_required"] as const)(
  "handles %s without an empty success",
  async (code) => {
    const { client, props } = setup();
    vi.spyOn(client, "listPlans").mockRejectedValue(new UsClientError(code));
    renderPlanUi(<PlanView {...props} />);
    await waitFor(() =>
      expect(code === "forbidden" ? props.onForbidden : props.onSessionLost).toHaveBeenCalledTimes(
        1,
      ),
    );
    expect(screen.queryByText("No plan yet")).toBeNull();
  },
);
it("ignores an old detail response after selecting a different version", async () => {
  const { client, props } = setup();
  let resolve: (value: typeof published) => void = () => undefined;
  const original = client.getPlan;
  vi.spyOn(client, "getPlan").mockImplementation((value) =>
    value === id
      ? new Promise((done) => {
          resolve = done;
        })
      : original(value),
  );
  renderPlanUi(<PlanView {...props} />);
  await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
  await userEvent.click(screen.getByRole("button", { name: "View v3" }));
  expect(await screen.findByText("DRAFT — not effective")).toBeTruthy();
  await act(async () => resolve(published));
  expect(screen.queryByRole("region", { name: "Frozen snapshot" })).toBeNull();
});

it("does not reload or lose detail when the selected row is activated again", async () => {
  const { client, props } = setup();
  const get = vi.spyOn(client, "getPlan");
  renderPlanUi(<PlanView {...props} />);
  await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
  await screen.findByRole("region", { name: "Frozen snapshot" });
  await userEvent.click(screen.getByRole("button", { name: "View v2" }));
  expect(screen.getByRole("region", { name: "Frozen snapshot" })).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(1);
});

it("retries selected detail without presenting a failed read as an empty plan", async () => {
  const { client, props } = setup();
  vi.spyOn(client, "getPlan")
    .mockRejectedValueOnce(new Error("private failure"))
    .mockResolvedValue(published);
  renderPlanUi(<PlanView {...props} />);
  await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
  expect(
    (await screen.findByText(/This version could not be loaded/)).closest('[role="alert"]'),
  ).not.toBeNull();
  expect(screen.queryByText("No plan yet")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("region", { name: "Frozen snapshot" })).toBeTruthy();
});

it("guards the view itself for a generic profile without making a Plan request", async () => {
  const { client, props } = setup();
  const get = vi.spyOn(client, "listPlans");
  renderPlanUi(
    <PlanView {...props} profile={{ ...profile, code: "US_GENERIC_LOT_TRACEABILITY" }} />,
  );
  expect(screen.getByRole("alert").textContent).toContain("processor profile");
  expect(get).not.toHaveBeenCalled();
});

it("renders Spanish detail with complete localized keys and no Russian fallback", async () => {
  const { props } = setup();
  const { container } = renderPlanUi(<PlanView {...props} />, "es-US");
  await userEvent.click(await screen.findByRole("button", { name: "Ver v2" }));
  expect(await screen.findByRole("region", { name: "Instantánea conservada" })).toBeTruthy();
  expect(container.textContent).not.toMatch(/usPlan\.|[А-Яа-яЁё]/);
  function keys(value: object, prefix = ""): string[] {
    return Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "object" && entry !== null
        ? keys(entry, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    );
  }
  expect(keys(planCopy["en-US"])).toEqual(keys(planCopy["es-US"]));
});

it("keeps the no-draft QA action disabled with the staged editor explanation", async () => {
  const { client, props } = setup(true);
  vi.spyOn(client, "listPlans").mockResolvedValue({
    ...list,
    items: [],
    effectiveImpact: null,
    publicationAvailability: "available",
  });
  renderPlanUi(<PlanView {...props} />);
  await screen.findByText("No plan yet");
  expect(screen.getByRole("button", { name: "New draft" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Draft editing is not available in this view yet.")).toBeTruthy();
  expect(screen.getByText(/Draft approval still requires server validation/)).toBeTruthy();
});
