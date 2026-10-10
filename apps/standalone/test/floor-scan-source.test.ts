import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createComScanSource,
  createKeyboardWedgeSource,
  mergeScanSources,
  type ScanListener,
} from "../src/floor/scan-source.js";

/** The shell's COM scan events as the test drives them; `answer` settles the subscription. */
function comEvents() {
  let listener: ScanListener | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  let settle: { resolve: () => void; reject: (error: unknown) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const subscribe = vi.fn(
    (next: ScanListener) =>
      new Promise<() => void>((resolve, reject) => {
        listener = next;
        settle = { resolve: () => resolve(unsubscribe), reject };
      }),
  );
  return {
    subscribe,
    unsubscribe,
    /** The shell answers the subscription. */
    answer: async () => {
      settle.resolve();
      await Promise.resolve();
    },
    /** The shell has no event channel: nothing is subscribed. */
    fail: async () => {
      listener = null;
      settle.reject(new Error("no event channel"));
      await Promise.resolve();
    },
    /** A frame of a COM scanner, as the shell emits it. */
    emit: (raw: string) => listener?.(raw),
  };
}

/** Every subscription the source makes, each answered and driven on its own. */
function comChannel() {
  const subscriptions: Array<{
    listener: ScanListener;
    unsubscribe: ReturnType<typeof vi.fn<() => void>>;
    answer: () => Promise<void>;
  }> = [];
  const subscribe = (listener: ScanListener) =>
    new Promise<() => void>((resolve) => {
      const unsubscribe = vi.fn<() => void>();
      subscriptions.push({
        listener,
        unsubscribe,
        answer: async () => {
          resolve(unsubscribe);
          await Promise.resolve();
        },
      });
    });
  const at = (index: number) => {
    const subscription = subscriptions[index];
    if (subscription === undefined) throw new Error(`no subscription ${String(index)}`);
    return subscription;
  };
  return { subscribe, subscriptions, at };
}

/** A source that only records what it is asked, to see what a merge passes on. */
function spySource() {
  const stop = vi.fn<() => void>();
  const start = vi.fn<(listener: ScanListener) => () => void>(() => stop);
  const clearPendingInput = vi.fn<() => void>();
  const setManualTextEntryActive = vi.fn<(active: boolean) => void>();
  return {
    source: { start, clearPendingInput, setManualTextEntryActive },
    start,
    stop,
    clearPendingInput,
    setManualTextEntryActive,
  };
}

/** A product's code with the AIM prefix, the group separator and the crypto tail. */
const KM = "]d2010460068200001321MRK-1\u001d93dGVz";

describe("the COM scanners as a scan source", () => {
  it("hands over each frame exactly as the scanner sent it, and skips empty ones", async () => {
    const events = comEvents();
    const scans: string[] = [];
    createComScanSource(events.subscribe).start((raw) => scans.push(raw));
    await events.answer();
    events.emit(KM);
    events.emit("");
    events.emit("]C100046006820000015000");
    expect(scans).toEqual([KM, "]C100046006820000015000"]);
  });

  it("drops the subscription that answers after the source stopped, and delivers nothing", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const stop = createComScanSource(events.subscribe).start((raw) => scans.push(raw));
    stop();
    events.emit(KM);
    await events.answer();
    expect(events.unsubscribe).toHaveBeenCalledTimes(1);
    expect(scans).toEqual([]);
  });

  it("stops listening when stopped after the subscription answered", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const stop = createComScanSource(events.subscribe).start((raw) => scans.push(raw));
    await events.answer();
    stop();
    events.emit(KM);
    expect(events.unsubscribe).toHaveBeenCalledTimes(1);
    expect(scans).toEqual([]);
  });

  it("stays silent, and throws nothing, when the shell has no event channel", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const stop = createComScanSource(events.subscribe).start((raw) => scans.push(raw));
    await events.fail();
    events.emit(KM);
    expect(scans).toEqual([]);
    expect(() => stop()).not.toThrow();
  });

  it("drops scans while a text field takes typing, and delivers again after it", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const source = createComScanSource(events.subscribe);
    source.start((raw) => scans.push(raw));
    await events.answer();
    source.setManualTextEntryActive(true);
    events.emit("MRK-000742");
    source.setManualTextEntryActive(false);
    events.emit(KM);
    expect(scans).toEqual([KM]);
  });

  it("passes a frame untouched: no trimming, no terminator or group separator removed", async () => {
    const events = comEvents();
    const scans: string[] = [];
    createComScanSource(events.subscribe).start((raw) => scans.push(raw));
    await events.answer();
    events.emit("  MRK-000742\r\n");
    events.emit("\u001d]d2010460068200001321MRK-1\u001d");
    expect(scans).toEqual(["  MRK-000742\r\n", "\u001d]d2010460068200001321MRK-1\u001d"]);
  });

  it("unsubscribes once, however often it is stopped", async () => {
    const events = comEvents();
    const stop = createComScanSource(events.subscribe).start(() => undefined);
    await events.answer();
    stop();
    stop();
    expect(events.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("drops scans from the start when a text field already takes typing", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const source = createComScanSource(events.subscribe);
    source.setManualTextEntryActive(true);
    source.start((raw) => scans.push(raw));
    await events.answer();
    events.emit(KM);
    expect(scans).toEqual([]);
  });

  it("subscribes again when started again, and a stop ends only its own start", async () => {
    const channel = comChannel();
    const scans: string[] = [];
    const source = createComScanSource(channel.subscribe);
    const stopFirst = source.start((raw) => scans.push(`first ${raw}`));
    await channel.at(0).answer();
    const stopSecond = source.start((raw) => scans.push(`second ${raw}`));
    await channel.at(1).answer();
    stopFirst();
    expect(channel.at(0).unsubscribe).toHaveBeenCalledTimes(1);
    expect(channel.at(1).unsubscribe).not.toHaveBeenCalled();
    channel.at(1).listener(KM);
    expect(scans).toEqual([`second ${KM}`]);
    stopSecond();
    expect(channel.at(1).unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("lets a start that was stopped before its answer drop only that subscription", async () => {
    const channel = comChannel();
    const scans: string[] = [];
    const source = createComScanSource(channel.subscribe);
    source.start((raw) => scans.push(raw))();
    source.start((raw) => scans.push(raw));
    await channel.at(1).answer();
    await channel.at(0).answer();
    expect(channel.at(0).unsubscribe).toHaveBeenCalledTimes(1);
    expect(channel.at(1).unsubscribe).not.toHaveBeenCalled();
    channel.at(0).listener(KM);
    expect(scans).toEqual([]);
    channel.at(1).listener(KM);
    expect(scans).toEqual([KM]);
  });
});

describe("the keyboard and the COM scanners together", () => {
  it("reach one listener, and stop together", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const stop = mergeScanSources(
      createKeyboardWedgeSource(window),
      createComScanSource(events.subscribe),
    ).start((raw) => scans.push(raw));
    await events.answer();
    for (const key of "MRK-000742") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    events.emit(KM);
    stop();
    for (const key of "0042") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    events.emit(KM);
    expect(scans).toEqual(["MRK-000742", KM]);
    expect(events.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("pass a text field's typing on to both", async () => {
    const events = comEvents();
    const scans: string[] = [];
    const source = mergeScanSources(
      createKeyboardWedgeSource(window),
      createComScanSource(events.subscribe),
    );
    source.start((raw) => scans.push(raw));
    await events.answer();
    source.setManualTextEntryActive(true);
    for (const key of "Анна") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    events.emit(KM);
    source.setManualTextEntryActive(false);
    for (const key of "12") fireEvent.keyDown(window, { key });
    source.clearPendingInput();
    for (const key of "34") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(scans).toEqual(["34"]);
  });

  it("keeps the group separator of the keyboard and of the COM frame alike", async () => {
    const events = comEvents();
    const scans: string[] = [];
    mergeScanSources(
      createKeyboardWedgeSource(window),
      createComScanSource(events.subscribe),
    ).start((raw) => scans.push(raw));
    await events.answer();
    for (const key of "010460068200001321MRK-1") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "]", ctrlKey: true });
    for (const key of "93dGVz") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    events.emit("010460068200001321MRK-1\u001d93dGVz");
    expect(scans).toEqual(["010460068200001321MRK-1\u001d93dGVz", "010460068200001321MRK-1\u001d93dGVz"]);
  });

  it("deliver in the order the scans happened, whichever source they came from", async () => {
    const events = comEvents();
    const scans: string[] = [];
    mergeScanSources(
      createKeyboardWedgeSource(window),
      createComScanSource(events.subscribe),
    ).start((raw) => scans.push(raw));
    await events.answer();
    events.emit("com 1");
    for (const key of "key 1") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    events.emit("com 2");
    for (const key of "key 2") fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(scans).toEqual(["com 1", "key 1", "com 2", "key 2"]);
  });
});

describe("merging scan sources", () => {
  it("starts every source with the one listener and stops each once", () => {
    const first = spySource();
    const second = spySource();
    const third = spySource();
    const listener = vi.fn<(raw: string) => void>();
    const stop = mergeScanSources(first.source, second.source, third.source).start(listener);
    for (const spy of [first, second, third]) {
      expect(spy.start).toHaveBeenCalledTimes(1);
      expect(spy.start).toHaveBeenCalledWith(listener);
      expect(spy.stop).not.toHaveBeenCalled();
    }
    stop();
    for (const spy of [first, second, third]) expect(spy.stop).toHaveBeenCalledTimes(1);
  });

  it("passes the dropping of typed keys and the state of a text field on to every source", () => {
    const first = spySource();
    const second = spySource();
    const merged = mergeScanSources(first.source, second.source);
    merged.clearPendingInput();
    merged.setManualTextEntryActive(true);
    merged.setManualTextEntryActive(false);
    for (const spy of [first, second]) {
      expect(spy.clearPendingInput).toHaveBeenCalledTimes(1);
      expect(spy.setManualTextEntryActive.mock.calls).toEqual([[true], [false]]);
    }
  });

  it("works with no source at all", () => {
    const merged = mergeScanSources();
    expect(() => {
      merged.start(() => undefined)();
      merged.clearPendingInput();
      merged.setManualTextEntryActive(true);
    }).not.toThrow();
  });
});
