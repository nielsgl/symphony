Perfect use case. Here is a practical, end-to-end outline you can follow from a brand-new app repo, with Linear first, then GitHub Issues after validation.

You will use these guides as your source of truth:
- todo-app-end-to-end.md
- linear-workflow-playbook.md
- github-workflow-playbook.md
- integrate-your-application.md
- operations-runbook.md

## Setup Model (Important)
You now have two repos locally:
1. Your new app repo (empty except readme/gitignore)
2. Symphony repo (this one)

Symphony runs from the Symphony repo, but it points to a workflow file inside your app repo.

Also important: Symphony does not create tracker issues natively. You create issues in Linear/GitHub, then Symphony polls and dispatches work.

## Phase A: Linear First (Full Walkthrough)

1. Create baseline app in your new repo
Use the sample todo fixture as your starting code so your first run is predictable.

~~~bash
# Example paths
export APP_REPO=~/code/symfony-todo-app
export SYMPHONY_REPO=~/code/symphony

cd "$APP_REPO"
mkdir -p src test
cp "$SYMPHONY_REPO/tests/fixtures/todo-sample-app/package.json" .
cp "$SYMPHONY_REPO/tests/fixtures/todo-sample-app/src/store.js" src/
cp "$SYMPHONY_REPO/tests/fixtures/todo-sample-app/src/server.js" src/
cp "$SYMPHONY_REPO/tests/fixtures/todo-sample-app/test/server.test.js" test/
npm install
npm test
~~~

Validation checkpoint:
- Local app tests pass.
- You can run npm start and hit /health.

2. Prepare and create Linear issues automatically
Start from Symphony seed data, validate in dry-run mode, then create issues in Linear.

~~~bash
cd "$SYMPHONY_REPO"
npm run bootstrap:tracker-seeds:linear
~~~

Set Linear context for auto-seeding:

~~~bash
export LINEAR_API_KEY=your_real_key
export LINEAR_PROJECT_SLUG=SYMPHONY
# optional for multi-team projects
# export LINEAR_TEAM_KEY=SYM
~~~

Dry-run validation (recommended first):

~~~bash
npm run seed:linear
~~~

Create issues in Linear:

~~~bash
npm run seed:linear:apply
~~~

Optional output file:
~~~bash
npm run bootstrap:tracker-seeds -- \
  --tracker=linear \
  --input=tests/fixtures/tracker-seeds/linear-todo-issues.json \
  --output=/tmp/linear-import.json
~~~

Then in Linear:
- Confirm created issues are in active states used by your workflow (Todo/In Progress).
- Confirm terminal states are aligned to Done/Canceled equivalents for your team.
- If issue creation fails, re-run `npm run seed:linear` and inspect diagnostics.

3. Create workflow file in app repo
Copy the Linear preset into your app repo as WORKFLOW.md and adjust values.

Start from:
- linear-todo-workflow.md

At minimum adjust:
- tracker.project_slug
- workspace.root (recommend path inside your app repo)
- codex.command if needed

4. Configure environment
In Symphony repo, set env values (if not already exported above):

~~~bash
cd "$SYMPHONY_REPO"
export LINEAR_API_KEY=your_real_key
export SYMPHONY_OFFLINE=0
~~~

Optional:
~~~bash
export SYMPHONY_PORT=3000
~~~

5. Start Symphony against your app workflow
~~~bash
cd "$SYMPHONY_REPO"
npm install
npm run start:dashboard -- --workflow="$APP_REPO/WORKFLOW.md" --i-understand-that-this-will-be-running-without-the-usual-guardrails
~~~

Validation checkpoint:
- You see dashboard startup line.
- Service is available on http://127.0.0.1:3000

6. Monitor dispatch and run behavior
~~~bash
curl -sS http://127.0.0.1:3000/api/v1/state
curl -sS -X POST http://127.0.0.1:3000/api/v1/refresh
~~~

For issue details (example):
~~~bash
curl -sS http://127.0.0.1:3000/api/v1/SYM-101
~~~

What you want to see:
- health.dispatch_validation is ok
- running count increases when active issues exist
- retrying count stays low unless intentional failures

7. Validate generated changes in workspace
Symphony runs each issue in its issue workspace under your configured workspace root.
For your app repo, run tests after each significant run:

~~~bash
cd "$APP_REPO"
npm test
~~~

8. Close loop in Linear
- Move completed issues to terminal states.
- Trigger refresh.
- Verify they reconcile out of active running set.

~~~bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/refresh
curl -sS http://127.0.0.1:3000/api/v1/history?limit=20
~~~

9. Use operations runbook if anything fails
Follow:
- operations-runbook.md

Most common fixes:
- Missing tracker credentials
- Invalid tracker config in WORKFLOW.md
- Wrong state mapping between workflow and tracker
- codex.command unavailable in environment

## Linear Acceptance Checklist (Before Moving to GitHub)
1. Symphony starts with your app repo workflow path.
2. Linear issues are discovered.
3. At least one issue dispatches and runs.
4. App tests remain runnable after changes.
5. Completed issues reconcile when moved to terminal state.
6. History endpoint shows runs.

If all six are true, your Linear path is validated.

## Phase B: Repeat for GitHub Issues

1. Create GitHub issues from seed
~~~bash
cd "$SYMPHONY_REPO"
npm run bootstrap:tracker-seeds:github
~~~

Seed source:
- github-todo-issues.json

2. Switch workflow to GitHub preset
Start from:
- github-todo-workflow.md

Set:
- tracker.owner
- tracker.repo
- tracker.api_key using GITHUB_TOKEN
- active_states Open
- terminal_states Closed

3. Export GitHub token and run Symphony with same app repo workflow
~~~bash
cd "$SYMPHONY_REPO"
export GITHUB_TOKEN=your_real_token
npm run start:dashboard -- --workflow="$APP_REPO/WORKFLOW.md" --i-understand-that-this-will-be-running-without-the-usual-guardrails
~~~

4. Validate same checkpoints via API/dashboard
- state endpoint
- refresh endpoint
- issue detail endpoint (URL-encoded owner/repo#number)

5. Confirm known GitHub differences
- Open/Closed state model
- No native blocker modeling like Linear
- Prioritization usually label/order driven

Use:
- github-workflow-playbook.md

## Suggested execution order for you
1. Do Phase A exactly as written.
2. Pause and record observations at each checkpoint.
3. Compare observations against playbook expectations.
4. Then execute Phase B and compare again.

If you want, I can give you a copy-paste WORKFLOW.md template tailored to your exact Linear project slug and local app path first, so your first run is almost zero-friction.
