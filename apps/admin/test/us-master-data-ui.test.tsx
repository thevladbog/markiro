import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import i18next from "i18next";
import { StrictMode, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsClientError, type UsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";

const party = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Synthetic supplier",
  legalName: "Synthetic Supplier LLC",
  contactName: "Jamie Rowan",
  contactPhone: "+1 212 555 0100",
  contactEmail: "supplier@example.test",
  notes: "Approved receiving instructions",
  archived: false,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};
const location = {
  id: "b0000000-0000-4000-8000-000000000002",
  partyId: party.id,
  name: "Receiving dock",
  businessName: party.name,
  phoneNumber: null,
  addressKind: "street" as const,
  streetAddress: null,
  latitude: null,
  longitude: null,
  city: "Portland",
  stateOrRegion: "OR",
  zipOrPostalCode: null,
  countryCode: "US",
  roles: ["receive_at" as const],
  archived: false,
  createdAt: party.createdAt,
  updatedAt: party.updatedAt,
  descriptionStatus: {
    exportReady: false,
    issues: [
      { field: "phoneNumber" as const, code: "required" as const },
      { field: "streetAddress" as const, code: "required" as const },
      { field: "zipOrPostalCode" as const, code: "required" as const },
    ],
  },
};
const richLocation = {
  ...location,
  phoneNumber: "+1 503 555 0199",
  streetAddress: "100 Produce Way",
  zipOrPostalCode: "97201",
};
const profile = {
  code: "US_FSMA204_PROCESSOR" as const,
  timeZone: "America/Los_Angeles",
  retentionYears: 5,
  baselineVersion: "US-REG-2026-09-03",
  effectiveAt: "2026-09-05T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function workspaceClient(overrides: Partial<UsBrowserClient> = {}): UsBrowserClient {
  return {
    access: vi.fn().mockResolvedValue({
      capabilities: ["traceability.read", "traceability.master_data.write"],
    }),
    listParties: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0 }),
    getParty: vi.fn().mockResolvedValue(party),
    createParty: vi.fn().mockResolvedValue(party),
    updateParty: vi.fn().mockResolvedValue(party),
    listLocations: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0 }),
    getLocation: vi.fn().mockResolvedValue(location),
    createLocation: vi.fn().mockResolvedValue(location),
    updateLocation: vi.fn().mockResolvedValue(location),
    ...overrides,
  } as unknown as UsBrowserClient;
}

function renderWorkspace(
  client: UsBrowserClient,
  options: {
    locale?: "en-US" | "es-US";
    onBack?: () => void;
    onSessionLost?: () => void;
    strict?: boolean;
    profile?:
      typeof profile | (Omit<typeof profile, "code"> & { code: "US_GENERIC_LOT_TRACEABILITY" });
  } = {},
) {
  const instance = i18next.createInstance();
  void instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: options.locale ?? "en-US",
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const onBack = options.onBack ?? vi.fn();
  const onSessionLost = options.onSessionLost ?? vi.fn();
  const workspace: ReactNode = (
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={instance}>
        <MasterDataWorkspace
          client={client}
          organization={{ id: "tenant-1", name: "North River Fresh Foods" }}
          profile={options.profile ?? profile}
          onBack={onBack}
          onSessionLost={onSessionLost}
        />
      </I18nextProvider>
    </ThemeProvider>
  );
  render(options.strict ? <StrictMode>{workspace}</StrictMode> : workspace);
  return { instance, onBack, onSessionLost };
}

