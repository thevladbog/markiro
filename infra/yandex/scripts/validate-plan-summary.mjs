#!/usr/bin/env node

import process from "node:process";

const maximumInputBytes = 1024 * 1024;
const allowedActions = new Set([
  "create",
  "delete",
  "import",
  "move",
  "noop",
  "read",
  "replace",
  "update",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return (
    isPlainObject(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function readInput() {
  const chunks = [];
  let bytes = 0;

  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maximumInputBytes) throw new Error("plan summary input exceeds the safety limit");
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function summarize(input) {
  const actionClasses = new Map();
  let resourceCounts;

  for (const line of input.split(/\r?\n/)) {
    if (line.length === 0) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error("plan summary input is not valid newline-delimited JSON");
    }

    if (!isPlainObject(record) || typeof record.type !== "string") {
      throw new Error("plan summary input contains an invalid record");
    }

    if (record.type === "planned_change") {
      if (!hasExactKeys(record, ["action", "type"]) || !allowedActions.has(record.action)) {
        throw new Error("plan summary input contains an unsafe planned-change projection");
      }
      actionClasses.set(record.action, (actionClasses.get(record.action) ?? 0) + 1);
      continue;
    }

    if (record.type === "change_summary") {
      if (
        resourceCounts !== undefined ||
        !hasExactKeys(record, ["changes", "type"]) ||
        !hasExactKeys(record.changes, ["add", "change", "operation", "remove"]) ||
        record.changes.operation !== "plan" ||
        !isCount(record.changes.add) ||
        !isCount(record.changes.change) ||
        !isCount(record.changes.remove)
      ) {
        throw new Error("plan summary input contains an invalid aggregate summary");
      }
      resourceCounts = {
        add: record.changes.add,
        change: record.changes.change,
        remove: record.changes.remove,
      };
      continue;
    }

    throw new Error("plan summary input contains a forbidden record type");
  }

  if (resourceCounts === undefined) throw new Error("plan summary input has no aggregate summary");

  return {
    action_classes: Object.fromEntries(
      [...actionClasses.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    resource_counts: resourceCounts,
  };
}

try {
  const summary = summarize(await readInput());
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "plan summary validation failed";
  process.stderr.write(`Plan summary rejected: ${message}\n`);
  process.exitCode = 1;
}
