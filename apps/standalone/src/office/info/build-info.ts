/**
 * What the build knows about itself. `vite.config.ts` fills the two defines
 * from the local checkout at build time (no network); a test run, a build
 * outside a git checkout and the dev server without them get `null`.
 */
declare const __MARKIRO_BUILD_COMMIT__: string | null | undefined;
declare const __MARKIRO_BUILD_DATE__: string | null | undefined;

export interface BuildInfo {
  /** A short commit hash, or `null` when the build did not know it. */
  readonly commit: string | null;
  /** The civil date (`YYYY-MM-DD`, UTC) the web part was built, or `null`. */
  readonly date: string | null;
}

export const BUILD_INFO: BuildInfo = {
  commit: typeof __MARKIRO_BUILD_COMMIT__ === "string" ? __MARKIRO_BUILD_COMMIT__ : null,
  date: typeof __MARKIRO_BUILD_DATE__ === "string" ? __MARKIRO_BUILD_DATE__ : null,
};
