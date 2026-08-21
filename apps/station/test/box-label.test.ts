import { describe, expect, it } from "vitest";

import {
  addCalendarDays,
  boxLabelFields,
  expiryIsoDate,
  localIsoDate,
} from "../src/lib/box-label.js";
import { withTimeZone } from "./support/timezone.js";

/**
 * Project rule: storage keeps every timestamp in UTC, devices and web show
 * LOCAL dates. A box label is read by a human next to the station, so
 * «Дата производства» and «Годен до» are the STATION's calendar days.
 *
 * Every assertion below that depends on "local" pins the zone explicitly via
 * `withTimeZone` — the same test must pass on a Moscow laptop and on a UTC CI
 * runner. The guard test immediately below fails if that pinning ever stops
 * working, so a silently zone-dependent suite cannot go green by accident.
 */
describe("timezone pinning (guard)", () => {
  it("process.env.TZ really changes what Date treats as local", () => {
    const instant = "2025-05-19T22:00:00.000Z";
    expect(withTimeZone("UTC", () => new Date(instant).getHours())).toBe(22);
    expect(withTimeZone("Europe/Moscow", () => new Date(instant).getHours())).toBe(1);
    expect(withTimeZone("America/Los_Angeles", () => new Date(instant).getHours())).toBe(15);
  });

  it("restores the ambient zone after the pinned call", () => {
    const before = process.env.TZ;
    withTimeZone("Pacific/Kiritimati", () => new Date().getHours());
    expect(process.env.TZ).toBe(before);
  });
});

describe("localIsoDate", () => {
  // 22:00 UTC on the 19th is 01:00 on the 20th in Moscow: the case that used
  // to print YESTERDAY's production date on a night-shift box.
  it("prints the station's own day for a zone AHEAD of UTC", () => {
    expect(withTimeZone("Europe/Moscow", () => localIsoDate("2025-05-19T22:00:00.000Z"))).toBe(
      "2025-05-20",
    );
  });

  // 04:00 UTC on the 20th is still 21:00 on the 19th in Los Angeles: the same
  // divergence in the opposite direction.
  it("prints the station's own day for a zone BEHIND UTC", () => {
    expect(
      withTimeZone("America/Los_Angeles", () => localIsoDate("2025-05-20T04:00:00.000Z")),
    ).toBe("2025-05-19");
  });

  it("agrees with the UTC date part only when the station is in UTC", () => {
    const instant = "2025-05-19T22:00:00.000Z";
    expect(withTimeZone("UTC", () => localIsoDate(instant))).toBe("2025-05-19");
    expect(withTimeZone("Asia/Kolkata", () => localIsoDate(instant))).toBe("2025-05-20");
  });

  it("zero-pads month and day", () => {
    expect(withTimeZone("UTC", () => localIsoDate("2026-01-02T00:00:00.000Z"))).toBe("2026-01-02");
  });

  it("returns empty rather than throwing on a malformed instant", () => {
    expect(withTimeZone("Europe/Moscow", () => localIsoDate("garbage"))).toBe("");
    expect(withTimeZone("Europe/Moscow", () => localIsoDate(""))).toBe("");
  });
});

/**
 * `addCalendarDays` is deliberately timezone-FREE: it is plain civil-date
 * arithmetic on a `YYYY-MM-DD` string. These tests assert that property
 * directly instead of trusting it.
 */
