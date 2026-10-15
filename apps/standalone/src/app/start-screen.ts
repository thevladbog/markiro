import type { InstallRole } from "../host/device.js";
import type { ShellView } from "./shell.js";

/**
 * Which half of the program a host PC shows (owner requirement, beta 3.2):
 * the host's PC starts in the office at every launch and goes to the floor on
 * this PC only by asking («В цех»). The choice lives in the page's memory for
 * the session and is never stored: the next launch starts in the office again.
 */
export type HostHome = "office" | "floor";

/** Where a host PC starts, and where it is after a reload. */
export const INITIAL_HOST_HOME: HostHome = "office";

/** The screens of the floor half: the sign-in, the work, the line choice. */
function isFloorView(view: ShellView): boolean {
  return view.kind === "floor" || view.kind === "floor_operator" || view.kind === "line_select";
}

/**
 * The screen the program starts on, by the installer's role. `shellView` is
 * what the device and the host say (`nextShellView`); this only decides which
 * half of the program a role is shown when the floor would come up:
 *
 * - `office`: never the floor; the office sign-in (the pairing and connection
 *   screens come from `shellView` itself while the PC is not connected);
 * - `host`: the office sign-in, unless the user went to the floor on this PC
 *   (`home === "floor"`); the first-run wizard (`bootstrap`) is not a floor
 *   screen and still comes first;
 * - `station` or no readable role: the shell's own screen, so the floor
 *   sign-in (pairing and line choice before it). The station's «Офис» button
 *   stays: the administrator's office session on a station is documented
 *   (`AGENTS.md`, window policy);
 * - not yet known: a floor screen waits (`loading`), so that a host PC never
 *   flashes the operator sign-in before the office.
 */
export function startView(
  shellView: ShellView,
  role: InstallRole | "unknown",
  home: HostHome,
): ShellView {
  if (!isFloorView(shellView)) return shellView;
  if (role === "unknown") return { kind: "loading" };
  if (role === "office" || (role === "host" && home === "office")) {
    return { kind: "office_login", notice: null };
  }
  return shellView;
}
