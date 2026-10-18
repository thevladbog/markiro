import { readFileSync } from "node:fs";

// Rendered in a plain Node process because Playwright's transform cannot load
// bwip-js/generic through CJS. The generator lives in @markiro/domain and is
// read from its built dist, like every other consumer of the package: the
// production-bundle job builds the admin's workspace dependencies before this
// contract runs, and locally `pnpm turbo run build --filter='@markiro/admin^...'`
// does the same. Loading the domain's TypeScript source instead would require
// every module on the import path to be Node strip-only compatible.
import { renderBoxReportHtml } from "@markiro/domain";

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
