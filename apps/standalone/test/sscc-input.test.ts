import { describe, expect, it } from "vitest";

import {
  inParts,
  lineInputs,
  MAX_IMPORT_BYTES,
  parsePastedSsccs,
  parseSsccImport,
  readSsccImport,
} from "../src/office/disaggregation/sscc-input.js";

describe("a file's SSCCs (the cloud API's parseSsccImport)", () => {
  it("splits on newlines, semicolons and commas; trims; drops empties", () => {
    expect(parseSsccImport("123;456\n789,abc\r\n\n  042  \n")).toEqual({
      ok: true,
      tokens: ["123", "456", "789", "abc", "042"],
    });
  });

  it("keeps duplicates: the document shows them as duplicate lines", () => {
    expect(parseSsccImport("1\n1")).toEqual({ ok: true, tokens: ["1", "1"] });
  });

  it("refuses over 10 000 tokens and an empty file", () => {
    expect(parseSsccImport(Array(10_001).fill("1").join("\n"))).toEqual({
      ok: false,
      refusal: "too_many_lines",
    });
    expect(parseSsccImport(Array(10_000).fill("1").join("\n")).ok).toBe(true);
    expect(parseSsccImport(" ;\n,")).toEqual({ ok: false, refusal: "file_empty" });
  });

  it("keeps a space inside a token, as the cloud does (it is then not found)", () => {
    expect(parseSsccImport("1460 0703")).toEqual({ ok: true, tokens: ["1460 0703"] });
  });
});

describe("pasted SSCCs (the cloud page's splitSsccInput)", () => {
  it("splits on any whitespace, semicolons and commas", () => {
    expect(parsePastedSsccs(" (00)046007034967000017 \t046007034967000024;\n,x ")).toEqual([
      "(00)046007034967000017",
      "046007034967000024",
      "x",
    ]);
  });

  it("finds nothing in blanks", () => {
    expect(parsePastedSsccs(" \n\t ; , ")).toEqual([]);
  });
});

describe("reading a picked file", () => {
  it("drops the BOM Excel writes, unlike the cloud", async () => {
    const file = { size: 22, text: async () => "\uFEFF046007034967000017;\n" };
    expect(await readSsccImport(file)).toEqual({ ok: true, tokens: ["046007034967000017"] });
    const real = new File(["\uFEFF046007034967000017\n"], "list.csv");
    expect(await readSsccImport(real)).toEqual({ ok: true, tokens: ["046007034967000017"] });
  });

  it("does not read a file over 1 MiB", async () => {
    const text = async () => {
      throw new Error("must not be read");
    };
    expect(await readSsccImport({ size: MAX_IMPORT_BYTES + 1, text })).toEqual({
      ok: false,
      refusal: "file_too_large",
    });
  });
});

describe("the wire's lines", () => {
  it("carry the input as typed and the SSCC the domain reads", () => {
    expect(lineInputs(["(00)046006820000015000", "046006820000015017", "MRK-000742"])).toEqual([
      { input: "(00)046006820000015000", sscc: "046006820000015000" },
      { input: "046006820000015017", sscc: "046006820000015017" },
      { input: "MRK-000742", sscc: null },
    ]);
  });

  it("read no SSCC in a number whose check digit is wrong", () => {
    expect(lineInputs(["046006820000015001"])).toEqual([
      { input: "046006820000015001", sscc: null },
    ]);
  });

  it("go to the host in parts of at most 500, in order", () => {
    const lines = Array.from({ length: 1001 }, (_, n) => n);
    const parts = inParts(lines);
    expect(parts.map((part) => part.length)).toEqual([500, 500, 1]);
    expect(parts.flat()).toEqual(lines);
    expect(inParts([])).toEqual([]);
  });
});
