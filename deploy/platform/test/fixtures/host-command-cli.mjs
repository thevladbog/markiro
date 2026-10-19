// Static process-boundary harness. The public CLI has no test injection surface.
import { runHostCommandCli } from "../../host/command.mjs";
import { integrationOptions } from "../host-command-integration-fixture.mjs";
const [root] = process.argv.slice(2);
await runHostCommandCli([root], await integrationOptions(root));
