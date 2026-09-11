import { Module } from "@nestjs/common";
import { PlatformEntitlementsController } from "./platform-entitlements.controller";

/** Registered only alongside the platform auth module; services are globally provided by SubscriptionsModule. */
@Module({ controllers: [PlatformEntitlementsController] })
export class PlatformEntitlementsModule {}