describe("addCalendarDays", () => {
  it("matches the mock-up: 2025-05-20 + 184 days = 2025-11-20", () => {
    expect(addCalendarDays("2025-05-20", 184)).toBe("2025-11-20");
  });

  it("rolls over year and leap-day boundaries", () => {
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addCalendarDays("2025-02-28", 1)).toBe("2025-03-01");
  });

  it("returns the identical string in every timezone, DST zones included", () => {
    const zones = [
      "UTC",
      "Europe/Moscow",
      "America/New_York",
      "Australia/Lord_Howe",
      "Asia/Kolkata",
      "Pacific/Kiritimati",
      "Pacific/Niue",
    ];
    const results = zones.map((tz) => withTimeZone(tz, () => addCalendarDays("2025-03-01", 184)));
    expect(results).toEqual(zones.map(() => "2025-09-01"));
  });

  // A day that is 23 hours long (spring forward) or 25 hours long (fall back)
  // must still count as exactly one calendar day. Millisecond-based date math
  // drifts here; this walks straight through both US 2025 transitions.
  it("never drifts a day across a DST transition", () => {
    withTimeZone("America/New_York", () => {
      // 2025-03-09 springs forward, 2025-11-02 falls back.
      expect(addCalendarDays("2025-03-08", 1)).toBe("2025-03-09");
      expect(addCalendarDays("2025-03-09", 1)).toBe("2025-03-10");
      expect(addCalendarDays("2025-11-01", 1)).toBe("2025-11-02");
      expect(addCalendarDays("2025-11-02", 1)).toBe("2025-11-03");
      // Stepping one day at a time across a whole year must land exactly
      // where a single 365-day jump does.
      let stepped = "2025-01-01";
      for (let i = 0; i < 365; i += 1) stepped = addCalendarDays(stepped, 1);
      expect(stepped).toBe("2026-01-01");
      expect(addCalendarDays("2025-01-01", 365)).toBe("2026-01-01");
    });
  });

  it("returns empty for a malformed or non-existent date", () => {
    expect(addCalendarDays("", 10)).toBe("");
    expect(addCalendarDays("garbage", 10)).toBe("");
    expect(addCalendarDays("2025-5-20", 10)).toBe("");
    expect(addCalendarDays("2025-05-20T10:15:00.000Z", 10)).toBe("");
    expect(addCalendarDays("2025-02-30", 1)).toBe("");
    expect(addCalendarDays("2025-13-01", 1)).toBe("");
  });
});

