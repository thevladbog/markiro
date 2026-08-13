import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { BoundedConcurrencyLimiter } from "./bounded-concurrency";

const WORKER_TIMEOUT_MS = 5_000;
const MAX_CONCURRENCY = 2;
const MAX_QUEUE_DEPTH = 8;
const sharpPath = createRequire(__filename).resolve("sharp");
const workerLimiter = new BoundedConcurrencyLimiter(MAX_CONCURRENCY, MAX_QUEUE_DEPTH);

export interface RasterImageOptions {
  maxSourceBytes: number;
  maxDimension: number;
  maxPixels: number;
  maxFrames: number;
  width: number;
  height: number;
  fit: "cover" | "inside";
  withoutEnlargement: boolean;
  quality: number;
  label: "Avatar" | "Logo";
  pluralLabel: "avatars" | "logos";
  position?: "attention";
}

export interface ProcessedRasterImage {
  buffer: Buffer;
  width: number;
  height: number;
}

export async function processRasterImage(
  input: Buffer,
  options: RasterImageOptions,
): Promise<ProcessedRasterImage> {
  const sourceLimitMiB = options.maxSourceBytes / (1024 * 1024);
  if (input.byteLength > options.maxSourceBytes) {
    throw new Error(`${options.label} source exceeds ${sourceLimitMiB} MiB`);
  }

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    // Header inspection happens only after the encoded-body limit and before
    // the worker is allowed to allocate decoded pixels.
    metadata = await sharp(input, { limitInputPixels: false, animated: true }).metadata();
  } catch {
    throw new Error(`${options.label} must contain valid JPEG, PNG, or WebP content`);
  }
  if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) {
    throw new Error(`${options.label} must contain valid JPEG, PNG, or WebP content`);
  }
  if ((metadata.pages ?? 1) > options.maxFrames) {
    throw new Error(`Animated ${options.pluralLabel} are not supported`);
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 1 || height < 1) throw new Error(`${options.label} dimensions are invalid`);
  if (width > options.maxDimension || height > options.maxDimension) {
    throw new Error(`${options.label} dimensions must not exceed ${options.maxDimension} pixels`);
  }
  if (width * height > options.maxPixels) {
    throw new Error(`${options.label} exceeds ${formatPixelLimit(options.maxPixels)}`);
  }

  return workerLimiter.run(() => normalizeInWorker(input, options));
}

async function normalizeInWorker(
  input: Buffer,
  options: RasterImageOptions,
): Promise<ProcessedRasterImage> {
  return new Promise<ProcessedRasterImage>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { input, sharpPath, options },
      // Sharp/libvips native allocations are bounded by the dimension and
      // pixel checks above; this separately caps the worker's V8 heap.
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`${options.label} processing exceeded 5 seconds`));
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
          reject(new Error(message.error ?? `${options.label} processing failed`));
        }
      },
    );
    worker.once("error", (error) => {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : "unknown worker error";
      reject(new Error(`${options.label} worker failed: ${message}`));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`${options.label} worker exited before completing`));
      }
    });
  });
}

function formatPixelLimit(maxPixels: number): string {
  return maxPixels % 1_000_000 === 0
    ? `${maxPixels / 1_000_000} million pixels`
    : `${maxPixels} pixels`;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const sharp = require(workerData.sharpPath);
(async () => {
  try {
    const { options } = workerData;
    const { data, info } = await sharp(Buffer.from(workerData.input), {
      limitInputPixels: options.maxPixels,
      pages: options.maxFrames,
      failOn: "error",
    })
      .rotate()
      .resize(options.width, options.height, {
        fit: options.fit,
        position: options.position,
        withoutEnlargement: options.withoutEnlargement,
      })
      .webp({ quality: options.quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    parentPort.postMessage({ ok: true, buffer: data, width: info.width, height: info.height });
  } catch (error) {
    console.error(
      workerData.options.label.toLowerCase() + " normalization failed",
      error instanceof Error ? error.message : String(error),
    );
    parentPort.postMessage({
      ok: false,
      error: workerData.options.label + " normalization failed",
    });
  }
})();
`;
