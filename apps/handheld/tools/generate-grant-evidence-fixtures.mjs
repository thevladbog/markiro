// Run after building @markiro/domain. This is an Android transport parity fixture, not a second digest implementation.
import { writeFileSync } from 'node:fs';
import { productLabelValueDigest } from '../../../packages/domain/dist/index.js';
const payloads = [
  { batchId: 'fixture', items: [{ raw: '010460068200001321АБВ\u001d93x\n"\\', verdict: 'ok', sequence: 9007199254740991 }], optional: null, enabled: true },
  { z: [2, 1, -0], a: { '😀': 'emoji', '\ud800': '\udfff', '10': 10, '2': 2 } },
];
writeFileSync(new URL('../app/src/test/resources/grant-evidence-digests.json', import.meta.url), JSON.stringify(payloads.map(payload => ({ payload, digest: productLabelValueDigest(payload) })), null, 2) + '\n');
