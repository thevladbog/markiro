import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
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

type WorkerValidationError =
  | "invalid_content"
  | "animated"
  | "invalid_dimensions"
  | "dimension_limit"
  | "pixel_limit"
  | "normalization_failed";

type WorkerMessage =
  | { ok: true; buffer: Uint8Array; width: number; height: number }
  | { ok: false; error: WorkerValidationError };

export async function normalizeBoundedImage(
  input: Buffer,
  profile: ImageProcessingProfile,
): Promise<NormalizedImage> {
  if (input.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`${profile.subject} source exceeds 5 MiB`);
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
      workerData: {
        input,
        sharpPath,
        maxDimension: MAX_DIMENSION,
        maxPixels: MAX_PIXELS,
        kind: profile.kind,
      },
      // All parsing and decode work happens inside this bounded worker. Sharp/
      // libvips native memory is constrained by the worker-side dimensions and
      // pixel checks before normalization begins.
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`${profile.subject} processing exceeded 5 seconds`));
    }, WORKER_TIMEOUT_MS);
    worker.once(
      "message",
      (message: WorkerMessage) => {
        clearTimeout(timeout);
        worker.removeAllListeners("exit");
        void worker.terminate();
        if (message.ok) {
          resolve({
            buffer: Buffer.from(message.buffer),
            width: message.width,
            height: message.height,
          });
        } else {
          reject(new Error(validationErrorMessage(message.error, profile)));
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

function validationErrorMessage(
  error: WorkerValidationError,
  profile: ImageProcessingProfile,
): string {
  switch (error) {
    case "invalid_content":
      return `${profile.subject} must contain valid JPEG, PNG, or WebP content`;
    case "animated":
      return profile.kind === "avatar"
        ? "Animated avatars are not supported"
        : "Animated product images are not supported";
    case "invalid_dimensions":
      return `${profile.subject} dimensions are invalid`;
    case "dimension_limit":
      return `${profile.subject} dimensions must not exceed 8192 pixels`;
    case "pixel_limit":
      return `${profile.subject} exceeds 25 million pixels`;
    case "normalization_failed":
      return `${profile.subject} normalization failed`;
  }
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const sharp = require(workerData.sharpPath);
(async () => {
  try {
    let metadata;
    try {
      metadata = await sharp(Buffer.from(workerData.input), {
        limitInputPixels: false,
        animated: true,
      }).metadata();
    } catch {
      parentPort.postMessage({ ok: false, error: "invalid_content" });
      return;
    }
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) {
      parentPort.postMessage({ ok: false, error: "invalid_content" });
      return;
    }
    if ((metadata.pages ?? 1) !== 1) {
      parentPort.postMessage({ ok: false, error: "animated" });
      return;
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width < 1 || height < 1) {
      parentPort.postMessage({ ok: false, error: "invalid_dimensions" });
      return;
    }
    if (width > workerData.maxDimension || height > workerData.maxDimension) {
      parentPort.postMessage({ ok: false, error: "dimension_limit" });
      return;
    }
    if (width * height > workerData.maxPixels) {
      parentPort.postMessage({ ok: false, error: "pixel_limit" });
      return;
    }

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
    console.error(
      workerData.kind === "avatar" ? "avatar normalization failed" : "product image normalization failed",
      error instanceof Error ? error.message : String(error),
    );
    parentPort.postMessage({ ok: false, error: "normalization_failed" });
  }
})();
`;
