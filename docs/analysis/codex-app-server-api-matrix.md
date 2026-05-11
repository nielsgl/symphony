# Codex App Server API Matrix

Status: Draft

This matrix is generated from local review of:

```bash
codex app-server generate-ts --out /tmp/symphony-codex-appserver-ts --experimental
codex app-server generate-json-schema --out /tmp/symphony-codex-appserver-schema --experimental
```

Generated counts at review time:

- Client requests: 104
- Server requests: 9
- Server notifications: 64

Columns:

- **Status**: used, partially used, observed only, not used, or deferred.
- **History value**: none, low, medium, or high value for **Project Execution History**.
- **Recommendation**: harden, adopt, prototype, diagnostics only, or defer.

## Client Requests

| API | Status | Symphony usage | History value | Recommendation |
| --- | --- | --- | --- | --- |
| `initialize` | Used | Runner startup handshake. | Medium | Harden with generated-shape test. |
| `thread/start` | Used | Opens per-issue Codex thread with cwd, sandbox, approval policy, prompt context, and optional dynamic tools. | High | Harden with generated-shape test. |
| `turn/start` | Used | Starts initial, continuation, and recovery turns. | High | Harden with generated-shape test. |
| `turn/interrupt` | Used | Cancels active turn during cancellation/recovery paths. | High | Harden with lifecycle test. |
| `thread/read` | Partially used | Reads active thread metadata such as `updatedAt` for dashboard activity. | High | Keep; expand later for live inspector. |
| `thread/resume` | Not used | Could resume known Codex thread. | Medium | Defer until resume semantics are explicitly designed. |
| `thread/list` | Not used | Could enumerate Codex threads. | Medium | Diagnostics only later. |
| `thread/loaded/list` | Not used | Could inspect loaded app-server threads. | Medium | Diagnostics only later. |
| `thread/turns/list` | Not used | Could provide live turn/item inspection. | High | Adopt after ledger MVP. |
| `turn/steer` | Not used | Would let an operator steer an active turn using `expectedTurnId`. | High | Prototype later with audit trail. |
| `thread/goal/set` | Not used | Could attach issue objective and budget to Codex thread. | Medium | Prototype later. |
| `thread/goal/get` | Not used | Could read Codex thread goal status. | Medium | Prototype with goal set. |
| `thread/goal/clear` | Not used | Clears Codex thread goal metadata. | Low | Prototype only if goals are adopted. |
| `thread/metadata/update` | Not used | Could write thread metadata. | Medium | Defer until metadata ownership is clear. |
| `thread/name/set` | Not used | Could name Codex threads after issue identifiers. | Low | Low-cost later polish. |
| `thread/archive` | Not used | Archives Codex thread. | Low | Defer. |
| `thread/unarchive` | Not used | Unarchives Codex thread. | Low | Defer. |
| `thread/unsubscribe` | Not used | Stops notification subscription. | Low | Defer unless needed for long-lived app-server sessions. |
| `thread/fork` | Not used | Forks thread context. | Medium | Defer; conflicts with fresh-dispatch isolation. |
| `thread/rollback` | Not used | Rolls back thread state. | Medium | Defer; unsafe without workspace rollback semantics. |
| `thread/inject_items` | Not used | Injects items into a thread. | Medium | Defer; avoid protocol-level workflow control initially. |
| `thread/compact/start` | Not used | Starts context compaction. | High | Prototype only for long attempts after ledger. |
| `thread/memoryMode/set` | Not used | Changes Codex memory mode. | Low | Defer. |
| `memory/reset` | Not used | Resets memory. | Low | Defer. |
| `thread/increment_elicitation` | Not used | Tracks elicitation count. | Low | Defer unless app-server requires it for interactive flows. |
| `thread/decrement_elicitation` | Not used | Tracks elicitation count. | Low | Defer unless app-server requires it for interactive flows. |
| `thread/shellCommand` | Not used | Thread-scoped shell command action. | Medium | Defer; Symphony should not become a generic shell UI. |
| `thread/approveGuardianDeniedAction` | Not used | Approves guardian-denied actions. | Medium | Defer; requires explicit security policy. |
| `thread/backgroundTerminals/clean` | Not used | Cleans background terminals. | Low | Diagnostics/maintenance only later. |
| `review/start` | Not used | Native Codex review of branch/commit/uncommitted/custom target. | High | Prototype later inside Agent Review. |
| `account/rateLimits/read` | Not used | Reads current account rate-limit snapshot. | High | Diagnostics only after ledger. |
| `account/read` | Not used | Reads Codex account info. | Medium | Diagnostics only; do not gate dispatch initially. |
| `getAuthStatus` | Not used | Reads auth state. | Medium | Diagnostics only. |
| `model/list` | Not used | Lists available models. | Medium | Diagnostics only; optional validation later. |
| `modelProvider/capabilities/read` | Not used | Reads provider capabilities. | Medium | Diagnostics only. |
| `collaborationMode/list` | Not used | Lists app-server collaboration modes. | Low | Defer. |
| `experimentalFeature/list` | Not used | Lists experimental features. | Low | Diagnostics only. |
| `experimentalFeature/enablement/set` | Not used | Changes experimental feature enablement. | Low | Defer. |
| `mcpServerStatus/list` | Not used | Lists MCP server startup/status. | Medium | Diagnostics only. |
| `mcpServer/resource/read` | Not used | Reads MCP resources via app-server. | Low | Defer; use direct MCP/skills where appropriate. |
| `mcpServer/tool/call` | Not used | Calls MCP tools via app-server. | Low | Defer; avoid routing generic tool calls through Symphony. |
| `mcpServer/oauth/login` | Not used | Starts MCP OAuth login. | Low | Defer. |
| `config/mcpServer/reload` | Not used | Reloads MCP server config. | Low | Defer. |
| `skills/list` | Not used | Lists Codex-visible skills. | Medium | Diagnostics only later. |
| `skills/config/write` | Not used | Writes skill config. | Low | Defer. |
| `hooks/list` | Not used | Lists Codex hooks. | Medium | Diagnostics only later. |
| `plugin/list` | Not used | Lists plugins. | Low | Diagnostics only later. |
| `plugin/read` | Not used | Reads plugin metadata. | Low | Defer. |
| `plugin/skill/read` | Not used | Reads plugin-provided skill. | Low | Defer. |
| `plugin/install` | Not used | Installs plugin. | Low | Defer. |
| `plugin/uninstall` | Not used | Uninstalls plugin. | Low | Defer. |
| `plugin/share/save` | Not used | Saves plugin share. | None | Defer. |
| `plugin/share/updateTargets` | Not used | Updates plugin share targets. | None | Defer. |
| `plugin/share/list` | Not used | Lists plugin shares. | None | Defer. |
| `plugin/share/delete` | Not used | Deletes plugin share. | None | Defer. |
| `marketplace/add` | Not used | Adds marketplace item. | None | Defer. |
| `marketplace/remove` | Not used | Removes marketplace item. | None | Defer. |
| `marketplace/upgrade` | Not used | Upgrades marketplace item. | None | Defer. |
| `app/list` | Not used | Lists Codex apps/connectors. | Low | Diagnostics only later. |
| `account/login/start` | Not used | Starts account login. | Low | Defer; outside Symphony run orchestration. |
| `account/login/cancel` | Not used | Cancels account login. | None | Defer. |
| `account/logout` | Not used | Logs out. | None | Defer. |
| `account/sendAddCreditsNudgeEmail` | Not used | Sends account email nudge. | None | Defer. |
| `device/key/create` | Not used | Creates device key. | None | Defer. |
| `device/key/public` | Not used | Reads device public key. | None | Defer. |
| `device/key/sign` | Not used | Signs with device key. | None | Defer. |
| `fs/readFile` | Not used | App-server filesystem read. | Low | Defer; Symphony has direct workspace access. |
| `fs/writeFile` | Not used | App-server filesystem write. | Low | Defer. |
| `fs/createDirectory` | Not used | App-server directory creation. | Low | Defer. |
| `fs/getMetadata` | Not used | App-server file metadata read. | Low | Defer. |
| `fs/readDirectory` | Not used | App-server directory read. | Low | Defer. |
| `fs/remove` | Not used | App-server file removal. | Low | Defer. |
| `fs/copy` | Not used | App-server file copy. | Low | Defer. |
| `fs/watch` | Not used | App-server file watching. | Low | Defer. |
| `fs/unwatch` | Not used | Stops app-server file watching. | None | Defer. |
| `command/exec` | Not used | App-server managed command execution. | Low | Defer; avoid duplicate process orchestration. |
| `command/exec/write` | Not used | Writes to app-server command stdin. | None | Defer. |
| `command/exec/terminate` | Not used | Terminates app-server command. | None | Defer. |
| `command/exec/resize` | Not used | Resizes command PTY. | None | Defer. |
| `process/spawn` | Not used | App-server process spawn. | Low | Defer. |
| `process/writeStdin` | Not used | Writes process stdin. | None | Defer. |
| `process/kill` | Not used | Kills app-server process. | None | Defer. |
| `process/resizePty` | Not used | Resizes process PTY. | None | Defer. |
| `thread/realtime/start` | Not used | Starts realtime session. | Low | Defer. |
| `thread/realtime/appendAudio` | Not used | Sends realtime audio. | None | Defer. |
| `thread/realtime/appendText` | Not used | Sends realtime text. | None | Defer. |
| `thread/realtime/stop` | Not used | Stops realtime session. | None | Defer. |
| `thread/realtime/listVoices` | Not used | Lists realtime voices. | None | Defer. |
| `config/read` | Not used | Reads Codex config. | Medium | Diagnostics only later. |
| `config/value/write` | Not used | Writes config value. | Low | Defer. |
| `config/batchWrite` | Not used | Writes multiple config values. | Low | Defer. |
| `configRequirements/read` | Not used | Reads config requirements. | Low | Diagnostics only later. |
| `externalAgentConfig/detect` | Not used | Detects external agent config. | Low | Defer. |
| `externalAgentConfig/import` | Not used | Imports external agent config. | Low | Defer. |
| `windowsSandbox/setupStart` | Not used | Starts Windows sandbox setup. | None | Defer for macOS-focused workflow. |
| `windowsSandbox/readiness` | Not used | Checks Windows sandbox readiness. | None | Defer for macOS-focused workflow. |
| `feedback/upload` | Not used | Uploads feedback. | None | Defer. |
| `getConversationSummary` | Not used | Reads app-server conversation summary. | Medium | Consider later for archive UX, not first-slice. |
| `gitDiffToRemote` | Not used | App-server git diff helper. | Low | Defer; use local git. |
| `fuzzyFileSearch` | Not used | App-server fuzzy search. | Low | Defer. |
| `fuzzyFileSearch/sessionStart` | Not used | Starts fuzzy search session. | None | Defer. |
| `fuzzyFileSearch/sessionUpdate` | Not used | Updates fuzzy search session. | None | Defer. |
| `fuzzyFileSearch/sessionStop` | Not used | Stops fuzzy search session. | None | Defer. |
| `mock/experimentalMethod` | Not used | Experimental mock method. | None | Defer. |

