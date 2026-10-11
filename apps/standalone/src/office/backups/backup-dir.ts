/** Why the office refuses a folder before the host sees it (`routes/backups.rs`, `second_dir`). */
export type DirectoryProblem = "device" | "parent" | "notAbsolute";

/** `\\?\…` and `\\.\…`, either slash: Windows' verbatim and device namespaces. */
const DEVICE_PATH = /^[\\/]{2}[?.][\\/]/;
/** `E:\…` or `E:/…`. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
/** `\\PC\Share…`: a server and a share, neither empty. */
const SHARE_PATH = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/;

/**
 * What is wrong with a folder as the administrator typed it, in the order the
 * host's own rules would find it, or `null`: the office has the host's rule
 * so that the text says what to change, where the host says only that it
 * refused. A device path (`\\?\UNC\PC\Share` included) is named first: it
 * would pass for a share. A drive letter alone (`E:`) or a relative path is
 * not a full path.
 */
export function directoryProblem(text: string): DirectoryProblem | null {
  if (DEVICE_PATH.test(text)) return "device";
  if (text.split(/[\\/]/).includes("..")) return "parent";
  if (DRIVE_PATH.test(text) || SHARE_PATH.test(text)) return null;
  return "notAbsolute";
}
