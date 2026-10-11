import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostApi } from "../src/host/api.js";
import type { HostClient } from "../src/host/client.js";
import {
  MAX_CLOUD_EXPORT_BYTES,
  canonicalJson,
  cloudImportPayloadSchema,
  cloudImportRequest,
  cloudImportSummarySchema,
  fileChecksum,
  readCloudExportBlob,
  readCloudExportFile,
  type CloudExportFile,
} from "../src/host/cloud-import.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixtureText(name: string): string {
  return readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8");
}

const GOLDEN = fixtureText("cloud-export-file.json");
const IMPORT_ID = "8f14e45f-ceea-467a-9d9b-1c7e0b1a2d3e";

async function golden(): Promise<CloudExportFile> {
  const read = await readCloudExportFile(GOLDEN);
  if (read.kind !== "ok") throw new Error(`the golden file reads as ${read.problem}`);
  return read.file;
}

/** The golden file with `change` applied to its parsed value, written back. */
function changed(change: (file: Record<string, unknown>) => void): string {
  const file = JSON.parse(GOLDEN) as Record<string, unknown>;
  change(file);
  return JSON.stringify(file);
}

describe("the cloud export file", () => {
  it("reads the tool's golden file and checks its checksum", async () => {
    const file = await golden();
    expect(file.payload.operators).toHaveLength(3);
    expect(file.cutover.ssccCounters[0]).toEqual({
      issuerPrefix: "460068200",
      extension: 0,
      owner: { kind: "organization" },
      issuedMax: 21003,
      printedMax: 21003,
      standaloneStart: 30000,
      cloudReseedTo: 1030000,
    });
    expect(await fileChecksum(JSON.parse(GOLDEN) as Record<string, unknown>)).toBe(file.checksum);
  });

  it("computes the tool's canonical JSON", () => {
    expect(canonicalJson({ b: [1, { d: null, c: "я" }], a: true })).toBe(
      '{"a":true,"b":[1,{"c":"я","d":null}]}',
    );
  });

  it("ignores whitespace and key order on disk", async () => {
    const parsed = JSON.parse(GOLDEN) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    const read = await readCloudExportFile(JSON.stringify(reordered));
    expect(read.kind).toBe("ok");
  });

  it("refuses a file that changed after the tool wrote it", async () => {
    const edited = changed((file) => {
      const payload = file.payload as { products: { boxCapacity: number }[] };
      payload.products[0]!.boxCapacity = 24;
    });
    expect(await readCloudExportFile(edited)).toEqual({ kind: "problem", problem: "checksum" });
    const truncated = GOLDEN.slice(0, GOLDEN.length / 2);
    expect(await readCloudExportFile(truncated)).toEqual({ kind: "problem", problem: "json" });
  });

  it("refuses another format or version before its checksum", async () => {
    expect(await readCloudExportFile("[]")).toEqual({ kind: "problem", problem: "format" });
    expect(await readCloudExportFile(changed((file) => (file.format = "other")))).toEqual({
      kind: "problem",
      problem: "format",
    });
    expect(await readCloudExportFile(changed((file) => (file.formatVersion = 2)))).toEqual({
      kind: "problem",
      problem: "version",
    });
  });

  it("refuses a file whose checksum matches but whose shape does not", async () => {
    const unknownField = JSON.parse(GOLDEN) as Record<string, unknown>;
    const payload = unknownField.payload as { products: Record<string, unknown>[] };
    payload.products[0]!.unitPrice = "89.90";
    unknownField.checksum = await fileChecksum(unknownField);
    expect(await readCloudExportFile(JSON.stringify(unknownField))).toEqual({
      kind: "problem",
      problem: "format",
      path: "payload.products.0",
    });
  });

  it("builds the request the host's tests send, every field named", async () => {
    const file = await golden();
    const parsed = JSON.parse(GOLDEN) as Record<string, unknown>;
    expect(cloudImportRequest(file, IMPORT_ID, false)).toEqual({
      importId: IMPORT_ID,
      dryRun: false,
      formatVersion: parsed.formatVersion,
      exportedAt: parsed.exportedAt,
      rehearsal: parsed.rehearsal,
      source: parsed.source,
      payload: parsed.payload,
    });
    expect(cloudImportRequest(file, IMPORT_ID, true).dryRun).toBe(true);
  });

  it("reads the host's summary, tolerating fields a newer host adds", () => {
    const summary = JSON.parse(fixtureText("cloud-import-summary.json")) as Record<string, unknown>;
    expect(cloudImportSummarySchema.parse(summary)).toEqual(summary);
    expect(cloudImportSummarySchema.parse({ ...summary, warnings: [] })).toEqual(summary);
  });

  it("posts the request to the import route with the office token", async () => {
    const sent: unknown[] = [];
    const client: HostClient = {
      request: async (method, path, options) => {
        sent.push({ method, path, body: options.body, officeToken: options.officeToken });
        return options.schema.parse(JSON.parse(fixtureText("cloud-import-summary.json")));
      },
    };
    const request = cloudImportRequest(await golden(), IMPORT_ID, true);
    const answer = await createHostApi(client).importFromCloud("office-session-token", request);
    expect(answer.products).toBe(3);
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/office/import",
        body: request,
        officeToken: "office-session-token",
      },
    ]);
  });
});

