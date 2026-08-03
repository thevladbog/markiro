import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { BoundedConcurrencyLimiter } from "./bounded-concurrency";

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 25_000_000;
const WORKER_TIMEOUT_MS = 5_000;
const MAX_CONCURRENCY = 2;
const MAX_QUEUE_DEPTH = 8;
const sharpPath = createRequire(__filename).resolve("sharp");
const workerLimiter = new BoundedConcurrencyLimiter(MAX_CONCURRENCY, MAX_QUEUE_DEPTH);

export interface ProcessedAvatar {
  buffer: Buffer;
  contentType: "image/webp";
  byteSize: number;
  checksum: string;
  width: 512;
  height: 512;
}

export async function processAvatar(input: Buffer): Promise<ProcessedAvatar> {
  if (input.byteLength > MAX_SOURCE_BYTES) throw new Error("Avatar source exceeds 5 MiB");
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    // Metadata inspection reads headers only; the explicit checks below run
    // before the bounded worker performs any pixel allocation.
    metadata = await sharp(input, { limitInputPixels: false, animated: true }).metadata();
  } catch {
    throw new Error("Avatar must contain valid JPEG, PNG, or WebP content");
  }
  if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) {
    throw new Error("Avatar must contain valid JPEG, PNG, or WebP content");
  }
  if ((metadata.pages ?? 1) !== 1) throw new Error("Animated avatars are not supported");
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 1 || height < 1) throw new Error("Avatar dimensions are invalid");
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error("Avatar dimensions must not exceed 8192 pixels");
  }
  if (width * height > MAX_PIXELS) throw new Error("Avatar exceeds 25 million pixels");

  const buffer = await workerLimiter.run(() => normalizeInWorker(input));
  return {
    buffer,
    contentType: "image/webp",
    byteSize: buffer.byteLength,
    checksum: createHash("sha256").update(buffer).digest("hex"),
    width: 512,
    height: 512,
  };
}

async function normalizeInWorker(input: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { input, sharpPath, maxPixels: MAX_PIXELS },
      // This caps only the worker's V8 heap. Sharp/libvips allocates native
      // decode memory, which is bounded by processAvatar's dimensions/pixels.
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Avatar processing exceeded 5 seconds"));
    }, WORKER_TIMEOUT_MS);
    worker.once("message", (message: { ok: boolean; buffer?: Uint8Array; error?: string }) => {
      clearTimeout(timeout);
      worker.removeAllListeners("exit");
      void worker.terminate();
      if (message.ok && message.buffer) resolve(Buffer.from(message.buffer));
      else reject(new Error(message.error ?? "Avatar processing failed"));
    });
    worker.once("error", (error) => {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : "unknown worker error";
      reject(new Error(`Avatar worker failed: ${message}`));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error("Avatar worker exited before completing"));
      }
    });
  });
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const sharp = require(workerData.sharpPath);
(async () => {
  try {
    const { data } = await sharp(Buffer.from(workerData.input), {
      limitInputPixels: workerData.maxPixels,
      pages: 1,
      failOn: "error",
    })
      .rotate()
      .resize(512, 512, { fit: "cover", position: "attention" })
      .webp({ quality: 85, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    parentPort.postMessage({ ok: true, buffer: data });
  } catch (error) {
    console.error(
      "avatar normalization failed",
      error instanceof Error ? error.message : String(error),
    );
    parentPort.postMessage({ ok: false, error: "Avatar normalization failed" });
  }
})();
`;
