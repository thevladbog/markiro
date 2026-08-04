try {
  const response = await fetch(
    process.env.HEALTHCHECK_URL ?? "http://127.0.0.1:3000/health/ready",
    { signal: AbortSignal.timeout(2_000) },
  );
  const { status } = await response.json();

  process.exitCode = response.ok && (status === "ok" || status === "degraded") ? 0 : 1;
} catch {
  process.exitCode = 1;
}
