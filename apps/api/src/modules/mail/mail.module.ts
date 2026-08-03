import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { AuthSetup } from "../../auth/auth.setup";
import { DB_POOL } from "../../auth/auth.module";
import type { Env } from "../../env";
import { MailCryptoService } from "./mail-crypto.service";
import { MailDeliveryService } from "./mail-delivery.service";
import { MailJobsService } from "./mail-jobs.service";
import { MailRetentionService } from "./mail-retention.service";
import { MailTransportService } from "./mail-transport.service";

@Global()
@Module({})
export class MailModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: MailModule,
      providers: [
        {
          provide: MailCryptoService,
          useFactory: () => new MailCryptoService(env.MAIL_PAYLOAD_ENCRYPTION_KEY),
        },
        {
          provide: MailDeliveryService,
          inject: [MailCryptoService],
          useFactory: (crypto: MailCryptoService) => new MailDeliveryService(crypto),
        },
        {
          provide: MailTransportService,
          useFactory: () => new MailTransportService(env),
        },
        {
          provide: MailJobsService,
          inject: [DB_POOL, MailCryptoService, MailTransportService],
          useFactory: (
            pool: AuthSetup["pool"],
            crypto: MailCryptoService,
            transport: MailTransportService,
          ) => new MailJobsService(pool, crypto, transport),
        },
        {
          provide: MailRetentionService,
          inject: [DB_POOL],
          useFactory: (pool: AuthSetup["pool"]) => new MailRetentionService(pool),
        },
      ],
      exports: [
        MailCryptoService,
        MailDeliveryService,
        MailTransportService,
        MailJobsService,
        MailRetentionService,
      ],
    };
  }
}
