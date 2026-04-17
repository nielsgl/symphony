# Symphony vs Symphony-Ref Cross-Reference Index

## Purpose
This package compares:
- Our implementation: `/Users/niels.van.Galen.last/code/symphony` (TypeScript + Tauri)
- Reference implementation: `/Users/niels.van.Galen.last/code/symphony-ref/elixir` (Elixir/OTP + Phoenix)

Baseline is **spec-first strict**:
- We do **not** treat the reference as automatically canonical.
- We classify deltas by whether they are required by `SPEC.md`, optional extensions, or true divergences.

## Package Contents
1. [`01-reference-architecture.md`](/Users/niels.van.Galen.last/code/symphony/docs/analysis/crossref/01-reference-architecture.md)
   - High-level and low-level architecture of the Elixir reference.
2. [`02-cross-reference-matrix.md`](/Users/niels.van.Galen.last/code/symphony/docs/analysis/crossref/02-cross-reference-matrix.md)
   - Subsystem and interface parity matrix with evidence anchors.
3. [`03-recommendations-and-migration-plan.md`](/Users/niels.van.Galen.last/code/symphony/docs/analysis/crossref/03-recommendations-and-migration-plan.md)
   - Decision-complete recommendations and migration sequencing.
4. Appendix artifacts:
   - [`appendix/spec-unit-mapping.csv`](/Users/niels.van.Galen.last/code/symphony/docs/analysis/crossref/appendix/spec-unit-mapping.csv)
   - [`appendix/subsystem-diff.json`](/Users/niels.van.Galen.last/code/symphony/docs/analysis/crossref/appendix/subsystem-diff.json)

## Decision Rules
### Classification
- `spec-required`: required to satisfy `SPEC.md` behavior/contract.
- `extension`: capability beyond core spec requirements.
- `divergence`: behavior/contract choice conflicting with spec intent or creating interoperability/safety risk.

### Parity Status
- `equivalent`: same behavior/contract shape.
- `functionally-equivalent`: different internals, equivalent externally.
- `different-safe`: intentional and low-risk difference.
- `different-risky`: difference with concrete operational/safety/compat risk.
- `missing-in-ours`: present in reference, absent in ours.
- `missing-in-ref`: present in ours, absent in reference.

### Evidence Rule
Each matrix row includes, where available for each repo:
- code anchor,
- test anchor,
- runtime/observability anchor.

## How To Use This Package
1. Start with the cross-reference matrix to understand parity by subsystem.
2. For each `different-risky` or `missing-in-ours` row, jump to the mapped recommendation ID (`XR-*`).
3. Use the migration plan execution order to sequence changes safely.
4. Use CSV/JSON artifacts to seed backlog tasks or automate issue creation.

## Scope Boundaries
- This package is docs-only analysis.
- No PRD governance docs were modified.
- Recommendations are implementation-ready but not yet executed.
