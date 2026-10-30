import { UpdateError, type UpdatesApi } from "../../update/updates-api.js";
import type { OfficeSessionValue } from "../office-session.js";

/** A lost upload response may leave the verified package already on Host. */
export async function stageOnlinePackage(
  session: Pick<OfficeSessionValue, "api" | "call">,
  updates: Pick<UpdatesApi, "stage">,
  path: string,
  version: string,
): Promise<void> {
  try {
    const staged = await session.call((token) => updates.stage(path, token));
    if (staged.version !== version) throw new UpdateError("refused", "unexpected staged version");
  } catch (error) {
    if (!(error instanceof UpdateError) || error.code !== "package_not_newer") throw error;
    const status = await session.call((token) => session.api.getUpdateStatus(token));
    const current = status.package.state === "ok" && status.package.version === version;
    if (!current && status.package.staged !== version) throw error;
  }
}
