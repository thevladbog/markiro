import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

// Node 24 strips the renderer's TypeScript and preserves ESM dependency loading;
// Playwright's transform cannot load bwip-js/generic through CJS. Read current
// source directly so this fixture never depends on missing or stale API output.
//
// The domain package writes Node ESM imports with a `.js` suffix
// (`./contents-report.js`) that its TypeScript build maps to `.ts` files, which
// Node's resolver cannot find in source form. Only for a relative import from a
// TypeScript file that Node cannot find, retry the `.ts` source, so the
// package's import style and build stay untouched. Those sources are ES modules
// written in TypeScript; saying so spares Node a CommonJS attempt. The hook
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
    const relativeSourceImport =
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      /^\.\.?\//.test(specifier) &&
      context.parentURL?.endsWith(".ts");
    if (!relativeSourceImport) throw error;
    const source = specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : `${specifier}.ts`;
    return nextResolve(source, context);
  }
}
const { renderBoxReportHtml } =
  await import("../../../../packages/domain/src/print-forms/box-report.ts");

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
