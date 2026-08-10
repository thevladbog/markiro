import { Module, type DynamicModule } from "@nestjs/common";
import { InvitationsController } from "./invitations.controller";
import { InvitationsService } from "./invitations.service";
import { InvitationsReconciler } from "./invitations-reconciler";
import { InvitationLookupRateLimiter } from "./invitation-lookup-rate-limiter";
import {
  InvitationAdvisoryLockPool,
  INVITATION_ADVISORY_LOCK_DATABASE_URL,
} from "./invitation-advisory-lock-pool.service";

@Module({})
export class InvitationsModule {
  static forRoot(databaseUrl: string): DynamicModule {
    return {
      module: InvitationsModule,
      controllers: [InvitationsController],
      providers: [
        {
          provide: INVITATION_ADVISORY_LOCK_DATABASE_URL,
          useValue: databaseUrl,
        },
        InvitationAdvisoryLockPool,
        InvitationsService,
        InvitationsReconciler,
        InvitationLookupRateLimiter,
      ],
    };
  }
}
