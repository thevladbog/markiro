import { Global, Module } from "@nestjs/common";
import { PlatformAuditService } from "./platform-audit.service";

/** A single audit provider shared by platform HTTP and background work. */
@Global()
@Module({ providers: [PlatformAuditService], exports: [PlatformAuditService] })
export class PlatformAuditModule {}