describe("connected US master-data workspace", () => {
  it("keeps view requests live through the development StrictMode effect probe", async () => {
    renderWorkspace(
      workspaceClient({
        listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
      }),
      { strict: true },
    );

    expect(await screen.findByRole("button", { name: party.name })).toBeTruthy();
  });

  it.each([
    ["while access is loading", vi.fn(() => new Promise<never>(() => undefined))],
    ["after access fails", vi.fn().mockRejectedValue(new Error("offline"))],
  ])("keeps Profile reachable %s", async (_case, access) => {
    const onBack = vi.fn();
    renderWorkspace(workspaceClient({ access }), { onBack });

    await userEvent.click(await screen.findByRole("button", { name: "Profile" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("creates a party, preserves the server as list truth, and exposes stable browser labels", async () => {
    const listParties = vi
      .fn()
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0 })
      .mockResolvedValueOnce({ items: [party], limit: 50, offset: 0 });
    const client = workspaceClient({ listParties });
    const { instance } = renderWorkspace(client);

    await userEvent.click(await screen.findByRole("button", { name: "Add party" }));
    await userEvent.type(screen.getByLabelText("Name", { exact: true }), party.name);
    await userEvent.click(screen.getByRole("button", { name: "Save party" }));

    expect(await screen.findByRole("button", { name: party.name })).toBeTruthy();
    expect(client.createParty).toHaveBeenCalledWith(expect.objectContaining({ name: party.name }));
    expect(listParties).toHaveBeenLastCalledWith({ archived: "false", limit: 50, offset: 0 });
    await instance.changeLanguage("es-US");
    expect(await screen.findByText("Parte guardada.")).toBeTruthy();
    const activeNav = screen.getByRole("button", { name: "Partes" });
    expect(activeNav.style.justifyContent).toBe("flex-start");
    expect(activeNav.style.background).toBe("var(--mk-rail-bg-active)");
  });

  it("keeps conflict input and refreshes stale write capability after a forbidden save", async () => {
    const access = vi
      .fn()
      .mockResolvedValueOnce({
        capabilities: ["traceability.read", "traceability.master_data.write"],
      })
      .mockResolvedValueOnce({ capabilities: ["traceability.read"] });
    const createParty = vi
      .fn()
      .mockRejectedValueOnce(new UsClientError("conflict"))
      .mockRejectedValueOnce(new UsClientError("forbidden"));
    const client = workspaceClient({ access, createParty });
    renderWorkspace(client);

    await userEvent.click(await screen.findByRole("button", { name: "Add party" }));
    const name = screen.getByLabelText("Name", { exact: true });
    await userEvent.type(name, party.name);
    await userEvent.click(screen.getByRole("button", { name: "Save party" }));
    expect(await screen.findByText("An active party already uses this name.")).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe(party.name);

    await userEvent.clear(name);
    await userEvent.type(name, "Second synthetic party");
    await userEvent.click(screen.getByRole("button", { name: "Save party" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Your write access changed");
    expect((name as HTMLInputElement).value).toBe("Second synthetic party");
    expect(access).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Save party" })).toBeNull();
  });

  it("serializes Enter submission while a party save is pending", async () => {
    let resolveSave!: (value: typeof party) => void;
    const save = new Promise<typeof party>((resolve) => {
      resolveSave = resolve;
    });
    const createParty = vi.fn().mockReturnValue(save);
    renderWorkspace(workspaceClient({ createParty }));

    await userEvent.click(await screen.findByRole("button", { name: "Add party" }));
    const name = screen.getByLabelText("Name", { exact: true });
    await userEvent.type(name, party.name);
    await userEvent.click(screen.getByRole("button", { name: "Save party" }));
    expect((name as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).disabled).toBe(true);
    name.focus();
    await userEvent.keyboard("{Enter}");
    expect(createParty).toHaveBeenCalledTimes(1);
    resolveSave(party);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps all mutation entry points blocked through the authoritative post-save refresh", async () => {
    let releaseList!: (value: { items: (typeof party)[]; limit: number; offset: number }) => void;
    const refresh = new Promise<{ items: (typeof party)[]; limit: number; offset: number }>(
      (resolve) => {
        releaseList = resolve;
      },
    );
    const listParties = vi
      .fn()
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0 })
      .mockReturnValueOnce(refresh);
    renderWorkspace(workspaceClient({ listParties }));

    await userEvent.click(await screen.findByRole("button", { name: "Add party" }));
    await userEvent.type(screen.getByLabelText("Name", { exact: true }), party.name);
    await userEvent.click(screen.getByRole("button", { name: "Save party" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByRole("button", { name: "Add party" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /Profile/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    releaseList({ items: [party], limit: 50, offset: 0 });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Add party" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("keeps a detail drawer open while an archive mutation is pending", async () => {
    let resolveArchive!: (value: typeof party) => void;
    const archive = new Promise<typeof party>((resolve) => {
      resolveArchive = resolve;
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWorkspace(
      workspaceClient({
        listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
        updateParty: vi.fn().mockReturnValue(archive),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: party.name }));
    await userEvent.click(await screen.findByRole("button", { name: "Archive party" }));
    expect(
      (screen.getByRole("button", { name: "Add location" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: /Profile/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: party.name })).toBeTruthy();
    resolveArchive({ ...party, archived: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: party.name })).toBeNull());
  });

  it("keeps the original mutation guard owned when a stale child entry overlaps and fails", async () => {
    let resolveArchive!: (value: typeof party) => void;
    const archive = new Promise<typeof party>((resolve) => {
      resolveArchive = resolve;
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWorkspace(
      workspaceClient({
        listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
        updateParty: vi.fn().mockReturnValue(archive),
        createLocation: vi.fn().mockRejectedValue(new Error("offline")),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: party.name }));
    const details = await screen.findByRole("dialog", { name: party.name });
    const archiveButton = within(details).getByRole("button", { name: "Archive party" });
    const staleAddLocation = within(details).getByRole("button", { name: "Add location" });
    act(() => {
      archiveButton.click();
      staleAddLocation.click();
    });

    const childForm = await screen.findByRole("dialog", { name: "Add location" });
    await userEvent.type(within(childForm).getByLabelText("Internal name"), "Overlapping draft");
    await userEvent.click(within(childForm).getByRole("button", { name: "Save location" }));
    expect(
      await screen.findByText("The record could not be saved. Your input was kept."),
    ).toBeTruthy();
    await userEvent.click(within(childForm).getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("button", { name: /Profile/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    resolveArchive({ ...party, archived: true });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /Profile/ }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("freezes every editable location field while its captured payload is pending", async () => {
    let resolveSave!: (value: typeof location) => void;
    const save = new Promise<typeof location>((resolve) => {
      resolveSave = resolve;
    });
    renderWorkspace(
      workspaceClient({
        listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
        createLocation: vi.fn().mockReturnValue(save),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Locations" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add location" }));
    const dialog = await screen.findByRole("dialog", { name: "Add location" });
    await userEvent.click(await within(dialog).findByRole("button", { name: party.name }));
    await userEvent.type(within(dialog).getByLabelText("Internal name"), "Draft dock");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save location" }));

    for (const label of ["Internal name", "Business name", "Phone", "ZIP or postal code"])
      expect(
        (within(dialog).getByLabelText(label, { exact: true }) as HTMLInputElement).disabled,
      ).toBe(true);
    expect(
      (within(dialog).getByRole("combobox", { name: "Address kind" }) as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    expect((within(dialog).getByLabelText("Receive-at") as HTMLInputElement).disabled).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "Search" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    resolveSave(location);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the selected location parent visible when a new parent search omits it", async () => {
    const secondParty = {
      ...party,
      id: "a0000000-0000-4000-8000-000000000002",
      name: "Other supplier",
    };
    const listParties = vi
      .fn()
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0 })
      .mockResolvedValueOnce({ items: [party], limit: 50, offset: 0 })
      .mockResolvedValueOnce({ items: [secondParty], limit: 50, offset: 0 });
    const listLocations = vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0 });
    renderWorkspace(workspaceClient({ listParties, listLocations }));

    await userEvent.click(await screen.findByRole("button", { name: "Locations" }));
    const partyFilter = await screen.findByLabelText("Party");
    await userEvent.selectOptions(partyFilter, party.id);
    await userEvent.type(screen.getByLabelText("Search parent parties"), "Other");
    const filter = screen.getByLabelText("Search parent parties").closest(".us-md-filter-party");
    await userEvent.click(within(filter as HTMLElement).getByRole("button", { name: "Search" }));

    await waitFor(() => expect(listParties).toHaveBeenCalledTimes(3));
    expect((partyFilter as HTMLSelectElement).value).toBe(party.id);
    expect((partyFilter as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(party.name);
    expect(listLocations).toHaveBeenLastCalledWith(
      expect.objectContaining({ partyId: party.id, limit: 50, offset: 0 }),
    );
  });

  it("recovers a global location draft when its selected party is archived concurrently", async () => {
    const otherParty = {
      ...party,
      id: "a0000000-0000-4000-8000-000000000002",
      name: "Other supplier",
    };
    const listParties = vi.fn().mockImplementation(async (query: { search?: string }) => ({
      items: query.search === "Other" ? [otherParty] : [party],
      limit: 50,
      offset: 0,
    }));
    const createLocation = vi
      .fn()
      .mockRejectedValueOnce(new UsClientError("party_archived"))
      .mockResolvedValueOnce({ ...location, partyId: otherParty.id });
    renderWorkspace(
      workspaceClient({
        listParties,
        createLocation,
        getParty: vi.fn().mockResolvedValue({ ...party, archived: true }),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Locations" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add location" }));
    const dialog = await screen.findByRole("dialog", { name: "Add location" });
    await userEvent.click(await within(dialog).findByRole("button", { name: party.name }));
    const name = within(dialog).getByLabelText("Internal name");
    await userEvent.type(name, "Preserved draft");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save location" }));

    expect(await within(dialog).findByText(/Choose another active party/)).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe("Preserved draft");
    expect(
      (within(dialog).getByRole("button", { name: "Save location" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: party.name }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.type(within(dialog).getByLabelText("Search parent parties"), "Other");
    await userEvent.click(within(dialog).getByRole("button", { name: "Search" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: otherParty.name }));
    expect(within(dialog).queryByText(/Choose another active party/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save location" }));
    await waitFor(() => expect(createLocation).toHaveBeenCalledTimes(2));
  });

  it.each([false, true])(
    "retains known archived parents after selecting another option (reload=%s)",
    async (reload) => {
      const otherParty = {
        ...party,
        id: "a0000000-0000-4000-8000-000000000002",
        name: "Other supplier",
      };
      const createLocation = vi
        .fn()
        .mockRejectedValueOnce(new UsClientError("party_archived"))
        .mockResolvedValueOnce({ ...location, partyId: otherParty.id });
      const reloadedParty = {
        ...party,
        id: "a0000000-0000-4000-8000-000000000003",
        name: "Reloaded supplier",
      };
      const listParties = vi.fn().mockImplementation(async (query: { search?: string }) => ({
        items: query.search ? [party, otherParty, reloadedParty] : [party, otherParty],
        limit: 50,
        offset: 0,
      }));
      renderWorkspace(
        workspaceClient({
          listParties,
          createLocation,
          getParty: vi.fn().mockResolvedValue({ ...party, archived: true }),
        }),
      );
      await userEvent.click(await screen.findByRole("button", { name: "Locations" }));
      await userEvent.click(await screen.findByRole("button", { name: "Add location" }));
      const dialog = await screen.findByRole("dialog", { name: "Add location" });
      const parentA = await within(dialog).findByRole("button", { name: party.name });
      await userEvent.click(parentA);
      await userEvent.type(
        within(dialog).getByLabelText("Internal name"),
        "Preserved same-page draft",
      );
      await userEvent.click(within(dialog).getByRole("button", { name: "Save location" }));
      await within(dialog).findByText(/Choose another active party/);
      await userEvent.click(within(dialog).getByRole("button", { name: otherParty.name }));
      if (reload) {
        await userEvent.type(within(dialog).getByLabelText("Search parent parties"), "supplier");
        await userEvent.click(within(dialog).getByRole("button", { name: "Search" }));
        await within(dialog).findByRole("button", { name: "Reloaded supplier" });
      }
      const knownArchived = within(dialog).getByRole("button", { name: party.name });
      expect((knownArchived as HTMLButtonElement).disabled).toBe(true);
      await userEvent.click(knownArchived);
      expect(
        within(dialog).getByRole("button", { name: otherParty.name }).getAttribute("aria-pressed"),
      ).toBe("true");
      expect((within(dialog).getByLabelText("Internal name") as HTMLInputElement).value).toBe(
        "Preserved same-page draft",
      );
      await userEvent.click(within(dialog).getByRole("button", { name: "Save location" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(createLocation).toHaveBeenCalledTimes(2);
      expect(createLocation).toHaveBeenLastCalledWith(
        expect.objectContaining({ partyId: otherParty.id, name: "Preserved same-page draft" }),
      );
    },
  );

  it("keeps a party-prefilled location draft and directs recovery after party_archived", async () => {
    const getParty = vi
      .fn()
      .mockResolvedValueOnce(party)
      .mockResolvedValueOnce({ ...party, archived: true });
    renderWorkspace(
      workspaceClient({
        listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
        getParty,
        createLocation: vi.fn().mockRejectedValue(new UsClientError("party_archived")),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: party.name }));
    const details = await screen.findByRole("dialog", { name: party.name });
    await userEvent.click(within(details).getByRole("button", { name: "Add location" }));
    const dialog = await screen.findByRole("dialog", { name: "Add location" });
    const name = within(dialog).getByLabelText("Internal name");
    await userEvent.type(name, "Party draft");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save location" }));

    expect(await within(dialog).findByText(/restore the parent party/i)).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe("Party draft");
    expect(
      (within(dialog).getByRole("button", { name: "Save location" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps location edits and directs recovery after party_archived", async () => {
    const getParty = vi
      .fn()
      .mockResolvedValueOnce(party)
      .mockResolvedValueOnce(party)
      .mockResolvedValueOnce({ ...party, archived: true });
    renderWorkspace(
      workspaceClient({
        listLocations: vi.fn().mockResolvedValue({ items: [location], limit: 50, offset: 0 }),
        getParty,
        updateLocation: vi.fn().mockRejectedValue(new UsClientError("party_archived")),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Locations" }));
    await userEvent.click(await screen.findByRole("button", { name: location.name }));
    const details = await screen.findByRole("dialog", { name: location.name });
    await userEvent.click(within(details).getByRole("button", { name: "Edit location" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit location" });
    const name = within(dialog).getByLabelText("Internal name");
    await userEvent.clear(name);
    await userEvent.type(name, "Edited but preserved");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save location" }));

    expect(await within(dialog).findByText(/restore the parent party/i)).toBeTruthy();
    expect((name as HTMLInputElement).value).toBe("Edited but preserved");
  });

  it("shows read-only records without any mutation controls", async () => {
    const client = workspaceClient({
      access: vi.fn().mockResolvedValue({ capabilities: ["traceability.read"] }),
      listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
    });
    renderWorkspace(client);

    expect(await screen.findByRole("button", { name: party.name })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add party" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: party.name }));
    expect(await screen.findByRole("dialog", { name: party.name })).toBeTruthy();
    const dialog = screen.getByRole("dialog", { name: party.name });
    expect(within(dialog).getByText(party.contactName)).toBeTruthy();
    expect(within(dialog).getByText(party.contactPhone)).toBeTruthy();
    expect(within(dialog).getByText(party.contactEmail)).toBeTruthy();
    expect(within(dialog).getByText(party.notes)).toBeTruthy();
    for (const action of ["Edit party", "Archive party", "Restore party", "Add location"])
      expect(screen.queryByRole("button", { name: action })).toBeNull();
  });

  it("shows stored location description fields and named readiness gaps to read-only users", async () => {
    const archivedParent = { ...party, archived: true };
    renderWorkspace(
      workspaceClient({
        access: vi.fn().mockResolvedValue({ capabilities: ["traceability.read"] }),
        listLocations: vi.fn().mockResolvedValue({ items: [richLocation], limit: 50, offset: 0 }),
        getLocation: vi.fn().mockResolvedValue(richLocation),
        getParty: vi.fn().mockResolvedValue(archivedParent),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Locations" }));
    await userEvent.click(await screen.findByRole("button", { name: richLocation.name }));
    const dialog = await screen.findByRole("dialog", { name: richLocation.name });
    for (const value of [
      richLocation.phoneNumber,
      richLocation.streetAddress,
      "Portland, OR",
      richLocation.zipOrPostalCode,
      "US",
    ])
      expect(within(dialog).getByText(value)).toBeTruthy();
    expect(
      within(dialog).getByText(/Missing: phone, street address, ZIP or postal code/),
    ).toBeTruthy();
    for (const action of ["Edit location", "Archive location", "Restore location"])
      expect(within(dialog).queryByRole("button", { name: action })).toBeNull();
  });

  it("discards stale filtered loads and paginates without a fabricated total", async () => {
    let release!: (value: { items: (typeof party)[]; limit: number; offset: number }) => void;
    const first = new Promise<{ items: (typeof party)[]; limit: number; offset: number }>(
      (resolve) => {
        release = resolve;
      },
    );
    const archivedParty = {
      ...party,
      id: "a0000000-0000-4000-8000-000000000099",
      name: "Archived party",
      archived: true,
    };
    const listParties = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ items: [archivedParty], limit: 50, offset: 0 });
    renderWorkspace(workspaceClient({ listParties }));

    await userEvent.selectOptions(await screen.findByLabelText("Status"), "true");
    expect(await screen.findByRole("button", { name: "Archived party" })).toBeTruthy();
    release({ items: [party], limit: 50, offset: 0 });
    await waitFor(() => expect(screen.queryByRole("button", { name: party.name })).toBeNull());
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("does not reopen a detail drawer after navigation invalidates its load", async () => {
    let resolveParty!: (value: typeof party) => void;
    const pendingParty = new Promise<typeof party>((resolve) => {
      resolveParty = resolve;
    });
    renderWorkspace(
      workspaceClient({
        listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
        getParty: vi.fn().mockReturnValue(pendingParty),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: party.name }));
    await userEvent.click(screen.getByRole("button", { name: "Locations" }));
    resolveParty(party);
    await pendingParty;
    await Promise.resolve();
    expect(screen.queryByRole("dialog", { name: party.name })).toBeNull();
    expect(screen.getByRole("heading", { name: "Locations" })).toBeTruthy();
  });

  it("keeps only archive available when a location parent is archived", async () => {
    const archivedParent = { ...party, archived: true };
    renderWorkspace(
      workspaceClient({
        listLocations: vi.fn().mockResolvedValue({ items: [location], limit: 50, offset: 0 }),
        getParty: vi.fn().mockResolvedValue(archivedParent),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Locations" }));
    await userEvent.click(await screen.findByRole("button", { name: location.name }));
    expect(await screen.findByRole("button", { name: "Archive location" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit location" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore location" })).toBeNull();
    expect(screen.getByText(/archived parent/i)).toBeTruthy();
  });

  it("shows a retryable local error when party locations fail to load", async () => {
    const listLocations = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [location], limit: 50, offset: 0 });
    renderWorkspace(
      workspaceClient({
        listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
        listLocations,
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: party.name }));
    const dialog = await screen.findByRole("dialog", { name: party.name });
    expect(within(dialog).getByText("This list could not be loaded.")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText(location.name)).toBeTruthy();
  });

  it("marks party locations stale while a newer page is loading", async () => {
    let release!: (value: { items: (typeof location)[]; limit: number; offset: number }) => void;
    const nextPage = new Promise<{ items: (typeof location)[]; limit: number; offset: number }>(
      (resolve) => {
        release = resolve;
      },
    );
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      ...location,
      id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Dock ${index + 1}`,
    }));
    const listLocations = vi
      .fn()
      .mockResolvedValueOnce({ items: firstPage, limit: 50, offset: 0 })
      .mockReturnValueOnce(nextPage);
    renderWorkspace(
      workspaceClient({
        listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
        listLocations,
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: party.name }));
    const dialog = await screen.findByRole("dialog", { name: party.name });
    await within(dialog).findByText("Dock 1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Next page" }));
    expect(within(dialog).getByText("Refreshing after a filter change…")).toBeTruthy();
    release({ items: [], limit: 50, offset: 50 });
    await waitFor(() =>
      expect(within(dialog).queryByText("Refreshing after a filter change…")).toBeNull(),
    );
  });

  it("resets child rows and pagination before opening another party", async () => {
    const secondParty = {
      ...party,
      id: "a0000000-0000-4000-8000-000000000002",
      name: "Second supplier",
    };
    const getParty = vi
      .fn()
      .mockImplementation(async (id: string) => (id === party.id ? party : secondParty));
    const listLocations = vi.fn().mockImplementation(async (query: { partyId: string }) => ({
      items: query.partyId === party.id ? [location] : [],
      limit: 50,
      offset: 0,
    }));
    renderWorkspace(
      workspaceClient({
        listParties: vi.fn().mockResolvedValue({
          items: [party, secondParty],
          limit: 50,
          offset: 0,
        }),
        getParty,
        listLocations,
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: party.name }));
    const firstDialog = await screen.findByRole("dialog", { name: party.name });
    expect(await within(firstDialog).findByText(location.name)).toBeTruthy();
    await userEvent.click(within(firstDialog).getByRole("button", { name: "Close party details" }));
    await userEvent.click(screen.getByRole("button", { name: secondParty.name }));
    const secondDialog = await screen.findByRole("dialog", { name: secondParty.name });
    expect(within(secondDialog).queryByText(location.name)).toBeNull();
    expect(
      await within(secondDialog).findByText("This party has no matching locations."),
    ).toBeTruthy();
    expect(within(secondDialog).getByText("Page 1")).toBeTruthy();
  });

  it("directs restoring the parent when both a location and its parent are archived", async () => {
    const archivedLocation = { ...location, archived: true };
    const archivedParent = { ...party, archived: true };
    renderWorkspace(
      workspaceClient({
        listLocations: vi
          .fn()
          .mockResolvedValue({ items: [archivedLocation], limit: 50, offset: 0 }),
        getLocation: vi.fn().mockResolvedValue(archivedLocation),
        getParty: vi.fn().mockResolvedValue(archivedParent),
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Locations" }));
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "true");
    await userEvent.click(await screen.findByRole("button", { name: archivedLocation.name }));
    const dialog = await screen.findByRole("dialog", { name: archivedLocation.name });
    expect(
      within(dialog).getByText(
        "Restore the parent party before editing or restoring this location.",
      ),
    ).toBeTruthy();
  });

  it.each(["US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"] as const)(
    "saves an incomplete location draft through the %s workspace",
    async (code) => {
      const createLocation = vi.fn().mockResolvedValue(location);
      renderWorkspace(
        workspaceClient({
          listParties: vi.fn().mockResolvedValue({ items: [party], limit: 50, offset: 0 }),
          createLocation,
        }),
        { profile: { ...profile, code } },
      );

      await userEvent.click(await screen.findByRole("button", { name: "Locations" }));
      await userEvent.click(await screen.findByRole("button", { name: "Add location" }));
      const dialog = await screen.findByRole("dialog", { name: "Add location" });
      await userEvent.click(await within(dialog).findByRole("button", { name: party.name }));
      await userEvent.type(within(dialog).getByLabelText("Internal name"), "Draft dock");
      expect(within(dialog).getByText(/Description is incomplete/)).toBeTruthy();
      await userEvent.click(within(dialog).getByRole("button", { name: "Save location" }));
      await waitFor(() => expect(createLocation).toHaveBeenCalledTimes(1));
    },
  );

  it("uses Spanish form labels and the shared keyboard-close contract", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWorkspace(workspaceClient(), { locale: "es-US" });
    const trigger = await screen.findByRole("button", { name: "Agregar parte" });
    await userEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Agregar parte" })).toBeTruthy();
    const name = screen.getByLabelText("Nombre", { exact: true });
    await userEvent.type(name, "Parte sin guardar");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Agregar parte" })).toBeTruthy();
    expect(confirm).toHaveBeenCalledWith("¿Descartar los cambios sin guardar?");
    confirm.mockReturnValue(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("hands a stale session to the parent immediately", async () => {
    const onSessionLost = vi.fn();
    renderWorkspace(
      workspaceClient({ access: vi.fn().mockRejectedValue(new UsClientError("session_required")) }),
      { onSessionLost },
    );
    await waitFor(() => expect(onSessionLost).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Parties")).toBeNull();
  });
});
