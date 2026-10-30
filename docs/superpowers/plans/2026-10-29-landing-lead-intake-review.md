# PR 811 review corrections

1. Reproduce the Station test and capture failed CI logs. Add failing API configuration/admission tests.
2. Add the isolated PostgreSQL rate-window schema and migration, then implement atomic persistent charges with source HMACs and bounded cleanup. Await admission before storing a lead. Keep legacy demo disabled without its CAPTCHA key.
3. Verify schema/migrations, concurrent admission and failure paths, run affected API/landing/Station checks, commit and push to the existing PR, then inspect CI and review again. Do not deploy.
