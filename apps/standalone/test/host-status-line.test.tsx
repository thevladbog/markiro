import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostStatusLine } from "../src/app/HostStatusLine.js";
import { hostStatusSchema, type HostStatus } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";

/** 14:05 on this computer's clock, whatever its time zone. */
const AT_14_05 = new Date(2026, 8, 27, 14, 5).getTime();
/** 14:05 the day before `AT_14_05`, same clock. */
const YESTERDAY_AT_14_05 = new Date(2026, 8, 26, 14, 5).getTime();

function status(overrides: Partial<HostStatus>): HostStatus {
  return { state: "online", lastContactAt: AT_14_05, lastError: null, seq: 1, ...overrides };
}

describe("HostStatusLine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the host is online, politely for screen readers", () => {
    render(<HostStatusLine status={status({})} />);
    const line = screen.getByText("На связи с хостом").closest(".host-status");
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.getAttribute("role")).toBe("status");
  });

  it("says since when the host is silent and why, on the same day", () => {
    // "Now" pinned to the same local day as `AT_14_05`, so this test does not
    // depend on the real date the suite happens to run on.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 18, 30));
    render(<HostStatusLine status={status({ state: "offline", lastError: "unreachable" })} />);
    expect(screen.getByText("Нет связи с хостом с 14:05")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
  });

  it("adds the date when the last contact fell on an earlier local day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 9, 0));
    render(
      <HostStatusLine
        status={status({
          state: "offline",
          lastError: "unreachable",
          lastContactAt: YESTERDAY_AT_14_05,
        })}
      />,
    );
    expect(screen.getByText("Нет связи с хостом с 26.09 14:05")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
  });

  it("says it is connecting and why the last attempt failed", () => {
    render(<HostStatusLine status={status({ state: "connecting", lastError: "stream_ended" })} />);
    expect(screen.getByText("Подключение к хосту…")).toBeTruthy();
    expect(screen.getByText("Связь с хостом прервалась.")).toBeTruthy();
  });

  it("says the host is silent when it never answered", () => {
    render(
      <HostStatusLine
        status={status({ state: "offline", lastContactAt: null, lastError: "key_rejected" })}
      />,
    );
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.getByText("Хост не принимает это устройство.")).toBeTruthy();
  });

  it("has a text for every reason the shell reports", () => {
    const reasons = hostStatusSchema.shape.lastError.unwrap().options;
    expect(reasons).toHaveLength(5);
    for (const reason of reasons) {
      expect(i18n.exists(`errors.link.${reason}`), reason).toBe(true);
    }
  });

  it("renders the live region empty before the first status, so a screen reader already watches it", () => {
    const { container } = render(<HostStatusLine status={null} />);
    const line = container.querySelector(".host-status");
    expect(line).toBeTruthy();
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.textContent).toBe("");
  });
});
