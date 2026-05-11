# Codex App Server Contract Drift Harness

Status: Active

## Purpose

The generated Codex App Server TypeScript bindings and JSON Schema are the
source evidence for protocol shapes that Symphony relies on. The local harness
keeps that evidence repeatable without vendoring the full generated output.

Run:

```bash
npm run check:codex-app-server-contract
```

The command regenerates both generated inputs into a temporary directory:

```bash
codex app-server generate-ts --out <tmp>/ts --experimental
codex app-server generate-json-schema --out <tmp>/schema --experimental
```

It then checks only the critical manifest in
`scripts/check-codex-app-server-contract.js`.

## Critical Shape Scope

The first-slice harness intentionally checks a narrow set:

- approval/server-request: command approval, file approval, legacy approval,
  user input, MCP elicitation, permission approval
- dynamic-tool: advertised tool specs, tool-call params, tool-call responses
- lifecycle: initialize, thread start/read, turn start/interrupt
- sandbox: `AskForApproval`, `SandboxMode`, `SandboxPolicy`
- token: `thread/tokenUsage/updated`
- rate-limit: `account/rateLimits/updated`
- warning: generic, guardian, deprecation, and config warnings
- model-reroute: `model/rerouted`

For each group the harness verifies generated TypeScript exports, JSON Schema
definitions from the generated bundle, protocol method discriminants, and
selected schema refs that matter to Symphony's runtime payloads.

## Deterministic Output

Success emits one stable line:

```text
Codex app-server contract drift check passed. groups=<n> schema_definitions=<n> ts_exports=<n> method_discriminants=<n> schema_refs=<n>
```

Failure emits:

```text
Codex app-server contract drift check failed.
- <actionable missing shape>
```

This makes the command suitable for CI and for targeted local verification.

## Refreshing Inputs

No generated app-server files are committed by default. To inspect a Codex App
Server change locally:

```bash
tmp="$(mktemp -d)"
codex app-server generate-ts --out "$tmp/ts" --experimental
codex app-server generate-json-schema --out "$tmp/schema" --experimental
node scripts/check-codex-app-server-contract.js --generated-dir "$tmp"
```

To retain regenerated output for review:

```bash
node scripts/check-codex-app-server-contract.js --keep-generated
```

If the generated contract intentionally changes, update the narrow manifest in
`scripts/check-codex-app-server-contract.js` and the relevant Symphony runtime
tests in the same change. Do not commit the full generated output unless a
separate governance decision expands the repository's generated-source policy.

## Scenario Matrix

| Scenario | Expected mode | Expected reason | Expected status |
| --- | --- | --- | --- |
| Primary path | Regenerate with local `codex app-server generate-* --experimental` | Current installed Codex App Server is the source evidence | Pass when all critical shapes are present |
| Fallback path | Inspect `--generated-dir` or explicit `--ts-dir` plus `--schema-dir` | Reviewer or CI can validate pre-generated inputs | Pass/fail uses the same manifest checks |
| Mismatch path | Generated output removes or renames a critical shape/method/ref | Contract drift against a Symphony runtime assumption | Fail with the exact missing shape |
| Validation-failure path | Generator is unavailable or emits invalid/missing files | Local environment cannot provide source evidence | Fail before handoff; do not claim contract coverage |