describe("expiryIsoDate", () => {
  it("counts from an explicit production date instead of the local close day", () => {
    expect(
      withTimeZone("Europe/Moscow", () =>
        expiryIsoDate("2026-03-01T22:30:00.000Z", 2, "2026-02-27"),
      ),
    ).toBe("2026-03-01");
  });

  it("counts the shelf life from the LOCAL production date", () => {
    // 01:00 Moscow on 2025-05-20, stored as 22:00 UTC on the 19th.
    expect(
      withTimeZone("Europe/Moscow", () => expiryIsoDate("2025-05-19T22:00:00.000Z", 184)),
    ).toBe("2025-11-20");
    // The same instant in UTC is still the 19th, so the expiry is a day earlier.
    expect(withTimeZone("UTC", () => expiryIsoDate("2025-05-19T22:00:00.000Z", 184))).toBe(
      "2025-11-19",
    );
    // Behind UTC: 04:00 UTC on the 20th is the 19th in Los Angeles.
    expect(
      withTimeZone("America/Los_Angeles", () => expiryIsoDate("2025-05-20T04:00:00.000Z", 184)),
    ).toBe("2025-11-19");
  });

  it("matches the mock-up in the station's own zone: 2025-05-20 + 184 = 2025-11-20", () => {
    expect(
      withTimeZone("Europe/Moscow", () => expiryIsoDate("2025-05-20T10:15:00.000Z", 184)),
    ).toBe("2025-11-20");
    expect(withTimeZone("UTC", () => expiryIsoDate("2025-05-20T10:15:00.000Z", 184))).toBe(
      "2025-11-20",
    );
  });

  it("is unshifted by a DST transition inside the shelf-life window", () => {
    // 2025-03-01 local + 184 days = 2025-09-01, with spring-forward on
    // 2025-03-09 (northern) and fall-back on 2025-04-06 (southern) in between.
    expect(
      withTimeZone("America/New_York", () => expiryIsoDate("2025-03-01T17:00:00.000Z", 184)),
    ).toBe("2025-09-01");
    expect(
      withTimeZone("Australia/Sydney", () => expiryIsoDate("2025-03-01T01:00:00.000Z", 184)),
    ).toBe("2025-09-01");
  });

  it("rolls over year and leap-day boundaries in local time", () => {
    expect(withTimeZone("Europe/Moscow", () => expiryIsoDate("2026-12-31T09:00:00.000Z", 1))).toBe(
      "2027-01-01",
    );
    expect(withTimeZone("Europe/Moscow", () => expiryIsoDate("2024-02-28T09:00:00.000Z", 1))).toBe(
      "2024-02-29",
    );
  });

  it("rolls an explicit production date over leap-day and year boundaries", () => {
    expect(expiryIsoDate("2025-01-01T00:00:00.000Z", 1, "2024-02-28")).toBe("2024-02-29");
    expect(expiryIsoDate("2025-01-01T00:00:00.000Z", 1, "2026-12-31")).toBe("2027-01-01");
  });

  it("fails safe instead of falling back when an explicit date is malformed", () => {
    expect(expiryIsoDate("2025-05-20T00:00:00.000Z", 10, "2025-02-30")).toBe("");
    expect(expiryIsoDate("2025-05-20T00:00:00.000Z", 10, "not-a-date")).toBe("");
  });

  it("returns empty for null, non-integer, non-positive, or invalid input", () => {
    withTimeZone("Europe/Moscow", () => {
      expect(expiryIsoDate("2025-05-20T00:00:00.000Z", null)).toBe("");
      expect(expiryIsoDate("2025-05-20T00:00:00.000Z", 0)).toBe("");
      expect(expiryIsoDate("2025-05-20T00:00:00.000Z", -5)).toBe("");
      expect(expiryIsoDate("2025-05-20T00:00:00.000Z", 1.5)).toBe("");
      expect(expiryIsoDate("2025-05-20T00:00:00.000Z", Number.NaN)).toBe("");
      expect(expiryIsoDate("garbage", 10)).toBe("");
      expect(expiryIsoDate("", 10)).toBe("");
    });
  });
});