## Server Requests

| API | Status | Symphony usage | History value | Recommendation |
| --- | --- | --- | --- | --- |
| `item/commandExecution/requestApproval` | Used | Auto-approves or rejects command execution according to runner policy. | High | Harden with method-specific response shape. |
| `item/fileChange/requestApproval` | Used | Handles file-change approval according to runner policy. | High | Harden with method-specific response shape. |
| `execCommandApproval` | Used | Legacy command approval compatibility path. | Medium | Keep compatibility but isolate as legacy. |
| `applyPatchApproval` | Used | Legacy patch approval compatibility path. | Medium | Keep compatibility but isolate as legacy. |
| `item/tool/requestUserInput` | Used | Non-interactive answer/blocking behavior for tool prompts. | High | Harden and record operator-required cases. |
| `mcpServer/elicitation/request` | Used | Non-interactive MCP elicitation handling. | High | Harden and record operator-required cases. |
| `item/tool/call` | Used | Dispatches supported dynamic tool calls, currently `linear_graphql`. | High | Keep allowlisted; return structured failure for unknown tools. |
| `item/permissions/requestApproval` | Not used | Requests permission profile changes. | High | Do not auto-approve; block/operator-required until policy exists. |
| `account/chatgptAuthTokens/refresh` | Not used | Requests auth token refresh. | Medium | Do not fabricate credentials; unsupported/operator-required. |

