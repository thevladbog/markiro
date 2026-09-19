import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import i18n from "../src/i18n/index.js";
import { createStationClient, type StationClient } from "../src/lib/api-client.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { ShiftSelection } from "../src/pages/ShiftSelection.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SHIFT_ID = "11111111-1111-4111-8111-111111111111";

function scanner() {
  let listener: ScanListener | null = null;
  let stopped = false;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        stopped = true;
        listener = null;
      };
    },
  };
  return {
    source,
    scan(raw: string) {
      listener?.(raw);
    },
    stopped: () => stopped,
  };
}

function shiftFixture(status: "planned" | "active" | "closed") {
  return {
    id: SHIFT_ID,
    status,
    mode: "validation",
    productName: "Test product",
    plannedQty: 100,
    productId: "product-1",
    // `image: null` keeps ShiftCard on its plain aria-hidden placeholder
    // instead of ProductImage's own text fallback, which would otherwise
    // duplicate the product name and break a plain `getByText`.
    image: null,
  };
}
const plannedShift = () => shiftFixture("planned");
const activeShift = () => shiftFixture("active");
const closedShift = () => shiftFixture("closed");

type PostMock = (path: string, body?: unknown) => Promise<unknown>;
type OnSelectedMock = (shift: { id: string; status: string; mode: string }) => void;

function renderSelection(options: {
  scan: ReturnType<typeof scanner>;
  items: unknown[];
  post?: PostMock;
  onSelected?: OnSelectedMock;
}) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ items: options.items }), { status: 200 }),
  );
  const baseClient = createStationClient({
    machineId: "m1",
    apiKey: "k",
    serverUrl: "http://localhost:3000",
  });
  const post = options.post;
  // `post` is a test spy with a fixed return type; StationClient#post is
  // generic over the caller's expected response shape, so the adapter needs
  // one narrow cast to bridge the two.
  const client: StationClient = post
    ? { ...baseClient, post: <T,>(path: string, body?: unknown) => post(path, body) as Promise<T> }
    : baseClient;
  return render(
    <ShiftSelection
      client={client}
      onSelected={options.onSelected ?? vi.fn()}
      onNew={() => {}}
      source={options.scan.source}
    />,
  );
}

describe("ShiftSelection barcode scanning", () => {
  it("opens the scanned planned shift and tells the server the paper was used", async () => {
    const scan = scanner();
    const post = vi
      .fn<PostMock>()
      .mockResolvedValue({ id: SHIFT_ID, status: "active", mode: "aggregation" });
    const onSelected = vi.fn<OnSelectedMock>();
    renderSelection({ scan, post, onSelected, items: [plannedShift()] });

    await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());
    act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}`));

    await waitFor(() => expect(onSelected).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(`/shifts/${SHIFT_ID}/open`, { entryMethod: "task_barcode" });
  });

  it("enters a scanned active shift without asking the server to open it again", async () => {
    const scan = scanner();
    const post = vi.fn<PostMock>();
    const onSelected = vi.fn<OnSelectedMock>();
    renderSelection({ scan, post, onSelected, items: [activeShift()] });

    await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());
    act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}`));

    await waitFor(() => expect(onSelected).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
  });

  it("says the shift is closed rather than pretending the barcode is unreadable", async () => {
    const scan = scanner();
    renderSelection({ scan, items: [closedShift()] });

    await waitFor(() => expect(screen.getByText("No open shifts")).toBeDefined());
    act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}`));

    expect(await screen.findByText("This shift is closed.")).toBeDefined();
  });

  it("says the shift belongs to another line when it is not in this terminal's list", async () => {
    const scan = scanner();
    renderSelection({ scan, items: [] });

    act(() => scan.scan("markiro:shift:v1:44444444-4444-4444-8444-444444444444"));

    expect(await screen.findByText("This shift is not on this line.")).toBeDefined();
  });

  it("reports an unreadable barcode for a well-prefixed payload that is not a shift id", async () => {
    const scan = scanner();
    renderSelection({ scan, items: [plannedShift()] });

    act(() => scan.scan("markiro:shift:v1:not-a-uuid"));

    expect(await screen.findByText("The shift form barcode could not be read.")).toBeDefined();
  });

  it("ignores a production code so a unit scan never navigates the terminal", async () => {
    const scan = scanner();
    const onSelected = vi.fn<OnSelectedMock>();
    renderSelection({ scan, onSelected, items: [plannedShift()] });

    await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());
    act(() => scan.scan("010468008990038321ABC93XYZ"));

    expect(onSelected).not.toHaveBeenCalled();
    expect(screen.queryByText("The shift form barcode could not be read.")).toBeNull();
  });
});
