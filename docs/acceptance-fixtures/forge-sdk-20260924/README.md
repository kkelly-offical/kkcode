# Governed GitHub delivery acceptance fixture

This directory is an isolated engineering acceptance fixture for KK Code 1.0.5.
It is not a product change and does not evaluate an LLM's coding quality.

- Target repository baseline: `9a6ed44ff4ed67031b3a4dadd267cda7b68012c6` (`main`).
- Host SDK runtime under test: `49b2ccedf790bcae2c7f4f76554fa61f8a8f79b0`.
- The host freezes `verify.mjs` before a governed strict task writes `result.txt`.
- The model endpoint is a controlled local HTTP fixture, not a live paid model.
- Verification executes the original assertion in a separate, no-network Docker
  workspace before the SDK seals a candidate and delivers it to GitHub.
- The GitHub branch and pull request are dedicated acceptance resources. The PR
  stays a draft; this exercise never merges, publishes, or changes protection.

Run the fixture assertion from any working directory:

```sh
node docs/acceptance-fixtures/forge-sdk-20260924/verify.mjs
```

GitHub checks and human review are independent gates. Reading a pending, missing,
or failed check successfully does not mean the candidate passed that check.
