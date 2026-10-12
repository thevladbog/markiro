import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  usSixMonthDefinition,
  makeUsSixMonthSpecialExamples,
} = require("../../dist/modules/traceability/demo/us-six-month-definition.js");
const {
  makeUsSixMonthRegularChain,
} = require("../../dist/modules/traceability/demo/us-six-month-chains.js");
const special = makeUsSixMonthSpecialExamples();
const chains = [
  ...Array.from({ length: 260 }, (_, index) => makeUsSixMonthRegularChain(index)),
  special.correction.correctedChain,
];
const census = {
  eventRoots: 1 + chains.reduce((sum, chain) => sum + 2 + chain.shipping.length, 0),
  currentFinalizedEvents: chains.reduce((sum, chain) => sum + 2 + chain.shipping.length, 0),
  lots:
    special.orphan.receiving.lines.length +
    chains.reduce((sum, chain) => sum + chain.receiving.lines.length + 1, 0),
  boxes: chains.reduce((sum, chain) => sum + chain.cases.length, 0),
};
process.stdout.write(JSON.stringify({ digest: usSixMonthDefinition.digest, census }));
