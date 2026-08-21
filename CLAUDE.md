## Graphify

The local Graphify knowledge graph lives under `graphify-out/`. That directory is
machine-generated and intentionally ignored by Git; `docs/working-map.md` is the
tracked, curated orientation aid.

Rules:

- For codebase questions, first run `graphify query "<question>"` when
  `graphify-out/graph.json` exists. Use `graphify path "<A>" "<B>"` for
  relationships and `graphify explain "<concept>"` for focused concepts. Verify
  material findings in current source and tests.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when
  query, path, and explain do not surface enough context.
- After modifying code, run `graphify update .` when a local graph exists. This is
  an AST-only incremental update and does not require an API call.
