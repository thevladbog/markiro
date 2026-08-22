import { Module, type DynamicModule } from "@nestjs/common";

import type { Env } from "../../env";
import { DadataCache } from "./dadata-cache";
import { DadataClient } from "./dadata.client";
import { DadataConfig } from "./dadata.types";

@Module({})
export class DadataModule {
  static forRoot(env: Pick<Env, "DADATA_SECRET" | "DADATA_TOKEN">): DynamicModule {
    const config = new DadataConfig(env.DADATA_TOKEN, env.DADATA_SECRET);
    return {
      module: DadataModule,
      providers: [
        { provide: DadataConfig, useValue: config },
        { provide: DadataCache, useFactory: () => new DadataCache() },
        {
          provide: DadataClient,
          useFactory: (cache: DadataCache) => new DadataClient(config, cache),
          inject: [DadataCache],
        },
      ],
      exports: [DadataClient, DadataConfig],
    };
  }
}