// --- Beyond the brief: the credentials, the shape table, the size cap, parity with the tool ---

const TOOL_CANONICAL = new URL("../../../tools/standalone-export/canonical.mjs", testModuleUrl)
  .href;

interface ToolCanonical {
  canonicalJson: (value: unknown) => string;
  fileChecksum: (file: Record<string, unknown>) => string;
}

async function tool(): Promise<ToolCanonical> {
  return (await import(/* @vite-ignore */ TOOL_CANONICAL)) as ToolCanonical;
}

/** The golden file with `change` applied, its checksum recomputed: only the shape is wrong. */
async function resealed(change: (file: Record<string, unknown>) => void): Promise<string> {
  const file = JSON.parse(GOLDEN) as Record<string, unknown>;
  change(file);
  file.checksum = await fileChecksum(file);
  return JSON.stringify(file);
}

function at(file: Record<string, unknown>, path: string): Record<string, unknown> {
  let node: unknown = file;
  for (const part of path.split(".")) node = (node as Record<string, unknown>)[part];
  return node as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the checksum is the tool's, byte for byte", () => {
  it("is the golden file's own checksum, sha256:9716b9df...45c5", async () => {
    const parsed = JSON.parse(GOLDEN) as Record<string, unknown>;
    expect(parsed.checksum).toMatch(/^sha256:9716b9df[0-9a-f]{52}45c5$/);
    expect(await fileChecksum(parsed)).toBe(parsed.checksum);
  });

  it("agrees with canonical.mjs on the golden file and on awkward values", async () => {
    const { canonicalJson: toolJson, fileChecksum: toolChecksum } = await tool();
    const parsed = JSON.parse(GOLDEN) as Record<string, unknown>;
    expect(await fileChecksum(parsed)).toBe(toolChecksum(parsed));
    const awkward = {
      z: [1.5, -0, 1e21, 1e-7, 0.1 + 0.2, Number.MAX_SAFE_INTEGER],
      я: 'ёж \u001d \u2028 \ud83d\ude00 " \\ \n',
      a: { "": null, "10": 1, "2": 2, B: false, b: true },
      list: [[], {}, [[]], [{}]],
    };
    expect(canonicalJson(awkward)).toBe(toolJson(awkward));
    expect(await fileChecksum({ ...awkward, checksum: "ignored" })).toBe(
      toolChecksum({ ...awkward, checksum: "other" }),
    );
  });

  it("refuses the golden file when any single character of a value differs", async () => {
    const edits: [string, string][] = [
      ['"gln": "4600682000010"', '"gln": "4600682000011"'],
      ['"tenantName": "ООО «Атолл»"', '"tenantName": "ООО «Атолл»."'],
      ['"rehearsal": false', '"rehearsal": true'],
      ['"nextSerial": 30000', '"nextSerial": 30001'],
    ];
    for (const [from, to] of edits) {
      expect(GOLDEN.split(from).length - 1).toBeGreaterThanOrEqual(1);
      const read = await readCloudExportFile(GOLDEN.replace(from, to));
      expect(read).toEqual({ kind: "problem", problem: "checksum" });
    }
    const checksum = (JSON.parse(GOLDEN) as { checksum: string }).checksum;
    const flipped = checksum.slice(0, -1) + (checksum.endsWith("0") ? "1" : "0");
    expect(await readCloudExportFile(GOLDEN.replace(checksum, flipped))).toEqual({
      kind: "problem",
      problem: "checksum",
    });
  });

  it("leaves the checksum field out of what it hashes", async () => {
    const parsed = JSON.parse(GOLDEN) as Record<string, unknown>;
    const withOther = { ...parsed, checksum: "sha256:" + "0".repeat(64) };
    expect(await fileChecksum(withOther)).toBe(parsed.checksum);
  });
});

