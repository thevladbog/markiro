import type { Db } from "@markiro/db";

import { MailCryptoService } from "../../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../../src/modules/mail/mail-delivery.service";
import { TenantBillingNotificationsService } from "../../src/modules/tenant-billing/tenant-billing-notifications.service";

export function createTestTenantBillingNotifications(
  db: Db,
  clock: () => Date = () => new Date("2026-08-28T10:00:00.000+03:00"),
): TenantBillingNotificationsService {
  return new TenantBillingNotificationsService(
    db,
    new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x6e))),
    "https://cabinet.markiro.test",
    clock,
  );
}

export function noopTenantBillingNotifications(): TenantBillingNotificationsService {
  return {
    attention: async () => ({ count: 0 }),
    enqueueInTransaction: async () => [],
    isDueSoon: () => false,
  } as unknown as TenantBillingNotificationsService;
}

export function failingTenantBillingNotifications(error: Error): TenantBillingNotificationsService {
  return {
    attention: async () => ({ count: 0 }),
    enqueueInTransaction: async () => {
      throw error;
    },
    isDueSoon: () => true,
  } as unknown as TenantBillingNotificationsService;
}
