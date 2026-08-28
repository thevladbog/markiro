import { describe, expect, it } from "vitest";
import {
  createUtf8ByteComparator,
  encodeLfText,
  encodeSemicolonCsv,
} from "../src/document-text-encoding.js";

const decoder = new TextDecoder();

describe("document text encoding", () => {
  it("encodes LF-delimited UTF-8 text with one final newline only when non-empty", () => {
    expect([...encodeLfText([])]).toEqual([]);
    expect(decoder.decode(encodeLfText(["A\u001dB"]))).toBe("A\u001dB\n");
  });

  it("encodes semicolon CSV with a BOM, CRLF, and escaped fields", () => {
    const csv = encodeSemicolonCsv(["box_sscc", "code"], [["00...", '01A;B"C']]);

    expect([...csv.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decoder.decode(csv.slice(3))).toBe('box_sscc;code\r\n00...;"01A;B""C"\r\n');
  });

  it("compares text by canonical UTF-8 bytes across BMP and supplementary characters", () => {
    const compare = createUtf8ByteComparator((value: string) => value);

    expect(compare("\uE000", "\u{10000}")).toBe(-1);
    expect(compare("\u{10000}", "\uE000")).toBe(1);
    expect(compare("same", "same")).toBe(0);
  });
});
