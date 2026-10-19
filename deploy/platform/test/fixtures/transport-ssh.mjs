// Static fake SSH boundary: no network, shell evaluation or generated source.
const [fault, phase] = process.argv.slice(2);
for await (const chunk of process.stdin) void chunk;
if (phase === "receive" && ["wrong-key", "transfer"].includes(fault)) {
  process.stderr.write(
    fault === "wrong-key" ? "Host key verification failed.\n" : "Transfer failed.\n",
  );
  process.exitCode = 255;
} else if (phase === "execute" && ["command", "lost"].includes(fault)) {
  process.stderr.write(
    fault === "lost"
      ? "Connection lost.\n"
      : JSON.stringify({
          version: 1,
          kind: "platform-host-command-failure",
          code: "ERR_HOST_COMMAND",
          terminationConfirmed: null,
          recoveryRequired: true,
          durabilityUncertain: false,
        }) + "\n",
  );
  process.exitCode = 1;
} else
  process.stdout.write(
    phase === "receive"
      ? "Platform executor bundle received.\n"
      : "Platform host deployment healthy.\n",
  );
