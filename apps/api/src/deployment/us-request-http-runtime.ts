import type { Db } from "@markiro/db";
import { usRequestDetailResponseSchema } from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";
import { UsRequestReadStore } from "../modules/traceability/requests/us-request-read";
import { UsRequestHttpCommands } from "../modules/traceability/requests/us-request-http-commands";
import { UsRequestDownloadStore } from "../modules/traceability/requests/us-request-download";
import type { UsRequestHttpContext } from "../modules/traceability/requests/us-request-http-context";
import {
  UsRequestHttpResources,
  type UsRequestHttpResourceDependencies,
} from "./us-request-http-resources";

/** Owns request clients only; the supplied database remains caller-owned. */
export class UsRequestHttpRuntime {
  readonly reads: UsRequestReadStore;
  readonly commands: UsRequestHttpCommands;
  readonly downloads: UsRequestDownloadStore;
  readonly resources: UsRequestHttpResources;
  constructor(
    db: Db,
    source: NodeJS.ProcessEnv = {},
    resourceDeps?: UsRequestHttpResourceDependencies,
  ) {
    this.resources = new UsRequestHttpResources(source, resourceDeps);
    this.reads = new UsRequestReadStore(db);
    this.commands = new UsRequestHttpCommands(db, this.resources);
    this.downloads = new UsRequestDownloadStore(db, () => this.resources.requirePackageStore());
  }
  async get(ctx: UsRequestHttpContext, id: unknown) {
    const detail = await this.reads.get(ctx, id);
    const value = usRequestDetailResponseSchema.safeParse({
      ...detail,
      availability: await this.resources.availability(),
    });
    if (!value.success)
      throw new ServiceUnavailableException({ code: "us_request_stored_invalid" });
    return value.data;
  }
  dispose(): void {
    this.resources.dispose();
  }
}
