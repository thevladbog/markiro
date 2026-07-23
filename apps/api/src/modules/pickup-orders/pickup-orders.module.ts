import { Module } from "@nestjs/common";
import { PickupOrdersService } from "./pickup-orders.service";

/**
 * Shared module for `PickupOrdersService`: `KioskModule` (device-facing,
 * Task 8) and the admin `PickupOrdersController` (Task 9) both import this
 * module rather than each declaring the service as their own provider, so
 * there's exactly one instance in the DI graph.
 */
@Module({
  providers: [PickupOrdersService],
  exports: [PickupOrdersService],
})
export class PickupOrdersModule {}
