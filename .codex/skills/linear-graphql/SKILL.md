---
name: linear-graphql
description: |
  Use the configured `linear_graphql` client tool for raw Linear GraphQL
  operations such as private upload flows, rich `bodyData`, targeted
  introspection, and rare unsupported Linear API operations.
---

# Linear GraphQL

Use this skill for raw Linear GraphQL work in projects that expose a configured
`linear_graphql` tool.

Use Linear MCP tools for routine issue-management work: issue lookup, comment
listing, workpad discovery, plain comment/workpad create or update, issue state
transitions, labels/statuses/projects, and normal link attachment when MCP can
express the operation. Reserve `linear_graphql` for operations the MCP tools
cannot perform, such as private upload flows, rich `bodyData` writes or
verification, targeted introspection, or narrowly scoped unsupported Linear API
operations.

This skill is the only supported DynamicTool exception by default. Do not use it
as a pattern for adding plugin, marketplace, realtime, filesystem, process, or
other general dynamic API behavior without a documented exception.

Do not use this skill to hand-build screenshot or screencast uploads for UI
evidence. UI evidence publication is the repository's intentional GraphQL-only
exception and must go through the script-backed publisher:

```sh
node .codex/skills/linear-ui-evidence/scripts/publish-linear-ui-evidence.js \
  --issue ABC-123 \
  --image output/playwright/screenshot.png::"Changed UI state"
```

That publisher owns private `fileUpload(makePublic:false)`, signed upload PUTs,
rich `bodyData` image/video comments, and verification by re-reading
`comment.bodyData`.

## Primary tool

Use the `linear_graphql` client tool exposed in the current session. It should
reuse the session's configured Linear auth.

Tool input:

```json
{
  "query": "query or mutation document",
  "variables": {
    "optional": "graphql variables object"
  }
}
```

Tool behavior:

- Send one GraphQL operation per tool call.
- Treat a top-level `errors` array as a failed GraphQL operation even if the
  tool call itself completed.
- Keep queries/mutations narrowly scoped; ask only for the fields you need.

## Discovering unfamiliar operations

When you need an unfamiliar mutation, input type, or object field, use targeted
introspection through `linear_graphql`.

List mutation names:

```graphql
query ListMutations {
  __type(name: "Mutation") {
    fields {
      name
    }
  }
}
```

Inspect a specific input object:

```graphql
query CommentCreateInputShape {
  __type(name: "CommentCreateInput") {
    inputFields {
      name
      type {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
}
```

## Common workflows

### Query an issue by key, identifier, or id

Use Linear MCP `get_issue` or `list_issues` for this routine read path when they
are available. Only use the raw GraphQL queries below when MCP access is
unavailable or the workflow needs fields that the MCP tools do not expose.

Use these progressively:

- Start with `issue(id: $key)` when you have a ticket key such as `MT-686`.
- Fall back to `issues(filter: ...)` when you need identifier search semantics.
- Once you have the internal issue id, prefer `issue(id: $id)` for narrower reads.

Lookup by issue key:

```graphql
query IssueByKey($key: String!) {
  issue(id: $key) {
    id
    identifier
    title
    state {
      id
      name
      type
    }
    project {
      id
      name
    }
    branchName
    url
    description
    updatedAt
    links {
      nodes {
        id
        url
        title
      }
    }
  }
}
```

Lookup by identifier filter:

```graphql
query IssueByIdentifier($identifier: String!) {
  issues(filter: { identifier: { eq: $identifier } }, first: 1) {
    nodes {
      id
      identifier
      title
      state {
        id
        name
        type
      }
      project {
        id
        name
      }
      branchName
      url
      description
      updatedAt
    }
  }
}
```

Resolve a key to an internal id:

```graphql
query IssueByIdOrKey($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
  }
}
```

Read the issue once the internal id is known:

```graphql
query IssueDetails($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    url
    description
    state {
      id
      name
      type
    }
    project {
      id
      name
    }
    attachments {
      nodes {
        id
        title
        url
        sourceType
      }
    }
  }
}
```

### Query team workflow states for an issue

Use this before changing issue state when you need the exact `stateId`:

```graphql
query IssueTeamStates($id: String!) {
  issue(id: $id) {
    id
    team {
      id
      key
      name
      states {
        nodes {
          id
          name
          type
        }
      }
    }
  }
}
```

### Create or edit a plain comment/workpad

Use Linear MCP `save_comment` for this routine write path. `save_comment` can
create a new comment with `issueId` and update an existing comment by comment
id. Do not use raw GraphQL for ordinary workpad progress, handoff notes, or
plain Markdown comment edits when `save_comment` is available.

Only use `commentCreate` or `commentUpdate` through `linear_graphql` when the
operation requires GraphQL-only fields such as rich `bodyData`.

### Move an issue to a different state

Use Linear MCP `save_issue` for routine state transitions. Only use
`issueUpdate` with the destination `stateId` when MCP cannot express the
required operation:

```graphql
mutation MoveIssueToState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue {
      id
      identifier
      state {
        id
        name
      }
    }
  }
}
```

### Attach a GitHub PR to an issue

Use Linear MCP `save_issue` links for ordinary PR URL attachment when a plain
Linear attachment is sufficient. Use the GitHub-specific attachment mutation
only when richer GitHub-specific Linear attachment metadata is required and MCP
cannot express it:

```graphql
mutation AttachGitHubPR($issueId: String!, $url: String!, $title: String) {
  attachmentLinkGitHubPR(
    issueId: $issueId
    url: $url
    title: $title
    linkKind: links
  ) {
    success
    attachment {
      id
      title
      url
    }
  }
}
```

If you only need a plain URL attachment and do not care about GitHub-specific
link metadata, use:

```graphql
mutation AttachURL($issueId: String!, $url: String!, $title: String) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
    success
    attachment {
      id
      title
      url
    }
  }
}
```

### Introspection patterns used during schema discovery

Use these when the exact field or mutation shape is unclear:

```graphql
query QueryFields {
  __type(name: "Query") {
    fields {
      name
    }
  }
}
```

```graphql
query IssueFieldArgs {
  __type(name: "Query") {
    fields {
      name
      args {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
}
```

## Usage rules

- Use Linear MCP for routine issue lookup, comment listing, workpad
  create/update, plain comment create/update, state transitions,
  labels/statuses/projects, and normal link attachment.
- Use `linear_graphql` only for private upload flows, rich `bodyData` writes or
  verification, targeted introspection, and rare unsupported Linear API
  operations.
- For Playwright screenshots or screencasts, use the `linear-ui-evidence`
  publisher instead of writing upload/comment GraphQL in the conversation.
- When raw issue lookup is unavoidable, prefer the narrowest query that matches
  what you already know: key -> identifier search -> internal id.
- When raw state transitions are unavoidable, fetch team states first and use
  the exact `stateId` instead of hardcoding names inside mutations.
- When raw PR attachment is unavoidable, prefer `attachmentLinkGitHubPR` over a
  generic URL attachment only when the richer GitHub-specific metadata is
  required.
- Keep raw GraphQL operations narrow and obvious in logs/diagnostics; do not
  build broad ad-hoc Linear clients inside workflow runs.
- Do not introduce new raw-token shell helpers for GraphQL access.
- If you need shell work for uploads, only use it for signed upload URLs
  returned by `fileUpload`; those URLs already carry the needed authorization.
