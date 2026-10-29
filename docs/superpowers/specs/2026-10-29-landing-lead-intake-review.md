# Landing lead intake after CAPTCHA removal

The public download/invoice endpoint keeps the existing switch, consent, honeypot and source/global budgets. Its limiter must share counters across API instances and restarts. Persist only HMAC source keys (using the stable platform auth secret), never raw IP addresses, in a dedicated platform-level table. PostgreSQL serializes global/source charges; rejected charges commit, counters saturate, and exhausted global budgets cannot create new source rows. Database time defines window expiry. Expired source keys are removed on requests; no business lead data is rewritten. Storage errors fail closed with the existing bounded 503 response.

The legacy demo endpoint still requires CAPTCHA. Without a server key its guard and service must be disabled even when the download/invoice flag is on. With a key its existing behavior stays available.

The Station failure is a wall-clock timeout in the CPU/SQLite-heavy A4 persistence suite. Preserve assertions, printer geometry and the 15-second timeout; bound worker contention if the isolated test confirms it is not a product failure.

Acceptance: real PostgreSQL races across limiter instances never exceed either budget; a new instance retains spent counters; expired windows reset; source keys are private; global exhaustion bounds table growth; the service awaits admission and stores no lead on a rejected/failed charge. Legacy demo disablement is tested independently of lead enablement.
