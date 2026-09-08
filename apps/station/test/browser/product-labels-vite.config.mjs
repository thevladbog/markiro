import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import base from "../../../../docs/acceptance/station-touch-vite.config.mjs";

// Test-only loopback bridge. Each browser scenario owns a disposable file database;
// requests rotate across two real SQLite connections. No factory database or printer.
export default {
  ...base,
  server: {
    fs: {
      allow: [join(base.root, "../.."), realpathSync(join(base.root, "../../node_modules/.pnpm"))],
    },
  },
  plugins: [
    ...base.plugins,
    {
      name: "product-label-browser-sqlite",
      configureServer(server) {
        const directory = mkdtempSync(join(tmpdir(), "markiro-dm-browser-db-"));
        const databases = new Map();
        let next = 0;
        server.httpServer?.once("close", () => {
          for (const pool of databases.values()) for (const db of pool) db.close();
          rmSync(directory, { recursive: true, force: true });
        });
        server.middlewares.use("/__product_labels_sql", async (req, res) => {
          if (
            req.method !== "POST" ||
            req.headers["x-browser-fixture"] !== "product-labels" ||
            (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
          ) {
            res.statusCode = 403;
            res.end();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          try {
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 2 * 1024 * 1024) throw new Error("fixture request too large");
            }
            const { id, operation, sql, params = [] } = JSON.parse(body);
            if (
              typeof id !== "string" ||
              !/^[a-f0-9-]{36}$/.test(id) ||
              !["all", "run"].includes(operation) ||
              typeof sql !== "string" ||
              !Array.isArray(params) ||
              params.some((p) => p !== null && !["string", "number"].includes(typeof p))
            )
              throw new Error("invalid fixture request");
            if (!databases.has(id)) {
              if (databases.size >= 100) throw new Error("fixture limit");
              databases.set(id, [
                new DatabaseSync(join(directory, `${id}.sqlite`)),
                new DatabaseSync(join(directory, `${id}.sqlite`)),
              ]);
            }
            if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql))
              throw new Error("multi-call transaction forbidden");
            const db = databases.get(id)[next++ % 2];
            const statement = db.prepare(sql);
            const value =
              operation === "all" ? statement.all(...params) : (statement.run(...params), []);
            res.end(JSON.stringify({ value }));
          } catch (error) {
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : "fixture failed" }),
            );
          }
        });
      },
    },
  ],
};
