# PRD-002 Project Layout Issue Breakdown

Parent Linear issue: NIE-126

Created: 2026-05-25

This is the implementation breakdown for SWP-005 / PRD-002 Project Layout and
Config Boundaries. The issue set is designed to move Symphony from mixed
runtime state under `.symphony/` to a clear boundary:

- committed project contract: root `WORKFLOW.md`
- ignored runtime state: `.symphony/system/`
- reserved future customization: `.symphony/skills/` and `.symphony/prompts/`

`SPEC.md` remains untouched. Any Symphony-specific extension or migration
guidance belongs in implementation docs, PRD docs, or `SPEC.ext.md` when
spec-level language is needed.

## Linear Issues

1. NIE-245 Add project layout boundary inspector and ignore analyzer
2. NIE-246 Move runtime defaults under the system state root
3. NIE-247 Narrow ignore rules and reserve project-owned customization paths
4. NIE-248 Wire layout guidance into setup and doctor
5. NIE-249 Expose effective project layout in diagnostics
6. NIE-250 Add cross-project layout smoke coverage and closure audit

## Implementation Order

NIE-245 runs first. It creates the reusable read-only inspector used by later
work.

NIE-246 and NIE-247 can run in parallel after NIE-245. NIE-246 moves resolved
runtime defaults to `.symphony/system/`; NIE-247 narrows ignore rules and adds
the guardrail that broad `.symphony/` ignores do not hide future project-owned
customization.

NIE-248 runs after NIE-245, NIE-246, and NIE-247. It wires the new layout into
setup and doctor, including safe fix behavior that may add
`.symphony/system/` but must not automatically remove broad `.symphony/`
ignores.

NIE-249 runs after NIE-245, NIE-246, and NIE-248. It exposes the effective
layout through diagnostics using the same resolved model.

NIE-250 runs last. It is the closure audit and smoke coverage ticket that maps
the final implementation back to every PRD user story and acceptance concern.

## Confidence Pass

The main loopholes and fixes are covered by the issue graph:

- Old local state must not be accidentally committed. NIE-247 keeps targeted
  legacy runtime ignores while narrowing the broad `.symphony/` rule.
- Migration must be non-destructive. NIE-246 and NIE-248 explicitly forbid
  automatic movement or deletion of old runtime directories and databases.
- Setup must be helpful but safe. NIE-248 allows adding `.symphony/system/`
  but requires guidance instead of automatically removing broad ignores.
- Future customization paths must not imply runtime loading. NIE-245, NIE-247,
  and NIE-250 keep `.symphony/skills/` and `.symphony/prompts/` reserved but
  out of MVP runtime behavior.
- Diagnostics must not invent a second source of truth. NIE-249 depends on the
  same inspector and resolved workflow model rather than duplicating path
  inference.
- Closure must prove the whole PRD, not only individual tickets. NIE-250 is
  responsible for cross-project smoke coverage and the final user-story
  mapping.

With those safeguards, the strategy is ready for implementation. Any gap found
during NIE-250 should be resolved before moving NIE-126 to done, either by
fixing the owning issue's implementation or by creating a targeted follow-up
that blocks PRD closure.