describe("boxLabelFields — egais/expiry", () => {
  const base = {
    sscc: "346006820000000014",
    itemCount: 24,
    productName: "Сидр",
    gtin14: "04600682000013",
    operatorName: null,
    counterpartyName: null,
    closedAt: "2025-05-19T22:00:00.000Z",
    productionDate: null,
    shiftNumber: null,
  };

  it("fills product.egais and computed expiry", () => {
    const fields = withTimeZone("Europe/Moscow", () =>
      boxLabelFields({ ...base, egaisCode: "0101234567890123456", shelfLifeDays: 184 }),
    );
    expect(fields["product.egais"]).toBe("0101234567890123456");
    expect(fields.expiry).toBe("20.11.2025");
  });

  // The whole point of the change: both printed dates are the station's own
  // calendar days, so the same stored instant renders differently on a
  // Moscow station and on a UTC one.
  it("prints the station's LOCAL production and expiry dates", () => {
    const moscow = withTimeZone("Europe/Moscow", () =>
      boxLabelFields({ ...base, egaisCode: null, shelfLifeDays: 184 }),
    );
    expect(moscow.date).toBe("20.05.2025");
    expect(moscow.expiry).toBe("20.11.2025");

    const utc = withTimeZone("UTC", () =>
      boxLabelFields({ ...base, egaisCode: null, shelfLifeDays: 184 }),
    );
    expect(utc.date).toBe("19.05.2025");
    expect(utc.expiry).toBe("19.11.2025");
  });

  it("prints one explicit production date and derives expiry from that same date", () => {
    const fields = withTimeZone("Europe/Moscow", () =>
      boxLabelFields({
        ...base,
        closedAt: "2026-03-01T22:30:00.000Z",
        productionDate: "2026-02-27",
        egaisCode: null,
        shelfLifeDays: 2,
      }),
    );
    expect(fields.date).toBe("27.02.2026");
    expect(fields.expiry).toBe("01.03.2026");
  });

  it("reprints the same explicit production and expiry dates across local close days", () => {
    const input = {
      ...base,
      closedAt: "2026-03-01T22:30:00.000Z",
      productionDate: "2026-02-27",
      egaisCode: null,
      shelfLifeDays: 2,
    };
    const firstPrint = withTimeZone("Europe/Moscow", () => boxLabelFields(input));
    const reprint = withTimeZone("America/Los_Angeles", () => boxLabelFields(input));

    expect({ date: firstPrint.date, expiry: firstPrint.expiry }).toEqual({
      date: "27.02.2026",
      expiry: "01.03.2026",
    });
    expect({ date: reprint.date, expiry: reprint.expiry }).toEqual({
      date: "27.02.2026",
      expiry: "01.03.2026",
    });
  });

  /**
   * DATE FORMAT REGRESSION GUARD. The first physical print of the stock box
   * label read `2026-08-20` where the customer-approved mock-up says
   * `20.08.2026`, because the field VALUES were the same `YYYY-MM-DD` strings
   * the shelf-life arithmetic runs on. The arithmetic still is — `localIsoDate`
   * and `addCalendarDays` above are asserted in ISO on purpose — but what
   * reaches the printer must be `дд.мм.гггг` and nothing else.
   */
  it("formats both printed dates as дд.мм.гггг, never ISO", () => {
    const fields = withTimeZone("Europe/Moscow", () =>
      boxLabelFields({ ...base, egaisCode: null, shelfLifeDays: 184 }),
    );
    expect(fields.date).toBe("20.05.2025");
    expect(fields.expiry).toBe("20.11.2025");
    expect(fields.date).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fields.expiry).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Zero padding survives: a label column is a fixed width.
    const padded = withTimeZone("UTC", () =>
      boxLabelFields({
        ...base,
        closedAt: "2026-01-02T12:00:00.000Z",
        egaisCode: null,
        shelfLifeDays: 5,
      }),
    );
    expect(padded.date).toBe("02.01.2026");
    expect(padded.expiry).toBe("07.01.2026");
  });

  it("leaves the stored closedAt instant untouched", () => {
    const input = { ...base, egaisCode: null, shelfLifeDays: 184 };
    withTimeZone("Europe/Moscow", () => boxLabelFields(input));
    expect(input.closedAt).toBe("2025-05-19T22:00:00.000Z");
  });

  it("degrades to empty strings when the product carries neither", () => {
    const fields = withTimeZone("Europe/Moscow", () =>
      boxLabelFields({ ...base, egaisCode: null, shelfLifeDays: null }),
    );
    expect(fields["product.egais"]).toBe("");
    expect(fields.expiry).toBe("");
  });

  it("prints an empty date rather than throwing on a malformed closedAt", () => {
    const fields = withTimeZone("Europe/Moscow", () =>
      boxLabelFields({ ...base, closedAt: "garbage", egaisCode: null, shelfLifeDays: 184 }),
    );
    expect(fields.date).toBe("");
    expect(fields.expiry).toBe("");
  });

  it("prints blank dates instead of hiding a malformed explicit production date", () => {
    const fields = withTimeZone("Europe/Moscow", () =>
      boxLabelFields({
        ...base,
        productionDate: "2025-02-30",
        egaisCode: null,
        shelfLifeDays: 184,
      }),
    );
    expect(fields.date).toBe("");
    expect(fields.expiry).toBe("");
  });

  it("prints blank dates for year zero instead of emitting a Postgres-incompatible day", () => {
    const fields = withTimeZone("Europe/Moscow", () =>
      boxLabelFields({
        ...base,
        productionDate: "0000-01-01",
        egaisCode: null,
        shelfLifeDays: 184,
      }),
    );
    expect(fields.date).toBe("");
    expect(fields.expiry).toBe("");
  });
});
