import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { CloudCodeItem, CodeRegistryCard } from "../src/host/code-registry.js";
import { fakeOfficeSession, ORG_PROFILE, renderOffice } from "./support/office.js";

const CLOUD: CloudCodeItem = {
  id: "cloud-code-1",
  codeHash: "a".repeat(64),
  canonical: null,
  gtin14: "04600682000013",
  serial: "IMPORTED",
  scannedAt: "2026-10-01T12:00:00Z",
  sourceTimeZone: "Europe/Moscow",
  state: "owned",
  releasedAt: null,
  shiftId: "cloud-shift",
  shiftNumber: "OCT26-001",
  shiftAvailable: true,
  productionDate: "2026-10-01",
  productName: "Яблочный сок",
  lineName: null,
  boxId: "cloud-box",
  boxSscc: "046006820000015000",
  boxClosedAt: "2026-10-01T13:00:00Z",
  boxDisassembledAt: null,
  boxAvailable: true,
  palletId: null,
  palletSscc: null,
  palletDisassembledAt: null,
  palletAvailable: false,
};
const CARD: CodeRegistryCard = {
  codeHash: CLOUD.codeHash,
  local: null,
  cloud: [CLOUD],
  cloudCapped: false,
  currentOwner: { source: "cloud", item: CLOUD },
};
function session() {
  const value = fakeOfficeSession();
  value.api.getOrg.mockResolvedValue(ORG_PROFILE);
  value.api.listShifts.mockResolvedValue([]);
  value.api.searchCodeRegistry.mockResolvedValue({
    items: [{ source: "cloud", item: CLOUD }],
    total: 1,
    page: 1,
    pageCount: 1,
    capped: false,
  });
  value.api.getCodeRegistryCard.mockResolvedValue(CARD);
  return value;
}
afterEach(cleanup);

describe("unified imported-code search", () => {
  it("defaults to all sources, shows imported facts and opens the cloud card", async () => {
    const value = session();
    renderOffice(value, { initialPath: "/codes?gtin=04600682000013" });
    await screen.findByText("Найдено: 1");
    expect(value.api.searchCodeRegistry).toHaveBeenCalledWith("office-session-token", {
      gtin: "04600682000013",
      source: "all",
    });
    const table = screen.getByRole("table");
    expect(within(table).getByText("Из облака")).toBeTruthy();
    expect(within(table).getByRole("link", { name: "OCT26-001" }).getAttribute("href")).toBe(
      "/cloud-shifts/cloud-shift",
    );
    fireEvent.click(within(table).getByText("010460068200001321IMPORTED"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Снимок из облака")).toBeTruthy();
    expect(within(dialog).queryByText("Свободен: ни в одном коробе")).toBeNull();
    expect(
      within(dialog).getByRole("link", { name: "(00)046006820000015000" }).getAttribute("href"),
    ).toBe("/cloud-boxes/cloud-box");
    expect(within(dialog).queryByRole("heading", { name: "История" })).toBeNull();
  });

  it("changes the source, resets paging and preserves the criterion in navigation", async () => {
    const value = session();
    renderOffice(value, { initialPath: "/codes?gtin=04600682000013&page=3" });
    await screen.findByText("Найдено: 1");
    fireEvent.click(screen.getByRole("radio", { name: "Из облака" }));
    await waitFor(() =>
      expect(value.api.searchCodeRegistry).toHaveBeenLastCalledWith("office-session-token", {
        gtin: "04600682000013",
        source: "cloud",
      }),
    );
    expect(screen.getByRole("radio", { name: "Из облака" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Местные" }));
    await waitFor(() =>
      expect(value.api.searchCodeRegistry).toHaveBeenLastCalledWith("office-session-token", {
        gtin: "04600682000013",
        source: "local",
      }),
    );
  });

  it("shows owner-only provenance without invented identity or unavailable links", async () => {
    const value = session();
    const owner = {
      ...CLOUD,
      canonical: null,
      gtin14: null,
      serial: null,
      shiftAvailable: false,
      productName: null,
      boxAvailable: false,
      boxSscc: null,
      sourceTimeZone: "Mars/Base",
    };
    value.api.getCodeRegistryCard.mockResolvedValue({
      ...CARD,
      cloud: [owner],
      currentOwner: { source: "cloud", item: owner },
    });
    renderOffice(value, { initialPath: `/codes?codeHash=${CLOUD.codeHash}&source=cloud` });
    await screen.findByText("Снимок из облака");
    expect(screen.queryByRole("link", { name: "OCT26-001" })).toBeNull();
    expect(screen.getAllByText(/2026-10-01T12:00:00Z.*Mars\/Base/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/01null21null/)).toBeNull();
    expect(value.api.getCodeRegistryCard).toHaveBeenCalledWith(
      "office-session-token",
      CLOUD.codeHash,
      "cloud",
    );
  });

  it("explains an older host instead of presenting an empty cloud search", async () => {
    const value = session();
    value.api.searchCodeRegistry.mockRejectedValue(
      new HostError({ kind: "api", code: "not_found", message: "route", status: 404 }),
    );
    renderOffice(value, { initialPath: "/codes?gtin=04600682000013" });
    expect(await screen.findByText(/Обновите службу хоста для общего поиска/)).toBeTruthy();
    expect(screen.queryByText("Ничего не найдено")).toBeNull();
  });

  it("distinguishes a missing card from an older host's missing route", async () => {
    const value = session();
    const absent = new HostError({ kind: "api", code: "not_found", message: "route", status: 404 });
    value.api.getCodeRegistryCard.mockRejectedValue(absent);
    value.api.searchCodeRegistry.mockRejectedValue(absent);
    renderOffice(value, { initialPath: `/codes?codeHash=${CLOUD.codeHash}` });
    expect(await screen.findByText(/Обновите службу хоста для общего поиска/)).toBeTruthy();
    expect(screen.queryByText("Код не найден в выбранном источнике")).toBeNull();
  });

  it("keeps known identity and global cloud ownership when only local history is selected", async () => {
    const value = session();
    value.api.getCodeRegistryCard.mockResolvedValue({
      ...CARD,
      local: null,
      cloud: [],
      currentOwner: {
        source: "cloud",
        item: { ...CLOUD, canonical: "010460068200001321IMPORTED\u001d93KNOWN" },
      },
    });
    renderOffice(value, { initialPath: `/codes?codeHash=${CLOUD.codeHash}&source=local` });
    expect(await screen.findByText("Яблочный сок")).toBeTruthy();
    expect(screen.getByText("010460068200001321IMPORTED<GS>93KNOWN")).toBeTruthy();
    expect(screen.getByText("Принят в облаке")).toBeTruthy();
    expect(screen.queryByText("Свободен: ни в одном коробе")).toBeNull();
    expect(screen.queryByText("Снимок из облака")).toBeNull();
  });

  it("uses known local identity even when an owner-only cloud record has no identity", async () => {
    const value = session();
    const owner = { ...CLOUD, gtin14: null, serial: null, canonical: null };
    value.api.getCodeRegistryCard.mockResolvedValue({
      ...CARD,
      cloud: [owner],
      local: {
        codeHash: CLOUD.codeHash,
        gtin14: "04600682000013",
        serial: "LOCAL",
        canonical: "010460068200001321LOCAL\u001d93TAIL",
        ownerScanId: null,
        placements: [],
        events: [],
      },
      currentOwner: { source: "cloud", item: owner },
    });
    renderOffice(value, { initialPath: `/codes?codeHash=${CLOUD.codeHash}` });
    expect(await screen.findByText("010460068200001321LOCAL", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Свободен: ни в одном коробе")).toBeNull();
  });
});
