import { Readable } from "node:stream";
import multer from "multer";
import { describe, expect, it } from "vitest";

import { AGREEMENT_ATTACHMENT_UPLOAD_OPTIONS } from "../src/modules/platform-agreements/platform-agreements.controller";

/**
 * Runs a raw multipart body through the same multer options the attachment
 * route uses. A browser sends the file name as raw UTF-8 bytes; busboy reads
 * unmarked parameters as latin1 unless told otherwise, so a Cyrillic name used
 * to be stored as mojibake.
 */
async function parseUpload(filename: string): Promise<string> {
  const boundary = "----markiro-test-boundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="`, "utf8"),
    Buffer.from(filename, "utf8"),
    Buffer.from(`"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  const req = Object.assign(Readable.from([body]), {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
  }) as unknown as Record<string, unknown>;
  const middleware = multer(AGREEMENT_ATTACHMENT_UPLOAD_OPTIONS).single("file");
  return await new Promise<string>((resolve, reject) => {
    (middleware as unknown as (...args: unknown[]) => void)(req, {}, (error?: unknown) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve((req as { file?: { originalname: string } }).file?.originalname ?? "");
    });
  });
}

describe("agreement attachment upload file name", () => {
  it("keeps a Cyrillic file name intact", async () => {
    await expect(parseUpload("Договор_MRK_LLC_2026_001.pdf")).resolves.toBe(
      "Договор_MRK_LLC_2026_001.pdf",
    );
  });

  it("keeps an ASCII file name intact", async () => {
    await expect(parseUpload("signed copy.pdf")).resolves.toBe("signed copy.pdf");
  });
});
