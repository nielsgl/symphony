# Todo Sample App Fixture

This is a small runnable fixture used by Symphony workflow tutorials.

## Features

- Create todo
- List todos (all/open/completed)
- Complete todo
- Reopen todo
- Delete todo

## Run Locally

```bash
cd tests/fixtures/todo-sample-app
npm start
```

Server default:

- http://127.0.0.1:4020

## Test

```bash
cd tests/fixtures/todo-sample-app
npm test
```

## How It Fits Symphony Tutorials

- Tracker issue seeds describe incremental work items for this app.
- Workflow presets instruct Codex to implement and test issue-scope changes.
- Symphony workspace lifecycle can be observed clearly with this small codebase.
