// Split from host-recovery-command.test.mjs so these cases run on their own
// worker; the termination-confirmed cases.
import { expiredStartupTest } from "./host-recovery-command-fixture.mjs";

expiredStartupTest({ service: "api", uncertain: false });
expiredStartupTest({ service: "edge", uncertain: false });
