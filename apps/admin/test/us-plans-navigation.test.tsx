import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { clientFixture, draft, profile, published, renderPlanUi } from "./us-plans-fixtures.js";
import { UsClientError, type UsBrowserClient } from "../src/us/client.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
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

it.each(["Open current locations", "Open current products", "Open current profile"])(
  "guards dirty source navigation: %s",
  async (source) => {
    const { client } = clientFixture(["traceability.read", "traceability.qa.manage"]);
    const onBack = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPlanUi(
      <MasterDataWorkspace
        client={client}
        profile={profile}
        organization={{ id: "tenant", name: "Tenant" }}
        onBack={onBack}
        onSessionLost={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Plan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    fireEvent.change(await screen.findByLabelText("System of record"), {
      target: { value: "Unsaved operator text" },
    });
    await userEvent.click(screen.getByRole("button", { name: source }));
    expect(confirm).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("System of record") as HTMLInputElement).value).toBe(
      "Unsaved operator text",
    );
    expect(onBack).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: source }));
    if (source === "Open current profile") expect(onBack).toHaveBeenCalledOnce();
    else {
      expect(
        await screen.findByRole("heading", {
          name: source === "Open current locations" ? "Locations" : "Products",
          level: 1,
        }),
      ).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Back to Plan" }));
      expect(await screen.findByRole("heading", { name: "Plan", level: 1 })).toBe(
        document.activeElement,
      );
    }
  },
);

it("preserves draft text after QA revocation but hides it after read revocation", async () => {
  const { client } = clientFixture();
  const access = vi
    .spyOn(client, "access")
    .mockResolvedValueOnce({ capabilities: ["traceability.read", "traceability.qa.manage"] })
    .mockResolvedValue({ capabilities: ["traceability.read"] });
  vi.spyOn(client, "savePlan").mockRejectedValue(new UsClientError("forbidden"));
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
  await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  fireEvent.change(await screen.findByLabelText("System of record"), {
    target: { value: "Keep local text" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(access).toHaveBeenCalledTimes(2));
  expect((screen.getByLabelText("System of record") as HTMLInputElement).value).toBe(
    "Keep local text",
  );
  expect(screen.getByRole("button", { name: "Save draft" }).hasAttribute("disabled")).toBe(true);
  access.mockResolvedValue({ capabilities: [] });
  vi.spyOn(client, "getPlan").mockRejectedValue(new UsClientError("forbidden"));
  await userEvent.click(screen.getByRole("button", { name: "Reload and discard local edits" }));
  await waitFor(() => expect(screen.queryByLabelText("System of record")).toBeNull());
});

it.each(["save", "reload"])(
  "releases the %s guard after deferred access recovery revokes READ",
  async (operation) => {
    const { client } = clientFixture();
    let finishAccess: (value: Awaited<ReturnType<UsBrowserClient["access"]>>) => void = () =>
      undefined;
    const pendingAccess = new Promise<Awaited<ReturnType<UsBrowserClient["access"]>>>((resolve) => {
      finishAccess = resolve;
    });
    const access = vi
      .spyOn(client, "access")
      .mockResolvedValueOnce({ capabilities: ["traceability.read", "traceability.qa.manage"] })
      .mockReturnValue(pendingAccess);
    vi.spyOn(client, "savePlan").mockRejectedValue(
      new UsClientError(operation === "save" ? "forbidden" : "us_plan_revision_conflict"),
    );
    const onBack = vi.fn();
    renderPlanUi(
      <MasterDataWorkspace
        client={client}
        profile={profile}
        organization={{ id: "tenant", name: "Tenant" }}
        onBack={onBack}
        onSessionLost={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Plan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    fireEvent.change(await screen.findByLabelText("System of record"), {
      target: { value: "Sensitive local draft" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    if (operation === "reload") {
      vi.spyOn(client, "getPlan").mockRejectedValue(new UsClientError("forbidden"));
      await userEvent.click(
        await screen.findByRole("button", { name: "Reload and discard local edits" }),
      );
    }
    await waitFor(() => expect(access).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Saving draft…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Parties" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      finishAccess({ capabilities: [] });
      await pendingAccess;
    });
    expect(screen.queryByLabelText("System of record")).toBeNull();
    expect(screen.queryByDisplayValue("Sensitive local draft")).toBeNull();
    const profileButton = screen.getByRole("button", { name: "Profile" });
    expect(profileButton.hasAttribute("disabled")).toBe(false);
    await userEvent.click(profileButton);
    expect(onBack).toHaveBeenCalledOnce();
  },
);

it("blocks cabinet and version navigation while a save awaits acknowledgement", async () => {
  if (draft.status !== "draft") throw new Error("draft fixture");
  const { client } = clientFixture(["traceability.read", "traceability.qa.manage"]);
  let resolve: (value: Awaited<ReturnType<UsBrowserClient["savePlan"]>>) => void = () => undefined;
  vi.spyOn(client, "savePlan").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
  await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  fireEvent.change(await screen.findByLabelText("System of record"), {
    target: { value: "Saving text" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Saving draft…");
  expect(screen.getByRole("button", { name: "Parties" }).hasAttribute("disabled")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "View v2" }));
  expect(screen.getByLabelText("System of record")).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  resolve({ ...draft, draftRevision: 2 });
  await screen.findByText("Saved revision 2");
  expect(screen.getByRole("button", { name: "Parties" }).hasAttribute("disabled")).toBe(false);
});

it("releases the navigation guard when explicit reload finds the draft already approved", async () => {
  const { client } = clientFixture(["traceability.read", "traceability.qa.manage"]);
  vi.spyOn(client, "savePlan").mockRejectedValue(new UsClientError("us_plan_not_draft"));
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
  await userEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
  fireEvent.change(await screen.findByLabelText("System of record"), {
    target: { value: "Local text" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  vi.spyOn(client, "getPlan").mockResolvedValue({ ...published, id: draft.id, versionNumber: 3 });
  await userEvent.click(
    await screen.findByRole("button", { name: "Reload and discard local edits" }),
  );
  await screen.findByRole("heading", { name: "v3 · Effective" });
  expect(screen.getByRole("button", { name: "Parties" }).hasAttribute("disabled")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Parties" }));
  expect(await screen.findByRole("heading", { name: "Parties", level: 1 })).toBeTruthy();
});
