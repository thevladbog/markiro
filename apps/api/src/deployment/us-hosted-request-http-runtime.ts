import type { Db } from "@markiro/db";
import { usRequestDetailResponseSchema } from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";
import { UsRequestReadStore } from "../modules/traceability/requests/us-request-read";
import { UsHostedRequestHttpCommands } from "../modules/traceability/requests/us-hosted-request-http-commands";
import { UsRequestDownloadStore } from "../modules/traceability/requests/us-request-download";
import type { UsRequestHttpContext } from "../modules/traceability/requests/us-request-http-context";
import {
  UsHostedRequestHttpResources,
  assertUsHostedRequestHttpResources,
} from "./us-hosted-request-http-resources";

/** Owns hosted request clients only; the business runtime owns its database lifecycle. */
export class UsHostedRequestHttpRuntime {
  readonly reads: UsRequestReadStore;
  readonly commands: UsHostedRequestHttpCommands;
  readonly downloads: UsRequestDownloadStore;
  readonly #resources: UsHostedRequestHttpResources;
  constructor(db: Db, release: unknown, material: unknown) {
    this.#resources = new UsHostedRequestHttpResources(release, material);
    this.reads = new UsRequestReadStore(db);
    this.commands = new UsHostedRequestHttpCommands(db, this.#resources);
    this.downloads = new UsRequestDownloadStore(db, () => this.#resources.requirePackageStore());
  }
  async get(ctx: UsRequestHttpContext, id: unknown) {
    assertUsHostedRequestHttpResources(this.#resources);
    const detail = await this.reads.get(ctx, id);
    const value = usRequestDetailResponseSchema.safeParse({
      ...detail,
      availability: await this.#resources.availability(),
    });
    if (!value.success)
      throw new ServiceUnavailableException({ code: "us_request_stored_invalid" });
    return value.data;
  }
  dispose(): void {
    this.#resources.dispose();
  }
}
