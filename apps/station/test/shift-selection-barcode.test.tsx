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

function shiftFixture(status: "planned" | "active" | "closed" | "closing") {
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
const closingShift = () => shiftFixture("closing");

type PostMock = (path: string, body?: unknown) => Promise<unknown>;
type OnSelectedMock = (shift: { id: string; status: string; mode: string }) => void;

function renderSelection(options: {
  scan: ReturnType<typeof scanner>;
  items: unknown[];
  post?: PostMock;
  onSelected?: OnSelectedMock;
}) {
  // A `Response` body can be read once. Returning one shared instance makes the
  // second refresh -- the 30 s poll, or any effect-driven reload -- fail to
  // parse, which surfaces as an unrelated load error replacing whatever the
  // test was asserting.
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ items: options.items }), { status: 200 })),
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

  it("says a closing shift is closed rather than pretending the barcode is unreadable", async () => {
    const scan = scanner();
    renderSelection({ scan, items: [closingShift()] });

    await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());
    act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}`));

    expect(await screen.findByText("This shift is closed.")).toBeDefined();
  });

  it("says the barcode matched nothing in the list, not that the shift belongs elsewhere", async () => {
    const scan = scanner();
    renderSelection({ scan, items: [] });

    // Wait for the (empty) initial list to settle so this exercises the
    // genuine "not in the list" case, not the loading race covered below.
    await waitFor(() => expect(screen.getByText("No open shifts")).toBeDefined());
    act(() => scan.scan("markiro:shift:v1:44444444-4444-4444-8444-444444444444"));

    expect(
      await screen.findByText(
        "The form barcode matched no shift in the list. Refresh the list or pick the shift by hand.",
      ),
    ).toBeDefined();
  });

  it("keeps the scan verdict on screen when the background poll refreshes the list", async () => {
    // The poll clears the message it owns before every refresh. A verdict the
    // operator was just given is not that message: wiping it mid-read makes the
    // scan look ignored, and on a slow terminal it vanished within a second of
    // appearing.
    vi.useFakeTimers();
    try {
      const scan = scanner();
      renderSelection({ scan, items: [] });
      // Flush the resolved list fetch and its effects without leaning on a
      // timer: the scan below must see a settled, genuinely empty list.
      await act(async () => {});
      expect(screen.getByText("No open shifts")).toBeDefined();

      act(() => scan.scan("markiro:shift:v1:44444444-4444-4444-8444-444444444444"));
      const verdict =
        "The form barcode matched no shift in the list. Refresh the list or pick the shift by hand.";
      expect(screen.getByText(verdict)).toBeDefined();

      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await act(async () => {});

      expect(screen.getByText(verdict)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call a shift absent while the list is still loading", async () => {
    const scan = scanner();
    // The initial `GET /shifts` promise is held open deliberately so the scan
    // below fires while `loading` is still true -- the exact window where the
    // handler must not judge a shift absent from an empty, not-yet-loaded list.
    let resolveFetch: (response: Response) => void = () => {};
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockReturnValue(pendingFetch);
    const baseClient = createStationClient({
      machineId: "m1",
      apiKey: "k",
      serverUrl: "http://localhost:3000",
    });
    const post = vi
      .fn<PostMock>()
      .mockResolvedValue({ id: SHIFT_ID, status: "active", mode: "validation" });
    const client: StationClient = {
      ...baseClient,
      post: <T,>(path: string, body?: unknown) => post(path, body) as Promise<T>,
    };
    const onSelected = vi.fn<OnSelectedMock>();
    render(
      <ShiftSelection
        client={client}
        onSelected={onSelected}
        onNew={() => {}}
        source={scan.source}
      />,
    );

    act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}`));

    expect(
      await screen.findByText("The shift list is still loading. Scan the form again."),
    ).toBeDefined();
    expect(
      screen.queryByText(
        "The form barcode matched no shift in the list. Refresh the list or pick the shift by hand.",
      ),
    ).toBeNull();
    expect(onSelected).not.toHaveBeenCalled();

    resolveFetch(new Response(JSON.stringify({ items: [plannedShift()] }), { status: 200 }));
    await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());

    act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}`));

    await waitFor(() => expect(onSelected).toHaveBeenCalled());
  });

  it("opens the scanned shift when the scanner appends a trailing terminator", async () => {
    const scan = scanner();
    const post = vi
      .fn<PostMock>()
      .mockResolvedValue({ id: SHIFT_ID, status: "active", mode: "aggregation" });
    const onSelected = vi.fn<OnSelectedMock>();
    renderSelection({ scan, post, onSelected, items: [plannedShift()] });

    await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());
    act(() => scan.scan(`markiro:shift:v1:${SHIFT_ID}\r`));

    await waitFor(() => expect(onSelected).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(`/shifts/${SHIFT_ID}/open`, { entryMethod: "task_barcode" });
  });

  it("opens the scanned shift when the scanner surrounds it with whitespace", async () => {
    const scan = scanner();
    const post = vi
      .fn<PostMock>()
      .mockResolvedValue({ id: SHIFT_ID, status: "active", mode: "aggregation" });
    const onSelected = vi.fn<OnSelectedMock>();
    renderSelection({ scan, post, onSelected, items: [plannedShift()] });

    await waitFor(() => expect(screen.getByText("Test product")).toBeDefined());
    act(() => scan.scan(`  markiro:shift:v1:${SHIFT_ID}  `));

    await waitFor(() => expect(onSelected).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(`/shifts/${SHIFT_ID}/open`, { entryMethod: "task_barcode" });
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
