import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { clientFixture, profile, renderPlanUi } from "./us-plans-fixtures.js";

afterEach(cleanup);
it.each(["en-US", "es-US"])(
  "opens processor Plan in %s and focuses its heading",
  async (locale) => {
    const { client } = clientFixture();
    renderPlanUi(
      <MasterDataWorkspace
        client={client}
        profile={profile}
        organization={{ id: "tenant", name: "Tenant" }}
        onBack={vi.fn()}
        onSessionLost={vi.fn()}
      />,
      locale,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Plan" }));
    expect(await screen.findByRole("heading", { name: "Plan", level: 1 })).toBe(
      document.activeElement,
    );
    expect(
      await screen.findAllByText(
        locale === "en-US"
          ? "Synthetic demo — not an operational record"
          : "Demostración sintética — no es un registro operativo",
      ),
    ).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: /New draft|Nuevo borrador/ })).toBeNull();
  },
);
it("never exposes Plan for a generic profile", async () => {
  const { client } = clientFixture();
  renderPlanUi(
    <MasterDataWorkspace
      client={client}
      profile={{ ...profile, code: "US_GENERIC_LOT_TRACEABILITY" }}
      organization={{ id: "tenant", name: "Tenant" }}
      onBack={vi.fn()}
      onSessionLost={vi.fn()}
    />,
  );
  await screen.findByRole("button", { name: "Parties" });
  expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
});
it("removes Plan and its contents when a forbidden read reloads revoked access", async () => {
  const { client } = clientFixture();
  vi.spyOn(client, "access")
    .mockResolvedValueOnce({ capabilities: ["traceability.read"] })
    .mockResolvedValue({ capabilities: [] });
  const { UsClientError } = await import("../src/us/client.js");
  vi.spyOn(client, "listPlans").mockRejectedValue(new UsClientError("forbidden"));
  renderPlanUi(
    <MasterDataWorkspace
      client={client}
      profile={profile}
      organization={{ id: "tenant", name: "Tenant" }}
      onBack={vi.fn()}
      onSessionLost={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Plan" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Plan" })).toBeNull());
  expect(screen.queryByRole("heading", { name: "Plan" })).toBeNull();
});

it("opens the current source workspace and returns to Plan with focus", async () => {
  const { client } = clientFixture();
  renderPlanUi(
    <MasterDataWorkspace
      client={client}
      profile={profile}
      organization={{ id: "tenant", name: "Tenant" }}
      onBack={vi.fn()}
      onSessionLost={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Plan" }));
  await userEvent.click(await screen.findByRole("button", { name: "View v2" }));
  await userEvent.click(await screen.findByRole("button", { name: "Open current locations" }));
  expect(await screen.findByRole("heading", { name: "Locations", level: 1 })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Back to Plan" }));
  expect(await screen.findByRole("heading", { name: "Plan", level: 1 })).toBe(
    document.activeElement,
  );
});
