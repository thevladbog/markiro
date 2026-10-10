import i18n from "i18next";
import { describe, expect, it } from "vitest";

import { formatSize, formatWhen } from "../src/office/backups/backup-format.js";

describe("formatWhen", () => {
  it("writes an instant in the zone it is given, not this PC's", () => {
    const instant = "2026-10-09T21:30:00Z";
    expect(formatWhen(instant, "Europe/Moscow")).toBe("10.10.2026, 00:30");
    expect(formatWhen(instant, "Asia/Vladivostok")).toContain("10.10.2026");
    expect(formatWhen(instant, "Asia/Vladivostok")).toContain("07:30");
    expect(formatWhen(instant, "America/New_York")).toContain("09.10.2026");
    expect(formatWhen(instant, "America/New_York")).toContain("17:30");
  });

  it("falls back to this PC's zone without one", () => {
    const instant = "2026-10-09T21:30:00Z";
    expect(formatWhen(instant, null)).toBe(formatWhen(instant));
    expect(formatWhen(instant)).toBe(
      new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(
        new Date(instant),
      ),
    );
  });
});

describe("formatSize", () => {
  it("counts kilobytes up below a megabyte and megabytes with one decimal above", () => {
    const plain = (bytes: number) => formatSize(bytes, i18n.t).replace(/\s/g, " ");
    expect(plain(0)).toBe("0 КБ");
    expect(plain(1)).toBe("1 КБ");
    expect(plain(1024)).toBe("1 КБ");
    expect(plain(1025)).toBe("2 КБ");
    expect(plain(1024 * 1024 - 1)).toBe("1 024 КБ");
    expect(plain(1024 * 1024)).toBe("1 МБ");
    expect(plain(4.5 * 1024 * 1024)).toBe("4,5 МБ");
  });
});