## Server Notifications

| API | Status | Symphony usage | History value | Recommendation |
| --- | --- | --- | --- | --- |
| `error` | Partially used | Protocol error visibility. | High | Ledger and promote important failures. |
| `thread/started` | Observed only | Thread lifecycle evidence. | High | Ledger; keep orchestration tied to request response. |
| `thread/status/changed` | Observed only | Thread status changes. | High | Ledger; consider dashboard status enrichment. |
| `thread/archived` | Not used | Archive state. | Low | Ledger only if seen. |
| `thread/unarchived` | Not used | Archive state. | Low | Ledger only if seen. |
| `thread/closed` | Observed only | Thread close state. | Medium | Ledger. |
| `thread/name/updated` | Not used | Thread display name. | Low | Ledger only. |
| `thread/goal/updated` | Not used | Codex goal status. | Medium | Ledger if goals are prototyped. |
| `thread/goal/cleared` | Not used | Codex goal status. | Low | Ledger if goals are prototyped. |
| `thread/tokenUsage/updated` | Used | Live token usage totals and deltas. | High | Harden and persist snapshots. |
| `turn/started` | Observed only | Turn lifecycle evidence. | High | Ledger and dashboard timeline. |
| `turn/completed` | Used | Completion and usage fallback. | High | Harden extraction and ledger. |
| `turn/diff/updated` | Not used | Live diff summary. | High | Ledger; dashboard after MVP. |
| `turn/plan/updated` | Not used | Live plan status. | High | Ledger; curated status strip. |
| `item/started` | Observed only | Item lifecycle. | High | Ledger. |
| `item/completed` | Observed only | Item lifecycle. | High | Ledger. |
| `rawResponseItem/completed` | Partially used | Protocol evidence for response items. | High | Ledger with redaction/truncation. |
| `item/agentMessage/delta` | Not used | Streaming assistant text. | Medium | Conversation archive tier, not raw default ledger. |
| `item/plan/delta` | Not used | Streaming plan text. | Medium | Ledger summary and archive tier. |
| `item/reasoning/summaryTextDelta` | Not used | Reasoning summary stream. | Medium | Redacted archive only; avoid raw default persistence. |
| `item/reasoning/summaryPartAdded` | Not used | Reasoning summary stream. | Medium | Redacted archive only. |
| `item/reasoning/textDelta` | Not used | Reasoning stream. | Low | Do not persist raw by default. |
| `item/commandExecution/outputDelta` | Not used | Command output stream. | High | Ledger summary with strict truncation/redaction. |
| `item/commandExecution/terminalInteraction` | Not used | Terminal interaction event. | Medium | Ledger. |
| `item/fileChange/outputDelta` | Not used | File-change output stream. | High | Ledger summary with redaction. |
| `item/fileChange/patchUpdated` | Not used | Patch update stream. | High | Ledger summary; raw patch retention opt-in. |
| `item/autoApprovalReview/started` | Not used | Auto-approval review lifecycle. | Medium | Ledger. |
| `item/autoApprovalReview/completed` | Not used | Auto-approval review result. | Medium | Ledger and possible alert. |
| `serverRequest/resolved` | Not used | Server request resolution. | High | Ledger for request/response latency. |
| `item/mcpToolCall/progress` | Not used | MCP progress. | Medium | Ledger and dashboard diagnostics later. |
| `mcpServer/oauthLogin/completed` | Not used | MCP OAuth completion. | Low | Ledger only. |
| `mcpServer/startupStatus/updated` | Not used | MCP startup status. | Medium | Diagnostics later. |
| `account/updated` | Not used | Account state. | Low | Diagnostics only. |
| `account/rateLimits/updated` | Partially used | Rate-limit snapshots. | High | Harden and persist snapshots. |
| `model/rerouted` | Not used | Runtime model reroute. | High | Ledger and update **Effective Model**. |
| `model/verification` | Not used | Model verification status. | Medium | Ledger and diagnostics. |
| `warning` | Not used | Generic warning. | High | Ledger and dashboard alert. |
| `guardianWarning` | Not used | Guardian/safety warning. | High | Ledger and dashboard alert. |
| `deprecationNotice` | Not used | Deprecation notice. | Medium | Ledger and dashboard alert. |
| `configWarning` | Not used | Config warning. | Medium | Ledger and dashboard alert. |
| `hook/started` | Not used | Hook lifecycle. | Medium | Diagnostics later. |
| `hook/completed` | Not used | Hook lifecycle. | Medium | Diagnostics later. |
| `skills/changed` | Not used | Skill availability change. | Low | Diagnostics later. |
| `app/list/updated` | Not used | App/connector availability. | Low | Diagnostics later. |
| `externalAgentConfig/import/completed` | Not used | External config import. | Low | Defer. |
| `fs/changed` | Not used | File watcher event. | Low | Defer. |
| `command/exec/outputDelta` | Not used | App-server command output. | Low | Defer with command APIs. |
| `process/outputDelta` | Not used | App-server process output. | Low | Defer with process APIs. |
| `process/exited` | Not used | App-server process lifecycle. | Low | Defer with process APIs. |
| `remoteControl/status/changed` | Not used | Remote-control status. | Low | Defer. |
| `thread/compacted` | Not used | Compaction result. | High | Prototype with compaction feature. |
| `fuzzyFileSearch/sessionUpdated` | Not used | Fuzzy search lifecycle. | None | Defer. |
| `fuzzyFileSearch/sessionCompleted` | Not used | Fuzzy search lifecycle. | None | Defer. |
| `thread/realtime/started` | Not used | Realtime lifecycle. | Low | Defer. |
| `thread/realtime/itemAdded` | Not used | Realtime item stream. | Low | Defer. |
| `thread/realtime/transcript/delta` | Not used | Realtime transcript. | Low | Defer. |
| `thread/realtime/transcript/done` | Not used | Realtime transcript. | Low | Defer. |
| `thread/realtime/outputAudio/delta` | Not used | Realtime audio. | None | Defer. |
| `thread/realtime/sdp` | Not used | Realtime session description. | None | Defer. |
| `thread/realtime/error` | Not used | Realtime error. | Low | Defer. |
| `thread/realtime/closed` | Not used | Realtime closed. | Low | Defer. |
| `windows/worldWritableWarning` | Not used | Windows security warning. | Low | Defer unless Windows support becomes active. |
| `windowsSandbox/setupCompleted` | Not used | Windows sandbox setup. | None | Defer. |
| `account/login/completed` | Not used | Login flow completion. | Low | Defer. |

## First-Slice Critical Shape Set

The first implementation slice should not snapshot the entire surface. It should verify only the app-server shapes Symphony relies on for safe operation:

- `InitializeParams` / `InitializeResponse`
- `ThreadStartParams`
- `TurnStartParams`
- `TurnInterruptParams`
- `ThreadReadParams` / `ThreadReadResponse`
- `SandboxMode`, `SandboxPolicy`, `AskForApproval`
- Server requests and response shapes for command approval, file approval, user input, MCP elicitation, dynamic tool call, legacy approval methods, and unsupported permission approval
- `DynamicToolSpec`, `DynamicToolCallParams`, and dynamic tool result/failure response shape if cheap
- `thread/tokenUsage/updated`, `turn/completed`, `account/rateLimits/updated`, `model/rerouted`, and warning notifications
