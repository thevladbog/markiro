import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  fromRussianLayout,
  normalizePairingCode,
  parsePairingPayload,
} from "../src/host/pairing-code.js";
import { pairingCodeSchema } from "../src/host/protocol.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const CASES = z
  .object({
    cases: z.array(z.object({ input: z.string(), normalized: z.string().nullable() }).strict()),
  })
  .strict()
  .parse(fixture("pairing-codes.json")).cases;

const FINGERPRINT = "ab".repeat(32);
const PAYLOAD = `markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`;
const PARSED = {
  addresses: ["10.0.0.5", "192.168.1.10"],
  port: 45710,
  fingerprint: FINGERPRINT,
  code: "7K3MQ9XV2D",
};
/** `PAYLOAD` as a keyboard-wedge scanner types it while the Russian layout is on. */
const TYPED_IN_RUSSIAN =
  "ьфклшкщ-рщыеЖ1,р=10ю0ю0ю5б192ю168ю1ю10?з=45710?а=" + "фи".repeat(32) + "?с=7Л3ЬЙ9ЧМ2В";
/** `PAYLOAD` as a scanner types it under the US layout with Caps Lock on. */
const CAPS_LOCK = `MARKIRO-HOST:1?H=10.0.0.5,192.168.1.10&P=45710&F=${"AB".repeat(32)}&C=7k3mq9xv2d`;

/**
 * `TYPED_IN_RUSSIAN` with every Cyrillic letter's case inverted, independent
 * of `fromRussianLayout`/`parsePairingPayload`: this is what the same scan
 * looks like with Caps Lock also on, since Caps Lock inverts the case of
 * every letter key, including ж, ю and б, which sit where `:`/`;`, `.` and
 * `,` do on the US layout.
 */
const CYRILLIC_LETTER = /[а-яё]/i;
function flipCyrillicCase(text: string): string {
  return Array.from(text, (symbol) =>
    CYRILLIC_LETTER.test(symbol)
      ? symbol === symbol.toLowerCase()
        ? symbol.toUpperCase()
        : symbol.toLowerCase()
      : symbol,
  ).join("");
}

describe("pairing code", () => {
  it("normalizes every shared case exactly like markiro_proto::pairing::normalize", () => {
    expect(CASES).toHaveLength(31);
    for (const { input, normalized } of CASES) {
      expect(normalizePairingCode(input), JSON.stringify(input)).toBe(normalized);
    }
  });
});

describe("pairing payload", () => {
  it("reads the payload the host builds (proto/fixtures/pairing-code.json)", () => {
    const { payload } = pairingCodeSchema.parse(fixture("pairing-code.json"));
    expect(parsePairingPayload(payload)).toEqual(PARSED);
  });

  it("reads a payload typed under the Russian layout", () => {
    expect(fromRussianLayout(TYPED_IN_RUSSIAN)).toBe(PAYLOAD);
    expect(parsePairingPayload(TYPED_IN_RUSSIAN)).toEqual(PARSED);
  });

  it("maps the full Russian digit and letter rows to their US positions", () => {
    expect(fromRussianLayout("ё1234567890-=йцукенгшщзхъ\\фывапролджэячсмитьбю.")).toBe(
      "`1234567890-=qwertyuiop[]\\asdfghjkl;'zxcvbnm,./",
    );
    expect(fromRussianLayout('Ё!"№;%:?*()_+ЙЦУКЕНГШЩЗХЪ/ФЫВАПРОЛДЖЭЯЧСМИТЬБЮ,')).toBe(
      '~!@#$%^&*()_+QWERTYUIOP{}|ASDFGHJKL:"ZXCVBNM<>?',
    );
  });

  it("reads a payload typed with Caps Lock on", () => {
    expect(parsePairingPayload(CAPS_LOCK)).toEqual(PARSED);
  });

  it("reads a payload typed under the Russian layout with Caps Lock on", () => {
    expect(parsePairingPayload(flipCyrillicCase(TYPED_IN_RUSSIAN))).toEqual(PARSED);
  });

  it("drops the AIM identifier a scanner may prepend and the spaces around", () => {
    expect(parsePairingPayload(`  ]d1${PAYLOAD} `)).toEqual(PARSED);
    expect(parsePairingPayload(`ъв1${TYPED_IN_RUSSIAN}`)).toEqual(PARSED);
  });

  it("drops an upper-case AIM identifier typed with Caps Lock on", () => {
    expect(parsePairingPayload(`]D1${CAPS_LOCK}`)).toEqual(PARSED);
  });

  it("reports a payload without addresses so the screen can warn", () => {
    expect(parsePairingPayload(PAYLOAD.replace("10.0.0.5,192.168.1.10", ""))).toEqual({
      ...PARSED,
      addresses: [],
    });
  });

  it("normalizes the code the payload carries", () => {
    expect(parsePairingPayload(PAYLOAD.replace("7K3MQ9XV2D", "7k3mq-9xv2d"))).toEqual(PARSED);
  });

  it("accepts an address that is all zeros, unlike one with a leading zero", () => {
    expect(parsePairingPayload(PAYLOAD.replace("10.0.0.5", "0.0.0.0"))).toEqual({
      ...PARSED,
      addresses: ["0.0.0.0", "192.168.1.10"],
    });
  });

  it.each([
    ["another scheme", PAYLOAD.replace("markiro-host:1", "markiro-host:2")],
    ["no query", "markiro-host:1"],
    ["plain text", "4600682000013"],
    ["a field without =", `${PAYLOAD}&x`],
    ["a repeated field", `${PAYLOAD}&c=7K3MQ9XV2D`],
    ["no address field", PAYLOAD.replace("h=10.0.0.5,192.168.1.10&", "")],
    ["a host name instead of an address", PAYLOAD.replace("10.0.0.5", "host-pc")],
    ["an address out of range", PAYLOAD.replace("10.0.0.5", "10.0.0.256")],
    ["an address with a leading zero", PAYLOAD.replace("10.0.0.5", "010.0.0.5")],
    ["port 0", PAYLOAD.replace("p=45710", "p=0")],
    ["port 65536", PAYLOAD.replace("p=45710", "p=65536")],
    ["a short fingerprint", PAYLOAD.replace(FINGERPRINT, "ab".repeat(31))],
    ["a fingerprint that is not hex", PAYLOAD.replace(FINGERPRINT, "zz".repeat(32))],
    ["a code that cannot be a code", PAYLOAD.replace("7K3MQ9XV2D", "7K3MQ9XV2U")],
  ])("refuses %s", (_name, text) => {
    expect(parsePairingPayload(text)).toBeNull();
  });

  it("reads the payload cases of the shared fixture, which the Android app reads too", () => {
    const parsed = z
      .object({
        valid: z.array(
          z.object({
            text: z.string(),
            canonical: z.boolean(),
            parsed: z.object({
              addresses: z.array(z.string()),
              port: z.number(),
              fingerprint: z.string(),
              code: z.string(),
            }),
          }),
        ),
        invalid: z.array(z.string()),
      })
      .strict()
      .parse(fixture("pairing-payloads.json"));
    expect(parsed.valid.length).toBeGreaterThanOrEqual(5);
    for (const { text, parsed: expected } of parsed.valid) {
      expect(parsePairingPayload(text), text).toStrictEqual(expected);
    }
    for (const text of parsed.invalid) {
      expect(parsePairingPayload(text), text).toBeNull();
    }
  });
});
