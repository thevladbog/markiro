import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostStatusLine } from "../src/app/HostStatusLine.js";
import type { SyncFailure, SyncState } from "../src/app/shell.js";
import { hostStatusSchema, type HostStatus } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";

/** 14:05 on this computer's clock, whatever its time zone. */
const AT_14_05 = new Date(2026, 8, 27, 14, 5).getTime();
/** 14:05 the day before `AT_14_05`, same clock. */
const YESTERDAY_AT_14_05 = new Date(2026, 8, 26, 14, 5).getTime();

const SYNC_FAILED = "Справочники не обновились — повторим автоматически";

function status(overrides: Partial<HostStatus>): HostStatus {
  return { state: "online", lastContactAt: AT_14_05, lastError: null, seq: 1, ...overrides };
}

function sync(overrides: Partial<SyncState>): SyncState {
  return { kind: "done", synced: 1, failure: null, quarantined: 0, ...overrides };
}

describe("HostStatusLine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the host is online, politely for screen readers", () => {
    render(<HostStatusLine status={status({})} sync={null} />);
    const line = screen.getByText("На связи с хостом").closest(".host-status");
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.getAttribute("role")).toBe("status");
  });

  it("says since when the host is silent and why, on the same day", () => {
    // "Now" pinned to the same local day as `AT_14_05`, so this test does not
    // depend on the real date the suite happens to run on.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 18, 30));
    render(
      <HostStatusLine
        status={status({ state: "offline", lastError: "unreachable" })}
        sync={null}
      />,
    );
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
        sync={null}
      />,
    );
    expect(screen.getByText("Нет связи с хостом с 26.09 14:05")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
  });

  it("shows the date when the last contact was the same day of an earlier month", () => {
    // A day-of-month-only comparison (27 == 27) would wrongly call this
    // "today" and hide the date: 27 August is not 27 September.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 9, 0));
    const lastMonthSameDate = new Date(2026, 7, 27, 14, 5).getTime();
    render(
      <HostStatusLine
        status={status({
          state: "offline",
          lastError: "unreachable",
          lastContactAt: lastMonthSameDate,
        })}
        sync={null}
      />,
    );
    expect(screen.getByText("Нет связи с хостом с 27.08 14:05")).toBeTruthy();
  });

  it("says it is connecting and why the last attempt failed", () => {
    render(
      <HostStatusLine
        status={status({ state: "connecting", lastError: "stream_ended" })}
        sync={null}
      />,
    );
    expect(screen.getByText("Подключение к хосту…")).toBeTruthy();
    expect(screen.getByText("Связь с хостом прервалась.")).toBeTruthy();
  });

  it("says the host is silent when it never answered", () => {
    render(
      <HostStatusLine
        status={status({ state: "offline", lastContactAt: null, lastError: "key_rejected" })}
        sync={null}
      />,
    );
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.getByText("Хост не принимает это устройство.")).toBeTruthy();
  });

  it("says which side to update when the versions do not match", () => {
    render(
      <HostStatusLine
        status={status({
          state: "offline",
          lastContactAt: null,
          lastError: "app_too_old",
          hostVersion: "0.3.0",
        })}
        sync={null}
      />,
    );
    expect(screen.getByText("Это приложение старее хоста: обновите его с хоста.")).toBeTruthy();
  });

  it("has a text for every reason the shell reports", () => {
    const reasons = hostStatusSchema.shape.lastError.unwrap().options;
    expect(reasons).toHaveLength(8);
    for (const reason of reasons) {
      expect(i18n.exists(`errors.link.${reason}`), reason).toBe(true);
    }
  });

  it("renders the live region empty before the first status, so a screen reader already watches it", () => {
    const { container } = render(<HostStatusLine status={null} sync={null} />);
    const line = container.querySelector(".host-status");
    expect(line).toBeTruthy();
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.textContent).toBe("");
  });

  it.each<[SyncFailure, string]>([
    ["host", "Запрос к хосту не удался."],
    ["local", "Не удалось записать справочники на этом компьютере."],
    ["feed", "Ленту изменений хоста не удалось применить."],
  ])(
    "warns while the host answers that the copies did not update (%s), in the live region",
    (failure, reason) => {
      render(<HostStatusLine status={status({})} sync={sync({ kind: "failed", failure })} />);
      const warning = screen.getByText(SYNC_FAILED);
      expect(warning.closest(".host-status")?.getAttribute("aria-live")).toBe("polite");
      expect(screen.getByText(reason)).toBeTruthy();
    },
  );

  it("keeps the warning through the retry's own run", () => {
    render(
      <HostStatusLine status={status({})} sync={sync({ kind: "running", failure: "host" })} />,
    );
    expect(screen.getByText(SYNC_FAILED)).toBeTruthy();
  });

  it("leaves a failed sync to the link's own words while the host is away", () => {
    render(
      <HostStatusLine
        status={status({ state: "offline", lastContactAt: null, lastError: "unreachable" })}
        sync={sync({ kind: "failed", failure: "host" })}
      />,
    );
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.queryByText(SYNC_FAILED)).toBeNull();
  });

  it.each<[string, HostStatus | null]>([
    ["an online link", status({})],
    ["a connecting link", status({ state: "connecting", lastError: null })],
    [
      "an offline link",
      status({ state: "offline", lastContactAt: null, lastError: "unreachable" }),
    ],
    // Before the shell's first status (also the office header outside the
    // app): a restart with the host away must still show a count read after
    // the failed run, so this case matters for the reducer's `sync_failed`
    // handling, not only for this component.
    ["no link status yet", null],
  ])("counts the records the copies did not accept, with %s", (_label, linkStatus) => {
    render(<HostStatusLine status={linkStatus} sync={sync({ quarantined: 3 })} />);
    const count = screen.getByText("Не приняты записи справочников: 3");
    expect(count.closest(".host-status")?.getAttribute("role")).toBe("status");
  });

  it("says nothing more while the copies are up to date", () => {
    render(<HostStatusLine status={status({})} sync={sync({})} />);
    expect(screen.getByText("На связи с хостом")).toBeTruthy();
    expect(screen.queryByText(SYNC_FAILED)).toBeNull();
    expect(screen.queryByText(/Не приняты записи справочников/)).toBeNull();
  });
});
