import { createServer, type Server } from "node:https";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { Express } from "express";
import { assertUsHostedRelease, type VerifiedUsHostedRelease } from "./us-hosted-release-verifier";
import {
  assertUsHostedMaterial,
  usHostedApiMaterial,
  type UsHostedMaterialOwner,
} from "./us-hosted-material-owner";

const invalid = () => new Error("us_hosted_https_invalid");
function admitted(release: unknown, material: unknown) {
  try {
    assertUsHostedRelease(release);
    assertUsHostedMaterial(material, release, "api");
    return { release, material };
  } catch {
    throw invalid();
  }
}

/** Intrinsic private HTTPS; protocol/credentials cannot be selected by caller headers or options. */
export class UsHostedHttpsAdapter extends ExpressAdapter {
  readonly #release: VerifiedUsHostedRelease;
  readonly #material: UsHostedMaterialOwner;
  #server: Server | undefined;
  #closing: Promise<void> | undefined;
  #listened = false;
  #closed = false;
  constructor(release: unknown, material: unknown) {
    const owners = admitted(release, material);
    super();
    this.#release = owners.release;
    this.#material = owners.material;
  }
  override initHttpServer(): void {
    try {
      if (this.#server) throw invalid();
      assertUsHostedRelease(this.#release);
      assertUsHostedMaterial(this.#material, this.#release, "api");
      const { tls } = usHostedApiMaterial(this.#material, this.#release);
      const server = createServer(
        { maxHeaderSize: 64 * 1024, cert: tls.certificate, key: tls.privateKey },
        this.getInstance<Express>(),
      );
      server.once("listening", () => {
        this.#listened = true;
      });
      server.once("close", () => {
        this.#closed = true;
      });
      this.#server = server;
      this.httpServer = server;
    } catch {
      throw invalid();
    }
  }
  override close(): Promise<void> {
    const server = this.#server;
    if (!server) return Promise.resolve();
    this.#closing ??= new Promise<void>((resolve, reject) => {
      try {
        // Native close waits for active HTTP requests; no socket cancellation or extra deadline.
        server.close((error?: Error) => {
          if (
            !error ||
            this.#closed ||
            (!this.#listened && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
          )
            resolve();
          else reject(invalid());
        });
      } catch {
        reject(invalid());
      }
    });
    return this.#closing;
  }
}
