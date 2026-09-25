import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

// Node 24 strips the renderer's TypeScript and preserves ESM dependency loading;
// Playwright's transform cannot load bwip-js/generic through CJS. Read current
// source directly so this fixture never depends on missing or stale API output.
//
// The API imports its own modules without an extension (`./contents-report`),
// which its TypeScript build resolves and Node's ESM resolver does not. Only
// for a relative import from a TypeScript file that Node cannot find, retry the
// `.ts` source, so the API's import style and build stay untouched. Those
// sources are ES modules written in TypeScript; saying so spares Node a
// CommonJS attempt and the typeless-package warning for apps/api. The hook
// must be registered before the renderer loads, hence the dynamic import.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = resolveSource(specifier, context, nextResolve);
    return resolved.url.endsWith(".ts") ? { ...resolved, format: "module-typescript" } : resolved;
  },
});

function resolveSource(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    const extensionlessSourceImport =
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      /^\.\.?\//.test(specifier) &&
      context.parentURL?.endsWith(".ts");
    if (!extensionlessSourceImport) throw error;
    return nextResolve(`${specifier}.ts`, context);
  }
}
const { renderBoxReportHtml } = await import("../../../api/src/modules/code-search/box-report.ts");

const { data, timeZone } = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(
  renderBoxReportHtml(
    {
      ...data,
      openedAt: new Date(data.openedAt),
      closedAt: data.closedAt ? new Date(data.closedAt) : null,
      disassembledAt: data.disassembledAt ? new Date(data.disassembledAt) : null,
    },
    timeZone,
  ),
);