describe("the schema is the host's request, strict at every level", () => {
  it("has every key of the golden payload required and no other allowed", () => {
    const payload = JSON.parse(GOLDEN).payload as Record<string, unknown>;
    expect(cloudImportPayloadSchema.safeParse(payload).success).toBe(true);
    let walked = 0;
    const walk = (node: unknown, path: string[]): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, [...path, String(index)]));
        return;
      }
      if (node === null || typeof node !== "object") return;
      // A template's layout is opaque on purpose (`templateSpecSchema`).
      if (path[path.length - 1] === "spec") return;
      for (const key of Object.keys(node)) {
        const copy = structuredClone(payload);
        const holder = path.length === 0 ? copy : at(copy as never, path.join("."));
        // Some nullable fields may be absent for the host (serde `Option`); the
        // webview's schema is stricter by design, so it must refuse the gap.
        delete holder[key];
        expect(
          cloudImportPayloadSchema.safeParse(copy).success,
          `without ${[...path, key].join(".")}`,
        ).toBe(false);
        const extra = structuredClone(payload);
        (path.length === 0 ? extra : at(extra as never, path.join(".")))["unexpected"] = 1;
        expect(cloudImportPayloadSchema.safeParse(extra).success, `plus ${path.join(".")}`).toBe(
          false,
        );
        walked += 1;
        walk((node as Record<string, unknown>)[key], [...path, key]);
      }
    };
    walk(payload, []);
    expect(walked).toBeGreaterThan(80);
  });

  it("refuses each wrong field by its path, whatever it holds", async () => {
    const cases: [string, (file: Record<string, unknown>) => void, string][] = [
      ["exportedAt", (f) => (f.exportedAt = "yesterday"), "exportedAt"],
      ["rehearsal", (f) => (f.rehearsal = "no"), "rehearsal"],
      ["tool", (f) => (f.tool = 1), "tool"],
      ["source", (f) => (at(f, "source").tenantId = 5), "source.tenantId"],
      ["cutover window", (f) => (at(f, "cutover").boxWindow = 0), "cutover.boxWindow"],
      [
        "cutover owner",
        (f) => (at(f, "cutover.ssccCounters.0").owner = { kind: "robot" }),
        "cutover.ssccCounters.0.owner",
      ],
      [
        "cutover cloudReseedTo",
        (f) => (at(f, "cutover.ssccCounters.0").cloudReseedTo = -1),
        "cutover.ssccCounters.0.cloudReseedTo",
      ],
      ["note without a code", (f) => ((f.notes as unknown[])[0] = { code: "" }), "notes.0.code"],
      ["line id", (f) => (at(f, "payload.lines.0").id = "not-a-uuid"), "payload.lines.0.id"],
      [
        "product count",
        (f) => (at(f, "payload.products.0").boxCapacity = -1),
        "payload.products.0.boxCapacity",
      ],
      [
        "product group",
        (f) => (at(f, "payload.products.0").chzProductGroupCode = 1.5),
        "payload.products.0.chzProductGroupCode",
      ],
      [
        "template purpose",
        (f) => (at(f, "payload.templates.0").purpose = "other"),
        "payload.templates.0.purpose",
      ],
      [
        "template spec",
        (f) => (at(f, "payload.templates.0").spec = [1]),
        "payload.templates.0.spec",
      ],
      [
        "category purpose",
        (f) => (at(f, "payload.templateDefaults.categories.0").purpose = "x"),
        "payload.templateDefaults.categories.0.purpose",
      ],
      [
        "sscc extension",
        (f) => (at(f, "payload.ssccCounters.0").extension = 2),
        "payload.ssccCounters.0.extension",
      ],
      [
        "shift counter",
        (f) => (at(f, "payload.shiftNumberCounters.0").lastSeq = 0),
        "payload.shiftNumberCounters.0.lastSeq",
      ],
      ["badge salt", (f) => (at(f, "payload").badgeSalt = "AAAA"), "payload.badgeSalt"],
      [
        "pin hash",
        (f) => (at(f, "payload.operators.0").pinPhc = "pbkdf2$sha256$1$x$y"),
        "payload.operators.0.pinPhc",
      ],
      [
        "badge hash",
        (f) => (at(f, "payload.badges.0").badgePhc = "not a hash"),
        "payload.badges.0.badgePhc",
      ],
    ];
    for (const [name, change, path] of cases) {
      const read = await readCloudExportFile(await resealed(change));
      expect(read, name).toEqual({ kind: "problem", problem: "format", path });
    }
  });

  it("refuses a field the file's top level does not know, naming no path", async () => {
    const read = await readCloudExportFile(await resealed((f) => (f.extra = 1)));
    expect(read).toEqual({ kind: "problem", problem: "format" });
  });

  it("checks the checksum before the shape: a damaged file is damaged, not malformed", async () => {
    const damaged = changed((f) => (at(f, "payload.products.0").unitPrice = "89.90"));
    expect(await readCloudExportFile(damaged)).toEqual({ kind: "problem", problem: "checksum" });
  });

  it("keeps a note it does not know, whatever fields it has", async () => {
    const text = await resealed((f) => {
      (f.notes as unknown[]).push({ code: "from_a_newer_tool", detail: { n: 1 } });
    });
    const read = await readCloudExportFile(text);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok")
      expect(read.file.notes.at(-1)).toEqual({ code: "from_a_newer_tool", detail: { n: 1 } });
  });
});

