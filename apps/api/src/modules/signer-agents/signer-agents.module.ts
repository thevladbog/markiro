import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { SignerAgentGuard } from "../../tenancy/signer-agent.guard";
import { DevicePairingModule } from "../device-pairing/device-pairing.module";
import { JournalService } from "../integrations/journal.service";
import { ChzCryptoService } from "./chz-crypto.service";
import { SignerAgentPairController } from "./signer-agent-pair.controller";
import { SignerAgentTasksController } from "./signer-agent-tasks.controller";
import { SignerAgentsController } from "./signer-agents.controller";
import { SignerAgentsService } from "./signer-agents.service";
import { SignerTasksService } from "./signer-tasks.service";

@Module({})
export class SignerAgentsModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: SignerAgentsModule,
      imports: [DevicePairingModule],
      controllers: [SignerAgentsController, SignerAgentPairController, SignerAgentTasksController],
      providers: [
        SignerAgentsService,
        SignerTasksService,
        SignerAgentGuard,
        JournalService,
        {
          provide: ChzCryptoService,
          useFactory: () => new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
        },
      ],
      exports: [ChzCryptoService],
    };
  }
}
