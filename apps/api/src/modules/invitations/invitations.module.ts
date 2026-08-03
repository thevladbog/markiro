import { Module } from "@nestjs/common";
import { InvitationsController } from "./invitations.controller";
import { InvitationsService } from "./invitations.service";
import { InvitationsReconciler } from "./invitations-reconciler";
import { InvitationLookupRateLimiter } from "./invitation-lookup-rate-limiter";

@Module({
  controllers: [InvitationsController],
  providers: [InvitationsService, InvitationsReconciler, InvitationLookupRateLimiter],
})
export class InvitationsModule {}
