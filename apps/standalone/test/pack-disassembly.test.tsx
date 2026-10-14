import { readFileSync } from "node:fs";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import { disaggregationDetailSchema } from "../src/host/disaggregation.js";
import { renderOffice, TECHNOLOGIST } from "./support/office.js";
import { BOX_CARD, CARD_SHIFT, packSession, PALLET_CARD } from "./support/pack-cards.js";

// The page of a document is plan ДЗГ-О's: here the navigation to it is the observable.
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useNavigate: () => navigate };
});

const testModuleUrl = import.meta.url;
const DETAIL = disaggregationDetailSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/disaggregation-detail.json", testModuleUrl), "utf8"),
  ),
);
const DOC_ID = DETAIL.document.id;
const BOX_PATH = `/codes/box/${BOX_CARD.id}`;
const PALLET_PATH = `/codes/pallet/${PALLET_CARD.id}`;
const BOX_SSCC = "046006820000015000";
const PALLET_SSCC = "146006820000000409";

beforeEach(() => {
  navigate.mockClear();
});

function session(user?: Parameters<typeof packSession>[1], status: "active" | "closed" = "closed") {
  const shift = { ...CARD_SHIFT, status };
  const value = packSession([shift], user);
  value.api.getBoxCard.mockResolvedValue({
    ...BOX_CARD,
    shift: { ...BOX_CARD.shift, status },
  });
  value.api.getPalletCard.mockResolvedValue({
    ...PALLET_CARD,
    shift: { ...PALLET_CARD.shift, status },
  });
  value.api.createDisaggregation.mockResolvedValue(DETAIL);
  value.api.addDisaggregationLines.mockResolvedValue(DETAIL);
  return value;
}

async function open(value: ReturnType<typeof session>, path: string, title: string) {
  renderOffice(value, { initialPath: path });
  await screen.findByRole("heading", { name: title });
}

describe.each([
  ["a pallet", PALLET_PATH, "Паллета (00)146006820000000409", PALLET_SSCC],
  ["a box", BOX_PATH, "Короб (00)046006820000015000", BOX_SSCC],
])("«Расформировать» on the card of %s (plan КРТ)", (_, path, title, sscc) => {
  it("makes a draft with the SSCC as its line and opens the document", async () => {
    const value = session();
    await open(value, path, title);
    fireEvent.click(screen.getByRole("button", { name: "Расформировать" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/disaggregation/${DOC_ID}`));
    expect(value.api.createDisaggregation).toHaveBeenCalledTimes(1);
    expect(value.api.createDisaggregation).toHaveBeenCalledWith("office-session-token", {
      reasonId: null,
      comment: null,
    });
    expect(value.api.addDisaggregationLines).toHaveBeenCalledWith("office-session-token", DOC_ID, {
      lines: [{ input: sscc, sscc }],
      import: false,
    });
  });

  it("sends nothing twice while the first press is still working", async () => {
    const value = session();
    let release: (detail: typeof DETAIL) => void = () => undefined;
    value.api.createDisaggregation.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await open(value, path, title);
    const button = screen.getByRole("button", { name: "Расформировать" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(value.api.createDisaggregation).toHaveBeenCalledTimes(1));
    release(DETAIL);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(value.api.createDisaggregation).toHaveBeenCalledTimes(1);
  });

  it("is a technologist's, too", async () => {
    await open(session(TECHNOLOGIST), path, title);
    expect(screen.getByRole("button", { name: "Расформировать" })).toBeTruthy();
  });

  it("is not offered while the shift is active, and says why", async () => {
    await open(session(undefined, "active"), path, title);
    expect(screen.queryByRole("button", { name: "Расформировать" })).toBeNull();
    expect(screen.getByText("Расформировать можно после закрытия смены")).toBeTruthy();
  });

  it("says a document could not be made, keeps the card, and adds no line", async () => {
    const value = session();
    value.api.createDisaggregation.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "host down" }),
    );
    await open(value, path, title);
    fireEvent.click(screen.getByRole("button", { name: "Расформировать" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Не удалось создать документ дезагрегации");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(value.api.addDisaggregationLines).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
  });

  it("names the draft that was made without its line, and offers to open it", async () => {
    const value = session();
    value.api.addDisaggregationLines.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "host down" }),
    );
    await open(value, path, title);
    fireEvent.click(screen.getByRole("button", { name: "Расформировать" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Документ DSG-26-0001 создан, но SSCC не добавлен");
    const link = within(alert).getByRole("link", { name: "Открыть документ DSG-26-0001" });
    expect(link.getAttribute("href")).toBe(`/disaggregation/${DOC_ID}`);
    expect(navigate).not.toHaveBeenCalled();
    // A second press would make another empty draft.
    expect(screen.queryByRole("button", { name: "Расформировать" })).toBeNull();
  });
});

describe("where «Расформировать» is not offered (plan КРТ)", () => {
  it("not for a pallet already taken apart, an open one, or one with no SSCC", async () => {
    for (const change of [
      { disassembledAt: "2026-10-08T07:00:00.000Z" },
      { closedAt: null, sscc: null },
    ]) {
      const value = session();
      value.api.getPalletCard.mockResolvedValue({ ...PALLET_CARD, ...change });
      const { unmount } = renderOffice(value, { initialPath: PALLET_PATH });
      await screen.findByRole("heading", { name: /^Паллета/ });
      expect(screen.queryByRole("button", { name: "Расформировать" })).toBeNull();
      expect(screen.queryByText("Расформировать можно после закрытия смены")).toBeNull();
      unmount();
    }
  });

  it("not for a box already taken apart or one still open", async () => {
    for (const change of [
      { disassembledAt: "2026-10-08T07:00:00.000Z" },
      { closedAt: null, sscc: null, digestMatches: null },
    ]) {
      const value = session();
      value.api.getBoxCard.mockResolvedValue({ ...BOX_CARD, ...change });
      const { unmount } = renderOffice(value, { initialPath: BOX_PATH });
      await screen.findByRole("heading", { name: /^Короб/ });
      expect(screen.queryByRole("button", { name: "Расформировать" })).toBeNull();
      unmount();
    }
  });
});
