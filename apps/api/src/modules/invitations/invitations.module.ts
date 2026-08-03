import { Module } from "@nestjs/common";
import { InvitationsController } from "./invitations.controller";
import { InvitationsService } from "./invitations.service";
import { InvitationsReconciler } from "./invitations-reconciler";

@Module({
  controllers: [InvitationsController],
  providers: [InvitationsService, InvitationsReconciler],
})
export class InvitationsModule {}
