import { Global, Module } from "@nestjs/common";
import { AccessController } from "./access.controller";
import { AuthorizationGuard } from "./authorization.guard";
import { AuthorizationService } from "./authorization.service";
import { SecurityAuditService } from "./security-audit.service";

@Global()
@Module({
  controllers: [AccessController],
  providers: [AuthorizationService, AuthorizationGuard, SecurityAuditService],
  exports: [AuthorizationService, AuthorizationGuard, SecurityAuditService],
})
export class AuthorizationModule {}
