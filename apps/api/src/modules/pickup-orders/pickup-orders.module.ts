import { Module } from "@nestjs/common";
import { OperatorsModule } from "../operators/operators.module";
import { PickupOrdersController } from "./pickup-orders.controller";
import { PickupOrdersService } from "./pickup-orders.service";

/**
 * Shared module for `PickupOrdersService`: `KioskModule` (device-facing,
 * Task 8) imports this module for the service only, and this module also
 * declares the admin `PickupOrdersController` (Task 9). Registering
 * `PickupOrdersModule` directly in `AppModule` activates that controller;
 * NestJS keeps a single module instance across both import sites, so
 * `PickupOrdersService` stays a shared singleton.
 *
 * Imports `OperatorsModule` so `bootstrap()` can reuse `OperatorsService`'s
 * badge-hashing/backfill path and roster builder (Task 4) instead of
 * duplicating them.
 */
@Module({
  imports: [OperatorsModule],
  controllers: [PickupOrdersController],
  providers: [PickupOrdersService],
  exports: [PickupOrdersService],
})
export class PickupOrdersModule {}
