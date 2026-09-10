import { readFileSync } from "node:fs";
import { renderBoxReportHtml } from "../../../api/src/modules/code-search/box-report.ts";

// Node 24 strips the renderer's TypeScript and preserves ESM dependency loading;
// Playwright's transform cannot load bwip-js/generic through CJS. Read current
// source directly so this fixture never depends on missing or stale API output.
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
