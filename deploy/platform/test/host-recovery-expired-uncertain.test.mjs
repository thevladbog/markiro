// Split from host-recovery-command.test.mjs so these cases run on their own
// worker; the unconfirmed-termination case.
import { expiredStartupTest } from "./host-recovery-command-fixture.mjs";

expiredStartupTest({ service: "edge", uncertain: true });
