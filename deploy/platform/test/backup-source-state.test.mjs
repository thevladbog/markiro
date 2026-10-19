import assert from "node:assert/strict";
import { test } from "node:test";
import { noWriters } from "../backup/source-state.mjs";

for (const [sessions, prepared, rejected] of [
  [0, 0, false],
  [1, 0, true],
  [0, 1, true],
])
  test(`writer boundary: client sessions=${sessions}, prepared transactions=${prepared}`, async () => {
    const calls = [];
    const client = {
      query: async (sql, parameters) => {
        calls.push({ sql, parameters });
        return { rows: [{ n: calls.length === 1 ? sessions : prepared }] };
      },
    };
    const result = noWriters(client, "markiro_backup_operation");
    if (rejected) await assert.rejects(result);
    else await result;
    const first = calls[0];
    assert.match(first.sql, /backend_type\s*=\s*'client backend'/u);
    assert.match(
      first.sql,
      /datid=\(SELECT oid FROM pg_database WHERE datname=current_database\(\)\)/u,
    );
    assert.match(first.sql, /pid<>pg_backend_pid\(\)/u);
    assert.match(first.sql, /application_name<>\$1/u);
    assert.deepEqual(first.parameters, ["markiro_backup_operation"]);
    if (sessions === 0)
      assert.match(calls[1].sql, /pg_prepared_xacts WHERE database=current_database\(\)/u);
    else assert.equal(calls.length, 1);
  });
