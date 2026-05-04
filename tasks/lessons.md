# Lessons

- When live Healix validation is blocked by account quota, switch to code-level contract tests and report the quota blocker explicitly instead of accepting smoke fallback results as end-to-end proof.
- Add regression tests around any generated Playwright code path that constructs selectors or regular expressions; small string-synthesis mistakes can produce syntactically invalid specs even when live turns pass.
