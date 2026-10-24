import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { yandexBackupStatusSchema, yandexClientProfileSchema } from "./yandex-backups.js";
export const recoveryCopySchema = z.object({
  snapshotId: z.uuid(),
  hostId: z.uuid(),
  createdAt: z.string().datetime({ offset: true }),
  organizationLabel: z.string(),
  inn: z.string(),
  appVersion: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});
export type RecoveryCopy = z.infer<typeof recoveryCopySchema>;
export const yandexNative = {
  connect: async (clientId: string, officeToken: string) =>
    yandexBackupStatusSchema.parse(await invoke("yandex_connect", { clientId, officeToken })),
  cancel: () => invoke<void>("yandex_cancel"),
  registration: () => invoke<void>("yandex_registration"),
  importProfile: async () => yandexClientProfileSchema.parse(await invoke("yandex_profile_import")),
  exportProfile: (clientId: string) => invoke<string>("yandex_profile_export", { clientId }),
  auth: (clientId: string) => invoke<string>("yandex_recovery_auth", { clientId }),
  list: async () => z.array(recoveryCopySchema).parse(await invoke("yandex_recovery_list")),
  download: (hostId: string, snapshotId: string) =>
    invoke<void>("yandex_recovery_download", { hostId, snapshotId }),
  restore: () => invoke<void>("yandex_recovery_restore", { oldHostStopped: true }),
  recoveryAvailable: () => invoke<boolean>("yandex_recovery_available"),
  resume: () => invoke<void>("yandex_recovery_resume"),
};
