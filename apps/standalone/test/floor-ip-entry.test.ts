import { describe, expect, it } from "vitest";

import {
  addressInvalid,
  appendKey,
  checkAddress,
  checkBaud,
  checkPort,
  eraseKey,
  hasDotKey,
  isIpv4Shaped,
  normalizePaste,
  pasteInto,
} from "../src/floor/kit/ip-entry.js";

/** The IpKeypad's rules: the keys, the live check of an address, a port and a baud rate, and a paste. */
describe("the keypad's keys", () => {
  it("types an address from digits and dots, one octet of at most three digits", () => {
    let value = "";
    for (const key of "192.168.1.5") value = appendKey(value, key, "host");
    expect(value).toBe("192.168.1.5");
    expect(appendKey("192", "5", "host")).toBe("192");
    expect(appendKey("192", ".", "host")).toBe("192.");
  });

  it("refuses a leading dot, a doubled dot and a fourth dot", () => {
    expect(appendKey("", ".", "host")).toBe("");
    expect(appendKey("192.", ".", "host")).toBe("192.");
    expect(appendKey("1.2.3.", ".", "host")).toBe("1.2.3.");
    expect(appendKey("1.2.3.4", ".", "host")).toBe("1.2.3.4");
  });

  it("stops an address at the longest IPv4 text", () => {
    expect(appendKey("255.255.255.255", "1", "host")).toBe("255.255.255.255");
  });

  it("types a port and a baud rate from digits only, up to their length", () => {
    expect(appendKey("9100", ".", "port")).toBe("9100");
    expect(appendKey("9100", "x", "port")).toBe("9100");
    expect(appendKey("9100", "1", "port")).toBe("91001");
    expect(appendKey("91001", "1", "port")).toBe("91001");
    expect(appendKey("1152", "0", "baud")).toBe("11520");
    expect(appendKey("1152", ".", "baud")).toBe("1152");
    expect(appendKey("1234567890", "1", "baud")).toBe("1234567890");
  });

  it("erases the last character, and offers a dot only for the address", () => {
    expect(eraseKey("192.")).toBe("192");
    expect(eraseKey("")).toBe("");
    expect(hasDotKey("host")).toBe(true);
    expect(hasDotKey("port")).toBe(false);
    expect(hasDotKey("baud")).toBe(false);
  });
});

describe("the live check of an address", () => {
  it("passes an empty field as empty and a host name as a name", () => {
    expect(checkAddress("")).toEqual({ state: "empty" });
    expect(checkAddress("  ")).toEqual({ state: "empty" });
    expect(checkAddress("printer-1.local")).toEqual({ state: "name" });
    expect(checkAddress("zebra")).toEqual({ state: "name" });
  });

  it("accepts four octets of 0 to 255", () => {
    expect(checkAddress("192.168.1.255")).toEqual({ state: "ok" });
    expect(checkAddress("0.0.0.0")).toEqual({ state: "ok" });
  });

  it("names the octet above 255, wherever it is", () => {
    expect(checkAddress("192.168.1.256")).toEqual({ state: "octet", octet: "256" });
    expect(checkAddress("999.1")).toEqual({ state: "octet", octet: "999" });
  });

  it("calls an IPv4-shaped text of fewer than four numbers unfinished, and a malformed one a format error", () => {
    expect(checkAddress("192.168.1")).toEqual({ state: "incomplete" });
    expect(checkAddress("192.168.1.")).toEqual({ state: "incomplete" });
    expect(checkAddress("1.2.3.4.5")).toEqual({ state: "format" });
    expect(checkAddress("1..2.3")).toEqual({ state: "format" });
    expect(checkAddress(".1.2.3")).toEqual({ state: "format" });
  });

  it("marks as invalid once applied everything IPv4-shaped that is not an address, but never a name", () => {
    expect(addressInvalid("192.168.1")).toBe(true);
    expect(addressInvalid("192.168.1.256")).toBe(true);
    expect(addressInvalid("192.168.1.1")).toBe(false);
    expect(addressInvalid("zebra")).toBe(false);
    expect(addressInvalid("")).toBe(false);
    expect(isIpv4Shaped("1.2")).toBe(true);
    expect(isIpv4Shaped("a.1")).toBe(false);
    expect(isIpv4Shaped(".")).toBe(false);
  });
});

describe("the live check of a port and a baud rate", () => {
  it("takes a port from 1 to 65 535", () => {
    expect(checkPort("")).toEqual({ state: "empty" });
    expect(checkPort("9100")).toEqual({ state: "ok" });
    expect(checkPort("1")).toEqual({ state: "ok" });
    expect(checkPort("65535")).toEqual({ state: "ok" });
    expect(checkPort("0")).toEqual({ state: "range" });
    expect(checkPort("65536")).toEqual({ state: "range" });
    expect(checkPort("9100x")).toEqual({ state: "range" });
    expect(checkPort("-1")).toEqual({ state: "range" });
  });

  it("takes a baud rate from 1 to 4 294 967 295", () => {
    expect(checkBaud("9600")).toEqual({ state: "ok" });
    expect(checkBaud("4294967295")).toEqual({ state: "ok" });
    expect(checkBaud("4294967296")).toEqual({ state: "range" });
    expect(checkBaud("0")).toEqual({ state: "range" });
    expect(checkBaud("")).toEqual({ state: "empty" });
  });
});

describe("a paste", () => {
  it("drops every kind of space and nothing else", () => {
    expect(normalizePaste(" 192.168.1.50\n")).toBe("192.168.1.50");
    expect(normalizePaste("9 100")).toBe("9100");
    expect(normalizePaste("9 100")).toBe("9100");
    expect(normalizePaste("19​2.168")).toBe("192.168");
    expect(normalizePaste("192,168.1.5")).toBe("192,168.1.5");
  });

  it("goes in place of the selection", () => {
    expect(pasteInto("192.168", 3, 3, " .5 ")).toBe("192.5.168");
    expect(pasteInto("192.168.1.1", 0, 11, "10.0.0.7 ")).toBe("10.0.0.7");
    expect(pasteInto("abc", 99, 99, "d")).toBe("abcd");
    expect(pasteInto("abc", 2, 0, "-")).toBe("-c");
  });

  it("still goes through the live check", () => {
    expect(checkAddress(normalizePaste(" 192.168.1.256 "))).toEqual({ state: "octet", octet: "256" });
  });
});
