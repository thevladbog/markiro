import { Module, type DynamicModule } from "@nestjs/common";

import type { Env } from "../../env";
import { DadataModule } from "../../integrations/dadata/dadata.module";
import { PlatformDadataController } from "./platform-dadata.controller";
import { PlatformDadataRateLimit } from "./platform-dadata-rate-limit";
import { PlatformDadataService } from "./platform-dadata.service";

@Module({})
export class PlatformDadataModule {
  static forRoot(env: Pick<Env, "DADATA_SECRET" | "DADATA_TOKEN">): DynamicModule {
    return {
      module: PlatformDadataModule,
      imports: [DadataModule.forRoot(env)],
      controllers: [PlatformDadataController],
      providers: [
        PlatformDadataService,
        { provide: PlatformDadataRateLimit, useFactory: () => new PlatformDadataRateLimit() },
      ],
    };
  }
}
