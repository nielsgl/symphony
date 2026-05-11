# PRD-006 Skill and Prompt Customization

## Problem Statement

The current Symphony workflow embeds strong internal expectations around
skills, commits, Linear workpads, pull/push/land flows, UI evidence, and
review routing. Those expectations work well for building Symphony itself, but
arbitrary projects need a way to customize skills and prompts without inheriting
Symphony-only lifecycle rules.

From the user's perspective, Symphony should provide useful defaults while
allowing project-specific workflow language, commit behavior, tracker rules,
and validation expectations to be explicit and reviewable.

## Solution

Define a skill and prompt customization model that starts with generated
`WORKFLOW.md` content, reserves `.symphony/skills/` and `.symphony/prompts/` for
future versioned project-owned customization, and uses doctor to report what it
can observe. Avoid hidden runtime inheritance in the MVP.

The MVP should make generated prompts clear and replaceable. Later work can add
project-owned skill packs once the `.symphony/system/` boundary is established.

## User Stories

1. As a project operator, I want generic commit guidance, so that projects do
   not inherit Symphony-specific commit flow by default.
2. As a project operator, I want optional Linear workpad guidance, so that teams
   using Linear can adopt it deliberately.
3. As a project operator, I want optional GitHub PR guidance, so that GitHub
   projects have useful defaults.
4. As a project operator, I want UI evidence guidance only when selected, so
   that non-UI projects are not burdened with irrelevant checks.
5. As a project operator, I want generated prompt sections to be visible in
   `WORKFLOW.md`, so that I can edit them directly.
6. As a project operator, I want project-owned prompts to be versioned later, so
   that larger teams can maintain reusable instructions.
7. As a project operator, I want project-owned skills to be versioned later, so
   that project workflows can have local operational knowledge.
8. As a project operator, I want doctor to report missing referenced prompt or
   skill files, so that customization failures are visible.
9. As a project operator, I want no hidden runtime inheritance from profile
   packs, so that runtime behavior matches the materialized workflow.
10. As a project operator, I want user-local overrides to remain personal, so
    that a teammate's preferences do not alter committed project behavior.
11. As a Symphony maintainer, I want `symphony-internal` to keep its current
    skills, so that the self-hosting workflow remains strong.
12. As a Symphony maintainer, I want generic packs to avoid internal states such
    as Agent Review and Merging unless selected, so that arbitrary projects
    start simpler.
13. As a Symphony maintainer, I want skill resolution diagnostics to avoid
    promising behavior that Codex does not actually provide, so that docs stay
    truthful.
14. As a project reviewer, I want changes to prompt and skill expectations to
    be visible in git, so that workflow behavior changes are reviewed.
15. As an external user, I want to replace the commit guidance, so that Symphony
    can match my team's conventions.
16. As an external user, I want to remove tracker-specific prompt sections, so
    that local memory or generic workflows stay clean.

## Implementation Decisions

- Treat root `WORKFLOW.md` prompt content as the MVP customization surface.
- Do not add runtime profile inheritance for prompt or skill behavior in the
  MVP.
- Reserve `.symphony/skills/` and `.symphony/prompts/` for future versioned
  project-owned customization.
- Keep `.symphony/system/` ignored so runtime state does not mix with versioned
  customization.
- Profile packs may contribute generated prompt sections during init, but those
  sections become normal workflow content after materialization.
- Initial reusable prompt concepts include generic commit guidance, GitHub PR
  guidance, Linear workpad guidance, UI evidence guidance, and generic landing
  guidance.
- `symphony-internal` keeps using the checked-in Symphony workflow and its
  current skill expectations.
- Doctor reports observable skill and prompt references and missing local files.
- Any documented skill resolution order is treated as a packaging goal until
  verified against actual Codex behavior.
- User-local skill or prompt preferences must not silently override committed
  project workflow without diagnostics.

## Testing Decisions

- Tests should verify generated workflow content and doctor diagnostics, not
  private prompt template internals.
- Unit tests cover generated prompt sections for selected tracker, workflow,
  and toolchain packs.
- Unit tests cover generic profiles excluding Symphony-specific lifecycle
  language by default.
- Unit tests cover selected advanced profiles including explicit tracker or UI
  evidence guidance.
- Doctor tests cover missing referenced prompt and skill files.
- Regression tests cover `symphony-internal` retaining current skill
  expectations.
- Snapshot-style tests may be used for prompt generation, but semantic
  assertions should guard the important behavior.

## Out of Scope

- Implementing full project-local skill loading.
- Publishing skill packs with an npm package.
- Modifying Codex global skill resolution.
- Replacing the checked-in Symphony workflow.
- Creating tracker issues from PRDs.

## Further Notes

The key boundary is honesty: generated prompts are copied into the workflow,
and runtime executes the workflow. Nothing should be hidden in profile metadata
after init.
