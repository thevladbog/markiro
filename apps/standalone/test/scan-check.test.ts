import { describe, expect, it } from "vitest";

import { checkScan } from "../src/app/scan-check.js";

const FINGERPRINT = "ab".repeat(32);
const PAYLOAD = `markiro-host:1?h=172.20.0.1,192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`;
/** `PAYLOAD` typed by a keyboard-wedge scanner while the Russian layout is on. */
const PAYLOAD_IN_RUSSIAN =
  "ьфклшкщ-рщыеЖ1,р=172ю20ю0ю1б192ю168ю1ю10?з=45710?а=" + "фи".repeat(32) + "?с=7Л3ЬЙ9ЧМ2В";

describe("checkScan", () => {
  it("reads the office's pairing code with the host's addresses", () => {
    expect(checkScan(PAYLOAD)).toEqual({
      kind: "pairing",
      addresses: ["172.20.0.1", "192.168.1.10"],
      russianLayout: false,
    });
  });

  it("reads the pairing code a wedge scanner typed under the Russian layout, and says so", () => {
    expect(checkScan(PAYLOAD_IN_RUSSIAN)).toEqual({
      kind: "pairing",
      addresses: ["172.20.0.1", "192.168.1.10"],
      russianLayout: true,
    });
  });

  it("calls a scan with a replacement character unreadable (a COM port at the wrong speed)", () => {
    expect(checkScan("��x�")).toEqual({ kind: "unreadable" });
  });

  it("tells any other code by its length and its group separator only, never its text", () => {
    expect(checkScan("0104600682000013\u001d21abc")).toEqual({
      kind: "other",
      length: 22,
      groupSeparator: true,
      russianLayout: false,
    });
    expect(checkScan("4600682000013")).toEqual({
      kind: "other",
      length: 13,
      groupSeparator: false,
      russianLayout: false,
    });
  });

  it("counts characters, not UTF-16 units, and notices the Russian layout in another code", () => {
    expect(checkScan("ыыы😀")).toEqual({
      kind: "other",
      length: 4,
      groupSeparator: false,
      russianLayout: true,
    });
  });
});