describe("the credentials of the file are never quoted", () => {
  it("names the field of a refused shape and not the verifier a wrong field holds", async () => {
    const parsed = JSON.parse(GOLDEN) as {
      payload: {
        operators: { pinPhc: string }[];
        badges: { badgePhc: string }[];
        badgeSalt: string;
      };
    };
    const verifiers = [
      parsed.payload.operators[0]!.pinPhc,
      parsed.payload.badges[0]!.badgePhc,
      parsed.payload.badgeSalt,
    ];
    const text = await resealed((f) => {
      at(f, "payload.products.0").boxCapacity = verifiers[0];
      at(f, "payload.products.0")[verifiers[1]!] = verifiers[2];
    });
    const read = await readCloudExportFile(text);
    expect(read.kind).toBe("problem");
    const shown = JSON.stringify(read);
    for (const verifier of verifiers) expect(shown).not.toContain(verifier);
    expect(read).toEqual({
      kind: "problem",
      problem: "format",
      path: "payload.products.0.boxCapacity",
    });
    // A refused hash is reported by its field as well, and not quoted.
    const wrong = verifiers[0]!.replace("$100000$", "$20000$");
    expect(wrong).not.toBe(verifiers[0]);
    const wrongHash = await readCloudExportFile(
      await resealed((f) => (at(f, "payload.badges.1").badgePhc = wrong)),
    );
    expect(wrongHash).toEqual({
      kind: "problem",
      problem: "format",
      path: "payload.badges.1.badgePhc",
    });
    expect(JSON.stringify(wrongHash)).not.toContain(wrong);
  });

  it("writes nothing to the console, whether it accepts or refuses", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    await readCloudExportFile(GOLDEN);
    await readCloudExportFile(GOLDEN.slice(0, 200));
    await readCloudExportFile(await resealed((f) => (at(f, "payload.products.0").x = 1)));
    await readCloudExportFile(GOLDEN.replace('"rehearsal": false', '"rehearsal": true'));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("does not repeat the text of a file that is not JSON", async () => {
    const secret = "pbkdf2$sha256$600000$c2VjcmV0$ZGlnZXN0";
    const read = await readCloudExportFile(`{"pinPhc": "${secret}", `);
    expect(read).toEqual({ kind: "problem", problem: "json" });
    expect(JSON.stringify(read)).not.toContain(secret);
  });
});

describe("a file past the cap is refused before it is read", () => {
  it("refuses text longer than the host takes", async () => {
    const big = " ".repeat(MAX_CLOUD_EXPORT_BYTES + 1);
    expect(await readCloudExportFile(big)).toEqual({ kind: "problem", problem: "format" });
  });

  it("takes text exactly at the cap into the checks", async () => {
    const padded = GOLDEN + " ".repeat(MAX_CLOUD_EXPORT_BYTES - GOLDEN.length);
    expect((await readCloudExportFile(padded)).kind).toBe("ok");
  });

  it("looks at the size of a chosen file and never reads one past the cap", async () => {
    const text = vi.fn(async () => GOLDEN);
    const tooBig = { size: MAX_CLOUD_EXPORT_BYTES + 1, text } as unknown as Blob;
    expect(await readCloudExportBlob(tooBig)).toEqual({ kind: "problem", problem: "format" });
    expect(text).not.toHaveBeenCalled();
    const atCap = { size: MAX_CLOUD_EXPORT_BYTES, text } as unknown as Blob;
    expect((await readCloudExportBlob(atCap)).kind).toBe("ok");
    expect(text).toHaveBeenCalledTimes(1);
  });

  it("reads a real file object", async () => {
    const read = await readCloudExportBlob(new File([GOLDEN], "markiro-cloud-export.json"));
    expect(read.kind).toBe("ok");
  });

  it("caps at the host's body limit of 32 MiB", () => {
    expect(MAX_CLOUD_EXPORT_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe("the request", () => {
  it("carries the importId and dry-run flag it is given, and no other field", async () => {
    const file = await golden();
    const another = "0b8e1d52-6a1c-4d0e-9c47-52a4f8e7b9a1";
    const request = cloudImportRequest(file, another, true);
    expect(request.importId).toBe(another);
    expect(request.dryRun).toBe(true);
    expect(Object.keys(request).sort()).toEqual(
      [
        "dryRun",
        "exportedAt",
        "formatVersion",
        "importId",
        "payload",
        "rehearsal",
        "source",
      ].sort(),
    );
    // The file's own checksum, tool name, cut-over table and notes stay in the office.
    expect(JSON.stringify(request)).not.toContain(file.checksum);
    expect(Object.keys(request.source).sort()).toEqual(["tenantId", "tenantName"]);
  });

  it("is not a stand-in for the host's summary: a missing field is refused", () => {
    const summary = JSON.parse(fixtureText("cloud-import-summary.json")) as Record<string, unknown>;
    for (const key of Object.keys(summary)) {
      const rest = Object.fromEntries(Object.entries(summary).filter(([name]) => name !== key));
      expect(cloudImportSummarySchema.safeParse(rest).success, key).toBe(false);
    }
  });
});
