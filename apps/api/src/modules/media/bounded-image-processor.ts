import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { BoundedConcurrencyLimiter } from "../profile/bounded-concurrency";

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 25_000_000;
const WORKER_TIMEOUT_MS = 5_000;
const MAX_CONCURRENCY = 2;
const MAX_QUEUE_DEPTH = 8;
const sharpPath = createRequire(__filename).resolve("sharp");
const workerLimiter = new BoundedConcurrencyLimiter(MAX_CONCURRENCY, MAX_QUEUE_DEPTH);

export interface ImageProcessingProfile {
  subject: "Avatar" | "Product image";
  kind: "avatar" | "product";
}

export interface NormalizedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

export async function normalizeBoundedImage(
  input: Buffer,
  profile: ImageProcessingProfile,
): Promise<NormalizedImage> {
  if (input.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`${profile.subject} source exceeds 5 MiB`);
  }

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    // Header inspection is intentionally outside the worker: these checks run
    // before Sharp is allowed to allocate the decoded pixel surface.
    metadata = await sharp(input, { limitInputPixels: false, animated: true }).metadata();
  } catch {
    throw new Error(`${profile.subject} must contain valid JPEG, PNG, or WebP content`);
  }
  if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) {
    throw new Error(`${profile.subject} must contain valid JPEG, PNG, or WebP content`);
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new Error(
      profile.kind === "avatar"
        ? "Animated avatars are not supported"
        : "Animated product images are not supported",
    );
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 1 || height < 1) throw new Error(`${profile.subject} dimensions are invalid`);
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`${profile.subject} dimensions must not exceed 8192 pixels`);
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`${profile.subject} exceeds 25 million pixels`);
  }

  return workerLimiter.run(() => normalizeInWorker(input, profile));
}

async function normalizeInWorker(
  input: Buffer,
  profile: ImageProcessingProfile,
): Promise<NormalizedImage> {
  return new Promise<NormalizedImage>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { input, sharpPath, maxPixels: MAX_PIXELS, kind: profile.kind },
      // Sharp/libvips uses native decode memory. The dimension/pixel checks
      // above bound that separately from this V8 heap cap.
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`${profile.subject} processing exceeded 5 seconds`));
    }, WORKER_TIMEOUT_MS);
    worker.once(
      "message",
      (message: {
        ok: boolean;
        buffer?: Uint8Array;
        width?: number;
        height?: number;
        error?: string;
      }) => {
        clearTimeout(timeout);
        worker.removeAllListeners("exit");
        void worker.terminate();
        if (
          message.ok &&
          message.buffer &&
          typeof message.width === "number" &&
          typeof message.height === "number"
        ) {
          resolve({
            buffer: Buffer.from(message.buffer),
            width: message.width,
            height: message.height,
          });
        } else {
          reject(new Error(message.error ?? `${profile.subject} processing failed`));
        }
      },
    );
    worker.once("error", (error) => {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : "unknown worker error";
      reject(new Error(`${profile.subject} worker failed: ${message}`));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`${profile.subject} worker exited before completing`));
      }
    });
  });
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const sharp = require(workerData.sharpPath);
(async () => {
  try {
    let pipeline = sharp(Buffer.from(workerData.input), {
      limitInputPixels: workerData.maxPixels,
      pages: 1,
      failOn: "error",
    }).rotate();
    pipeline = workerData.kind === "avatar"
      ? pipeline.resize(512, 512, { fit: "cover", position: "attention" })
      : pipeline.resize(1200, 1200, { fit: "inside", withoutEnlargement: true });
    const { data, info } = await pipeline
      .webp({ quality: 85, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    parentPort.postMessage({ ok: true, buffer: data, width: info.width, height: info.height });
  } catch (error) {
    const subject = workerData.kind === "avatar" ? "Avatar" : "Product image";
    console.error(
      workerData.kind === "avatar" ? "avatar normalization failed" : "product image normalization failed",
      error instanceof Error ? error.message : String(error),
    );
    parentPort.postMessage({ ok: false, error: subject + " normalization failed" });
  }
})();
`;
