export function productFiles() {
  const entries = [0, 1].map((idx) => ({
    idx,
    version: "7",
    when: 1784674164506 + idx,
    tag: `000${idx}_fixture`,
    breakpoints: true,
  }));
  return [
    {
      path: "meta/_journal.json",
      bytes: Buffer.from(JSON.stringify({ version: "7", dialect: "postgresql", entries })),
    },
    ...entries.map((e) => ({ path: `${e.tag}.sql`, bytes: Buffer.from(`SELECT ${e.idx};\n`) })),
  ];
}
export const proofInput = () => ({
  productSha: "a".repeat(40),
  imageId: `sha256:${"b".repeat(64)}`,
  imageReference: `ghcr.io/thevladbog/markiro-api@sha256:${"d".repeat(64)}`,
  files: productFiles(),
});
