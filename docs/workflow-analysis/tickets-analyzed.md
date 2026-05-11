# Tickets Analyzed

Cohort: the 50 most recent unique Symphony `NIE-*` tickets by latest local Codex issue-workspace run. Each ticket is counted once, and its available local run iterations are broken down by phase.

Totals: 50 tickets, 195 run iterations, 945,655,203 recorded tokens, 1516.41 minutes.

## Ticket Summary

| # | Ticket | Title | Iterations | Phase flow | Tokens | Duration min | Failed cmds | Evidence |
|---:|---|---|---:|---|---:|---:|---:|---|
| 1 | `NIE-121` | Change Refresh Now button color | 2 | implementation -> review | 7,835,268 | 10.55 | 3 | `~/.codex/sessions/2026/05/10/rollout-2026-05-10T21-25-47-019e135a-559c-7580-8eb1-a906af589063.jsonl:396` |
| 2 | `NIE-78` | Show Codex app-server thread activity separately from phase age | 6 | implementation -> review -> implementation -> review -> merge | 32,683,063 | 43.94 | 4 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T11-27-40-019e01c3-a854-7c82-b9ff-90c3998f760e.jsonl:34` |
| 3 | `NIE-96` | Audit MCP-first Linear and missing-output recovery against NIE-86 and NIE-87 evidence | 2 | implementation -> merge | 14,727,900 | 26.97 | 5 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T20-15-30-019e08cd-44dd-7573-a2e8-b36b851cb99d.jsonl:560` |
| 4 | `NIE-118` | Suspend dashboard polling while SSE state stream is healthy | 3 | implementation -> review -> merge | 14,974,617 | 24.26 | 6 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T17-08-37-019e0822-2aaf-7942-9dd6-2812c8ce226d.jsonl:474` |
| 5 | `NIE-119` | Move stopped-run lineage enrichment off the primary state endpoint | 7 | implementation -> review -> implementation -> review -> implementation -> review -> merge | 21,010,571 | 40.91 | 10 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T17-08-37-019e0822-2aaf-76a0-b0f3-60fcecc9e909.jsonl:459` |
| 6 | `NIE-120` | Use a single state read for issue runtime diagnostics | 2 | implementation -> merge | 8,882,552 | 14.47 | 0 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T16-40-54-019e0808-c985-70f3-8031-af602e637118.jsonl:425` |
| 7 | `NIE-117` | Remove raw diagnostic clone cost from state snapshot hot paths | 2 | implementation -> review | 11,412,640 | 15.72 | 4 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T16-40-15-019e0808-3441-7460-9889-671f981413e2.jsonl:448` |
| 8 | `NIE-116` | Audit control-plane resilience against the 2026-05-08 overload case | 2 | implementation -> review | 12,079,906 | 13.55 | 2 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T16-17-03-019e07f2-f5bb-7a52-8641-74511dc06201.jsonl:421` |
| 9 | `NIE-115` | Add resource-aware dispatch backpressure for local agent load | 2 | implementation -> review | 21,237,668 | 23.29 | 1 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T15-51-16-019e07db-585f-7da0-9fed-225f0b85088e.jsonl:626` |
| 10 | `NIE-112` | Update dashboard to lazy-load runtime diagnostics | 3 | implementation -> review -> merge | 17,379,427 | 23.1 | 1 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T15-35-09-019e07cc-987a-7162-9e6e-afcdfdb76a73.jsonl:505` |
| 11 | `NIE-114` | Expose control-plane API latency and payload pressure | 2 | implementation -> merge | 21,380,153 | 22.68 | 1 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T15-27-45-019e07c5-d144-7b11-ac8f-1c2fc83c09fc.jsonl:642` |
| 12 | `NIE-111` | Move rich runtime diagnostics behind issue-scoped detail endpoints | 4 | implementation -> review -> implementation -> merge | 20,282,524 | 27.48 | 1 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T15-06-10-019e07b2-0ea1-7981-a7a4-42f082006c90.jsonl:479` |
| 13 | `NIE-113` | Keep SSE refresh and telemetry off the heavy snapshot path | 2 | implementation -> merge | 13,857,545 | 19.91 | 0 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T15-07-18-019e07b3-19bf-72d0-b4b6-88e16afca66d.jsonl:470` |
| 14 | `NIE-110` | Bound state snapshot API to a lightweight control-plane summary | 2 | implementation -> review | 11,852,597 | 14.21 | 2 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T14-50-02-019e07a3-4c14-7b80-8030-0fc4e3fd87ab.jsonl:464` |
| 15 | `NIE-108` | Require propagation-matrix review for cross-cutting contract changes | 2 | implementation -> review | 10,559,032 | 17.57 | 5 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T14-25-53-019e078d-2ec2-7d50-957d-49508e794461.jsonl:482` |
| 16 | `NIE-105` | Populate completed_at for terminal run history records | 2 | implementation -> merge | 14,196,767 | 18.34 | 3 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T14-14-40-019e0782-e9c6-7af1-be68-79a31760498e.jsonl:544` |
| 17 | `NIE-107` | Preserve typed termination evidence on budget resume blocks | 2 | implementation -> review | 10,717,123 | 17.25 | 3 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T14-17-34-019e0785-91fb-7f50-8a38-87c37bb9b206.jsonl:450` |
| 18 | `NIE-106` | Diagnose and eliminate persistent event record failures for Codex wait events | 2 | implementation -> merge | 16,343,528 | 19.78 | 3 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T14-15-23-019e0783-9098-7a93-b16b-0643225db1ff.jsonl:563` |
| 19 | `NIE-103` | Make worker termination outcomes typed and gate recovery on confirmed cancellation | 10 | implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review | 43,406,905 | 66.2 | 4 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T12-04-11-019e070b-7466-75a1-a737-e35e72652f74.jsonl:577` |
| 20 | `NIE-102` | Harden termination-in-progress worker exits and preserve exit lineage | 2 | implementation -> review | 22,488,559 | 22.63 | 0 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T11-21-42-019e06e4-8d7f-7252-a4fb-33823b485624.jsonl:583` |
| 21 | `NIE-104` | Preserve replacement recovery turn identity across retry diagnostics | 2 | implementation -> merge | 12,992,484 | 16.97 | 4 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T11-22-14-019e06e5-0bd1-74d3-ba25-4d43d84b4a95.jsonl:423` |
| 22 | `NIE-101` | Harden late worker lifecycle after cancellation | 4 | implementation -> review -> implementation -> review | 23,821,738 | 32.81 | 1 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T10-13-36-019e06a6-355a-77f2-a379-e277ce301046.jsonl:596` |
| 23 | `NIE-100` | Cancel Codex workers on every orchestration stop | 8 | implementation -> review -> implementation -> review | 36,219,424 | 77.67 | 8 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T08-32-42-019e0649-d4ba-75b3-b850-35665d0060b0.jsonl:530` |
| 24 | `NIE-99` | Harden terminal ownership release after completed Codex turns | 4 | implementation -> review -> merge | 13,508,375 | 21.98 | 4 | `~/.codex/sessions/2026/05/08/rollout-2026-05-08T08-00-00-019e062b-e303-7123-acb2-810f240370da.jsonl:373` |
| 25 | `NIE-95` | Record and surface missing-output recovery outcomes end to end | 9 | implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge | 45,616,589 | 70.79 | 6 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T21-24-38-019e03e6-31d6-77b3-bec2-9d30cb6f048a.jsonl:657` |
| 26 | `NIE-98` | Ingest Codex app-server task_complete as canonical turn completion | 5 | implementation -> review -> implementation -> merge | 24,283,514 | 37.8 | 2 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T22-13-08-019e0412-98c8-7dd2-b73b-fffb27dfbdb9.jsonl:510` |
| 27 | `NIE-94` | Auto-recover missing tool-output stalls with guarded same-thread continuation | 2 | implementation -> merge | 8,479,934 | 12.33 | 1 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T21-12-34-019e03db-25a1-7470-a83f-ce6a6faaeefb.jsonl:354` |
| 28 | `NIE-93` | Protect recovery attribution from external manual resume transcript activity | 3 | implementation -> review -> merge | 14,931,432 | 23.72 | 1 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T20-45-09-019e03c2-0cb0-7de3-b438-3441779d9164.jsonl:487` |
| 29 | `NIE-92` | Classify missing tool-output blockers from owned call age | 2 | implementation -> merge | 11,076,716 | 15.28 | 2 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T20-44-10-019e03c1-2624-74f3-80a1-4caccb0a3768.jsonl:407` |
| 30 | `NIE-87` | Auto-recover missing tool output by interrupting and resuming the same Codex thread | 13 | implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge | 61,875,458 | 101.07 | 10 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T17-42-50-019e031b-2267-7da1-8623-f02ef1337a85.jsonl:28` |
| 31 | `NIE-91` | Build active-run tool-call ledger from app-server and transcript evidence | 2 | implementation -> review | 11,273,745 | 14.83 | 2 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T19-49-10-019e038e-cbaf-7912-9c5a-a69dbe4933c8.jsonl:422` |
| 32 | `NIE-90` | Keep UI evidence rich-media publishing script-backed and GraphQL-only | 4 | implementation -> review -> merge | 13,324,368 | 29.15 | 3 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T18-54-30-019e035c-bf31-7632-b851-8d40de69632c.jsonl:394` |
| 33 | `NIE-89` | Make Linear workflow operations MCP-first by default | 2 | implementation -> merge | 8,002,639 | 12.44 | 1 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T18-53-52-019e035c-28e3-78b2-8b41-42778e9df1f4.jsonl:362` |
| 34 | `NIE-86` | Expire inactive worker PID quarantine records to avoid PID reuse false positives | 2 | implementation -> merge | 7,532,711 | 17.4 | 7 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T18-02-55-019e032d-871a-7d30-b540-65efa5a61f0b.jsonl:312` |
| 35 | `NIE-85` | Harden active run lineage diagnostics for stale and orphan workers | 2 | implementation -> merge | 18,497,228 | 22.36 | 1 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T17-02-16-019e02f5-fdc5-7782-b7d7-8ce154d5a385.jsonl:507` |
| 36 | `NIE-84` | Detect missing Codex function-call outputs from protocol and session evidence | 10 | implementation -> review -> implementation -> review -> implementation -> review -> implementation -> merge | 33,700,403 | 63.95 | 10 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T15-12-13-019e0291-3e19-7813-9026-f6d5111f3a50.jsonl:562` |
| 37 | `NIE-83` | Prevent duplicate dispatch across overlapping poll and refresh ticks | 4 | implementation -> review -> merge | 14,660,907 | 21.38 | 3 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T14-46-14-019e0279-745a-7cd0-80f5-f249e487e4c8.jsonl:75` |
| 38 | `NIE-82` | Suppress stale same-issue worker noise after fresh dispatch | 3 | implementation -> merge | 13,816,679 | 25.83 | 1 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T13-59-15-019e024e-6efd-7d51-85db-f09e61a3cd4a.jsonl:38` |
| 39 | `NIE-79` | Surface blocked run root cause in dashboard | 8 | implementation -> review -> implementation -> review -> merge | 16,110,434 | 36.56 | 3 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T13-01-27-019e0219-8533-7103-b7ec-fa3e00a10340.jsonl:545` |
| 40 | `NIE-81` | Detect and recover from stuck dynamic Linear tool calls | 16 | implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge -> implementation | 43,827,750 | 78.25 | 19 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T11-51-44-019e01d9-b00f-7bb3-bd3e-220bbcbd3323.jsonl:428` |
| 41 | `NIE-80` | Release stale implementation runs when issues enter Agent Review handoff state | 2 | implementation -> merge | 12,701,333 | 23.03 | 2 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T11-40-13-019e01cf-25aa-7381-89eb-0d6160c83b4b.jsonl:586` |
| 42 | `NIE-73` | Audit Agent Review handoff implementation against SPEC.ext.md | 2 | implementation -> merge | 8,398,219 | 45.29 | 2 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T10-52-53-019e01a3-cf23-7320-8b9d-b67e9aef8d48.jsonl:323` |
| 43 | `NIE-72` | Prove Agent Review lifecycle with e2e and failure-mode coverage | 3 | implementation -> merge | 15,697,117 | 19.46 | 1 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T09-47-00-019e0167-803f-7783-a893-516ed64b9655.jsonl:25` |
| 44 | `NIE-71` | Enable Agent Review workflow with handoff and fresh-dispatch semantics | 4 | implementation -> merge | 11,791,937 | 25.73 | 5 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T08-51-48-019e0134-f3aa-7883-82e5-505cddf8d772.jsonl:407` |
| 45 | `NIE-77` | Show hidden stopped runs in dashboard recovery view | 2 | implementation -> merge | 23,145,164 | 39.49 | 1 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T08-49-21-019e0132-b8ba-7962-a320-034dfbcb1ffe.jsonl:675` |
| 46 | `NIE-70` | Dispatch Agent Review as a fresh run without implementation context | 2 | implementation -> merge | 9,996,550 | 16.08 | 2 | `~/.codex/sessions/2026/05/07/rollout-2026-05-07T08-08-55-019e010d-b465-7d12-afa2-9a38e2222ca6.jsonl:421` |
| 47 | `NIE-76` | Preserve stopped-run forensics after tracker cancellation | 3 | implementation -> merge | 18,313,702 | 25.51 | 2 | `~/.codex/sessions/2026/05/06/rollout-2026-05-06T23-35-07-019dff37-4be8-71a1-85c7-a74264d7fcea.jsonl:538` |
| 48 | `NIE-74` | Block missing Codex tool output as operator-visible run | 4 | implementation -> merge | 25,495,789 | 40.4 | 11 | `~/.codex/sessions/2026/05/06/rollout-2026-05-06T22-35-41-019dff00-e3ee-78e0-a7cd-e908f0ba2967.jsonl:562` |
| 49 | `NIE-69` | Stop implementation continuation when issue reaches handoff state | 4 | implementation -> merge | 26,562,076 | 41.74 | 6 | `~/.codex/sessions/2026/05/06/rollout-2026-05-06T22-31-09-019dfefc-bab7-7e91-a257-784d1fb086aa.jsonl:449` |
| 50 | `NIE-75` | Expose console resume dynamic-tool capability gaps | 3 | implementation -> merge | 12,692,443 | 24.3 | 2 | `~/.codex/sessions/2026/05/06/rollout-2026-05-06T22-36-27-019dff01-978b-7da0-9526-95db7983ef35.jsonl:403` |

## Phase Breakdown By Ticket

### NIE-121 - Change Refresh Now button color

Phase flow: `implementation -> review`. Total: 2 iterations, 7,835,268 tokens, 10.55 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 7,496,726 | 9.4 | 2 | 39 | 46 | `019e135a-559c-7580-8eb1-a906af589063` |
| review | 1 | 338,542 | 1.15 | 1 | 6 | 5 | `019e1362-f844-78e0-952b-a533935f91d9` |

### NIE-78 - Show Codex app-server thread activity separately from phase age

Phase flow: `implementation -> implementation -> review -> implementation -> review -> merge`. Total: 6 iterations, 32,683,063 tokens, 43.94 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 3 | 28,553,025 | 33.3 | 2 | 71 | 155 | `019e01c3-a854-7c82-b9ff-90c3998f760e`<br>`019e08cd-4873-7be1-92c2-af0b6fc02a99`<br>`019e08e6-618c-7bb1-9d60-4f2c087e0d88` |
| review | 2 | 3,162,748 | 6.91 | 1 | 29 | 43 | `019e08e2-32d0-75f1-a9ca-bcb6805b7034`<br>`019e08ef-d73b-7873-9a82-53d1fe21fc07` |
| merge | 1 | 967,290 | 3.73 | 1 | 11 | 6 | `019e08f6-ca83-75c3-8cb0-c4b39ab14346` |

### NIE-96 - Audit MCP-first Linear and missing-output recovery against NIE-86 and NIE-87 evidence

Phase flow: `implementation -> merge`. Total: 2 iterations, 14,727,900 tokens, 26.97 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 11,804,570 | 22.59 | 4 | 44 | 67 | `019e08cd-44dd-7573-a2e8-b36b851cb99d` |
| merge | 1 | 2,923,330 | 4.38 | 1 | 30 | 21 | `019e08e2-32d0-7c63-9be3-d9908d9da9ea` |

### NIE-118 - Suspend dashboard polling while SSE state stream is healthy

Phase flow: `implementation -> review -> merge`. Total: 3 iterations, 14,974,617 tokens, 24.26 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 9,029,600 | 13.16 | 4 | 40 | 52 | `019e0822-2aaf-7942-9dd6-2812c8ce226d` |
| review | 1 | 1,015,122 | 2.29 | 0 | 13 | 11 | `019e082e-7bb4-7f82-80b9-63d390c47f02` |
| merge | 1 | 4,929,895 | 8.81 | 2 | 35 | 25 | `019e08c4-7a90-77c0-a110-a95336f46b15` |

### NIE-119 - Move stopped-run lineage enrichment off the primary state endpoint

Phase flow: `implementation -> review -> implementation -> review -> implementation -> review -> merge`. Total: 7 iterations, 21,010,571 tokens, 40.91 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 3 | 16,020,237 | 30.84 | 8 | 97 | 128 | `019e0822-2aaf-76a0-b0f3-60fcecc9e909`<br>`019e0851-20ca-73b3-a871-f0c299ee6e70`<br>`019e085c-6de5-7343-983a-c3a1c2784276` |
| review | 3 | 3,940,519 | 7.6 | 1 | 41 | 47 | `019e0830-628e-7ff1-af2c-36f688e1a530`<br>`019e0858-0fb7-73e1-a6d8-378d30d08c87`<br>`019e0864-3db3-7183-9fda-8c7a4f806f7d` |
| merge | 1 | 1,049,815 | 2.47 | 1 | 14 | 10 | `019e0868-f094-7842-8013-3408f6f142d7` |

### NIE-120 - Use a single state read for issue runtime diagnostics

Phase flow: `implementation -> merge`. Total: 2 iterations, 8,882,552 tokens, 14.47 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 7,134,636 | 10.74 | 0 | 35 | 40 | `019e0808-c985-70f3-8031-af602e637118` |
| merge | 1 | 1,747,916 | 3.73 | 0 | 21 | 19 | `019e0812-c712-7bf3-b6e2-5efd161476a7` |

### NIE-117 - Remove raw diagnostic clone cost from state snapshot hot paths

Phase flow: `implementation -> review`. Total: 2 iterations, 11,412,640 tokens, 15.72 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 9,524,979 | 11.51 | 2 | 29 | 61 | `019e0808-3441-7460-9889-671f981413e2` |
| review | 1 | 1,887,661 | 4.21 | 2 | 25 | 23 | `019e0812-c712-7b31-a3d6-dfc811efd530` |

### NIE-116 - Audit control-plane resilience against the 2026-05-08 overload case

Phase flow: `implementation -> review`. Total: 2 iterations, 12,079,906 tokens, 13.55 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 9,900,456 | 10.09 | 2 | 26 | 46 | `019e07f2-f5bb-7a52-8641-74511dc06201` |
| review | 1 | 2,179,450 | 3.46 | 0 | 17 | 22 | `019e07fc-4eb5-7e41-961a-c5b0b4f8b559` |

### NIE-115 - Add resource-aware dispatch backpressure for local agent load

Phase flow: `implementation -> review`. Total: 2 iterations, 21,237,668 tokens, 23.29 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 17,711,202 | 17.13 | 1 | 28 | 73 | `019e07db-585f-7da0-9fed-225f0b85088e` |
| review | 1 | 3,526,466 | 6.16 | 0 | 23 | 32 | `019e07eb-475f-7ad1-b72e-be64c37b763f` |

### NIE-112 - Update dashboard to lazy-load runtime diagnostics

Phase flow: `implementation -> review -> merge`. Total: 3 iterations, 17,379,427 tokens, 23.1 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 14,884,359 | 14.15 | 0 | 42 | 62 | `019e07cc-987a-7162-9e6e-afcdfdb76a73` |
| review | 1 | 1,282,307 | 2.77 | 0 | 10 | 19 | `019e07d9-d870-74e3-9bea-9712cc760101` |
| merge | 1 | 1,212,761 | 6.18 | 1 | 16 | 7 | `019e07e6-f923-7eb0-a5b6-a9193325fe11` |

### NIE-114 - Expose control-plane API latency and payload pressure

Phase flow: `implementation -> merge`. Total: 2 iterations, 21,380,153 tokens, 22.68 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 18,885,902 | 18.55 | 1 | 52 | 83 | `019e07c5-d144-7b11-ac8f-1c2fc83c09fc` |
| merge | 1 | 2,494,251 | 4.13 | 0 | 24 | 21 | `019e07d7-2613-7ed0-a982-2692c63da687` |

### NIE-111 - Move rich runtime diagnostics behind issue-scoped detail endpoints

Phase flow: `implementation -> review -> implementation -> merge`. Total: 4 iterations, 20,282,524 tokens, 27.48 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 2 | 17,241,980 | 21.29 | 0 | 56 | 88 | `019e07b2-0ea1-7981-a7a4-42f082006c90`<br>`019e07c0-2122-74e3-9084-654afb9e46a2` |
| review | 1 | 601,532 | 2.06 | 0 | 8 | 19 | `019e07bd-d278-7c62-a23b-cd6ba7cba2c6` |
| merge | 1 | 2,439,012 | 4.13 | 1 | 18 | 30 | `019e07c8-74a8-72e0-8c02-4994eff9df75` |

### NIE-113 - Keep SSE refresh and telemetry off the heavy snapshot path

Phase flow: `implementation -> merge`. Total: 2 iterations, 13,857,545 tokens, 19.91 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 11,339,053 | 14.16 | 0 | 36 | 49 | `019e07b3-19bf-72d0-b4b6-88e16afca66d` |
| merge | 1 | 2,518,492 | 5.75 | 0 | 19 | 21 | `019e07c0-2122-7f32-849e-7024a69f74f1` |

### NIE-110 - Bound state snapshot API to a lightweight control-plane summary

Phase flow: `implementation -> review`. Total: 2 iterations, 11,852,597 tokens, 14.21 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 10,052,386 | 11.4 | 0 | 31 | 46 | `019e07a3-4c14-7b80-8030-0fc4e3fd87ab` |
| review | 1 | 1,800,211 | 2.81 | 2 | 20 | 23 | `019e07ad-d021-71e2-ab4d-355ce6052828` |

### NIE-108 - Require propagation-matrix review for cross-cutting contract changes

Phase flow: `implementation -> review`. Total: 2 iterations, 10,559,032 tokens, 17.57 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 8,800,593 | 12.18 | 4 | 42 | 41 | `019e078d-2ec2-7d50-957d-49508e794461` |
| review | 1 | 1,758,439 | 5.39 | 1 | 22 | 17 | `019e0798-668a-7492-82a1-b63f098abb7f` |

### NIE-105 - Populate completed_at for terminal run history records

Phase flow: `implementation -> merge`. Total: 2 iterations, 14,196,767 tokens, 18.34 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 11,704,102 | 14.05 | 2 | 32 | 63 | `019e0782-e9c6-7af1-be68-79a31760498e` |
| merge | 1 | 2,492,665 | 4.29 | 1 | 24 | 19 | `019e0791-e6ef-7a32-96ec-f2069ea6c6f1` |

### NIE-107 - Preserve typed termination evidence on budget resume blocks

Phase flow: `implementation -> review`. Total: 2 iterations, 10,717,123 tokens, 17.25 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 8,139,755 | 12.03 | 3 | 29 | 54 | `019e0785-91fb-7f50-8a38-87c37bb9b206` |
| review | 1 | 2,577,368 | 5.22 | 0 | 25 | 20 | `019e0791-e6ef-77f1-bfcd-c100dbcbc25a` |

### NIE-106 - Diagnose and eliminate persistent event record failures for Codex wait events

Phase flow: `implementation -> merge`. Total: 2 iterations, 16,343,528 tokens, 19.78 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 14,535,994 | 15.36 | 2 | 37 | 55 | `019e0783-9098-7a93-b16b-0643225db1ff` |
| merge | 1 | 1,807,534 | 4.42 | 1 | 23 | 11 | `019e0791-e6e6-7d83-99e3-ea5c84b3bbc4` |

### NIE-103 - Make worker termination outcomes typed and gate recovery on confirmed cancellation

Phase flow: `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review`. Total: 10 iterations, 43,406,905 tokens, 66.2 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 5 | 34,775,046 | 52.12 | 4 | 132 | 200 | `019e070b-7466-75a1-a737-e35e72652f74`<br>`019e071d-813d-7041-8c55-f7fabf31ec5d`<br>`019e0725-6172-7800-b684-50d7d6a824b1`<br>`019e072e-bedf-7ae1-b27c-68744bf9b472`<br>`019e073d-1833-7941-9d10-19f7e709d90e` |
| review | 5 | 8,631,859 | 14.08 | 0 | 75 | 136 | `019e071b-7272-7b01-a805-0d3dbde09c59`<br>`019e0723-2dea-7060-98be-c3eaf0cdad39`<br>`019e072c-9c83-7361-a0d3-7957ac0ec553`<br>`019e073a-65d4-79a1-b291-943c37973123`<br>`019e0744-d491-7a60-94fa-bdfdfafbbd54` |

### NIE-102 - Harden termination-in-progress worker exits and preserve exit lineage

Phase flow: `implementation -> review`. Total: 2 iterations, 22,488,559 tokens, 22.63 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 19,563,425 | 18.65 | 0 | 38 | 64 | `019e06e4-8d7f-7252-a4fb-33823b485624` |
| review | 1 | 2,925,134 | 3.98 | 0 | 16 | 25 | `019e06f5-c58b-7c12-ad51-e818eadd9e93` |

### NIE-104 - Preserve replacement recovery turn identity across retry diagnostics

Phase flow: `implementation -> merge`. Total: 2 iterations, 12,992,484 tokens, 16.97 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 8,989,223 | 11.32 | 1 | 29 | 49 | `019e06e5-0bd1-74d3-ba25-4d43d84b4a95` |
| merge | 1 | 4,003,261 | 5.65 | 3 | 27 | 29 | `019e06ef-a588-7971-a538-19d4e403aee8` |

### NIE-101 - Harden late worker lifecycle after cancellation

Phase flow: `implementation -> review -> implementation -> review`. Total: 4 iterations, 23,821,738 tokens, 32.81 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 2 | 20,944,317 | 26.85 | 0 | 55 | 106 | `019e06a6-355a-77f2-a379-e277ce301046`<br>`019e06b9-78e2-7f62-9bad-32af70ee1d97` |
| review | 2 | 2,877,421 | 5.96 | 1 | 31 | 47 | `019e06b7-8529-7991-b309-7df5ffed9ff1`<br>`019e06c0-fa89-7480-8260-49f8e9f23e4a` |

### NIE-100 - Cancel Codex workers on every orchestration stop

Phase flow: `implementation -> review -> review -> implementation -> implementation -> review -> review -> review`. Total: 8 iterations, 36,219,424 tokens, 77.67 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 3 | 28,390,189 | 59.68 | 5 | 97 | 117 | `019e0649-d4ba-75b3-b850-35665d0060b0`<br>`019e065a-3030-7001-90c5-aed83f79393f`<br>`019e065e-1110-7122-a922-125a977b6acf` |
| review | 5 | 7,829,235 | 17.99 | 3 | 74 | 92 | `019e0657-c3dd-7b23-a097-cde3d44625d8`<br>`019e0657-c3fb-7b62-b8bc-dcb435e3240b`<br>`019e066e-e0b6-7012-9c14-fe3f67873d7d`<br>`019e066e-fff8-7b02-8507-f923b1ed3ac7`<br>`019e0672-40a5-78f1-b6bc-85e63a37c8e7` |

### NIE-99 - Harden terminal ownership release after completed Codex turns

Phase flow: `implementation -> review -> merge -> merge`. Total: 4 iterations, 13,508,375 tokens, 21.98 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 7,777,750 | 11.08 | 1 | 31 | 43 | `019e062b-e303-7123-acb2-810f240370da` |
| review | 1 | 684,566 | 2.08 | 1 | 13 | 24 | `019e0636-0b9a-7942-871e-954220ff61ec` |
| merge | 2 | 5,046,059 | 8.82 | 2 | 38 | 48 | `019e0636-1f3f-76f0-859f-cbadcc1c380b`<br>`019e0638-07ff-7ff1-9447-339ac52fed6f` |

### NIE-95 - Record and surface missing-output recovery outcomes end to end

Phase flow: `implementation -> review -> implementation -> review -> implementation -> review -> implementation -> review -> merge`. Total: 9 iterations, 45,616,589 tokens, 70.79 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 4 | 39,419,465 | 53.1 | 5 | 129 | 202 | `019e03e6-31d6-77b3-bec2-9d30cb6f048a`<br>`019e0409-d1e5-7701-833b-99582da74f83`<br>`019e041a-5c67-7ec3-835b-53f2283ac0b8`<br>`019e0434-c925-7822-b997-e809c61753a2` |
| review | 4 | 3,128,267 | 7.86 | 1 | 33 | 80 | `019e03f7-72e3-72c1-8df4-5e97c0639658`<br>`019e0416-a8a2-7c23-8200-8826018b31cb`<br>`019e0429-7581-7181-8ea4-5d16e3c984b5`<br>`019e043f-703d-7102-b5c6-fdd452872690` |
| merge | 1 | 3,068,857 | 9.83 | 0 | 24 | 10 | `019e0443-425a-7180-8f40-9aab35a60a16` |

### NIE-98 - Ingest Codex app-server task_complete as canonical turn completion

Phase flow: `implementation -> review -> implementation -> implementation -> merge`. Total: 5 iterations, 24,283,514 tokens, 37.8 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 3 | 17,078,409 | 26.14 | 1 | 75 | 107 | `019e0412-98c8-7dd2-b73b-fffb27dfbdb9`<br>`019e042a-f36d-7e01-a402-7bc0c19ffdfa`<br>`019e0434-c925-79d2-b743-75cb949560cd` |
| review | 1 | 2,101,451 | 4.93 | 1 | 11 | 19 | `019e0420-1aba-7713-a48f-6f4d19d0338e` |
| merge | 1 | 5,103,654 | 6.73 | 0 | 22 | 21 | `019e0437-fafa-7640-9e7d-6f9a661126d1` |

### NIE-94 - Auto-recover missing tool-output stalls with guarded same-thread continuation

Phase flow: `implementation -> merge`. Total: 2 iterations, 8,479,934 tokens, 12.33 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 6,516,309 | 9.24 | 0 | 31 | 43 | `019e03db-25a1-7470-a83f-ce6a6faaeefb` |
| merge | 1 | 1,963,625 | 3.09 | 1 | 18 | 21 | `019e03e3-7f7c-7760-8f8e-f73efb6c54ba` |

### NIE-93 - Protect recovery attribution from external manual resume transcript activity

Phase flow: `implementation -> review -> merge`. Total: 3 iterations, 14,931,432 tokens, 23.72 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 11,567,573 | 16.85 | 1 | 39 | 46 | `019e03c2-0cb0-7de3-b438-3441779d9164` |
| review | 1 | 775,963 | 2.24 | 0 | 11 | 17 | `019e03d1-8343-7552-8cec-64d21f9d6e71` |
| merge | 1 | 2,587,896 | 4.63 | 0 | 26 | 20 | `019e03d1-8343-7992-b935-f5cedbcb4417` |

### NIE-92 - Classify missing tool-output blockers from owned call age

Phase flow: `implementation -> merge`. Total: 2 iterations, 11,076,716 tokens, 15.28 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 9,743,195 | 10.42 | 2 | 32 | 44 | `019e03c1-2624-74f3-80a1-4caccb0a3768` |
| merge | 1 | 1,333,521 | 4.86 | 0 | 18 | 14 | `019e03ca-d8ec-7e10-8db9-31c8f3f168fe` |

### NIE-87 - Auto-recover missing tool output by interrupting and resuming the same Codex thread

Phase flow: `implementation -> implementation -> implementation -> review -> implementation -> review -> implementation -> implementation -> review -> review -> implementation -> review -> merge`. Total: 13 iterations, 61,875,458 tokens, 101.07 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 7 | 50,987,648 | 68.15 | 6 | 149 | 247 | `019e031b-2267-7da1-8623-f02ef1337a85`<br>`019e0324-87f7-7a62-aab1-f87ef9872dfb`<br>`019e032a-67cb-77e1-b470-d3a946f26424`<br>`019e0356-6e08-7fc0-a8d1-01243750e381`<br>`019e037a-ba92-7fa0-940e-bb72f8733128`<br>`019e037c-b2d8-7a72-8cc3-ba767a69db2c`<br>`019e038b-193f-77f2-9e54-2c59b074b177` |
| review | 5 | 8,186,099 | 27.94 | 2 | 50 | 113 | `019e0343-a9ef-7640-8501-bcf713b04f49`<br>`019e036f-a826-7aa1-824a-c158dd09383a`<br>`019e0382-4acb-7221-8944-3efd98656558`<br>`019e0382-4acb-7a21-8361-971527cd70a3`<br>`019e0393-b784-71d1-8391-3966aab39351` |
| merge | 1 | 2,701,711 | 4.98 | 2 | 27 | 18 | `019e03bb-607a-7152-b681-68a2dc26baa7` |

### NIE-91 - Build active-run tool-call ledger from app-server and transcript evidence

Phase flow: `implementation -> review`. Total: 2 iterations, 11,273,745 tokens, 14.83 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 9,082,119 | 10.94 | 2 | 29 | 50 | `019e038e-cbaf-7912-9c5a-a69dbe4933c8` |
| review | 1 | 2,191,626 | 3.89 | 0 | 19 | 22 | `019e0399-5225-7de0-bcd3-b4ae5f4043ca` |

### NIE-90 - Keep UI evidence rich-media publishing script-backed and GraphQL-only

Phase flow: `implementation -> review -> merge -> merge`. Total: 4 iterations, 13,324,368 tokens, 29.15 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 7,549,988 | 10.24 | 2 | 36 | 36 | `019e035c-bf31-7632-b851-8d40de69632c` |
| review | 1 | 582,848 | 5.97 | 0 | 11 | 7 | `019e0366-6fdc-79c2-8a0c-2d1eea4e06cb` |
| merge | 2 | 5,191,532 | 12.94 | 1 | 42 | 40 | `019e036f-a826-7652-bd10-e0b4f4588f50`<br>`019e0376-92fb-7041-a8fc-2626fdc072c5` |

### NIE-89 - Make Linear workflow operations MCP-first by default

Phase flow: `implementation -> merge`. Total: 2 iterations, 8,002,639 tokens, 12.44 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 6,328,366 | 9.05 | 1 | 30 | 40 | `019e035c-28e3-78b2-8b41-42778e9df1f4` |
| merge | 1 | 1,674,273 | 3.39 | 0 | 20 | 12 | `019e0364-b1db-7161-99c4-bcd4cc7fcc06` |

### NIE-86 - Expire inactive worker PID quarantine records to avoid PID reuse false positives

Phase flow: `implementation -> merge`. Total: 2 iterations, 7,532,711 tokens, 17.4 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 4,298,456 | 10.87 | 7 | 28 | 44 | `019e032d-871a-7d30-b540-65efa5a61f0b` |
| merge | 1 | 3,234,255 | 6.53 | 0 | 19 | 18 | `019e0338-5e01-7003-ad9d-e7dc9fb90511` |

### NIE-85 - Harden active run lineage diagnostics for stale and orphan workers

Phase flow: `implementation -> merge`. Total: 2 iterations, 18,497,228 tokens, 22.36 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 14,134,834 | 15.64 | 1 | 36 | 55 | `019e02f5-fdc5-7782-b7d7-8ce154d5a385` |
| merge | 1 | 4,362,394 | 6.72 | 0 | 22 | 22 | `019e0304-4f58-7e92-b5c0-55d952c15c5d` |

### NIE-84 - Detect missing Codex function-call outputs from protocol and session evidence

Phase flow: `implementation -> review -> review -> implementation -> review -> implementation -> review -> review -> implementation -> merge`. Total: 10 iterations, 33,700,403 tokens, 63.95 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 4 | 26,537,244 | 48.97 | 8 | 105 | 164 | `019e0291-3e19-7813-9026-f6d5111f3a50`<br>`019e02ac-2989-7670-b573-038ae82bb68b`<br>`019e02b7-7424-7383-9488-aafb9a4f2334`<br>`019e02ca-8995-7561-8661-3caea865c7c5` |
| review | 5 | 3,550,571 | 9.66 | 2 | 43 | 68 | `019e02a1-1c7a-7f71-886f-8ba1dc435138`<br>`019e02aa-34d3-7072-9699-aff62fba28b9`<br>`019e02b5-558d-7e03-b1b5-5ba04e5c77a6`<br>`019e02c2-ca24-71c3-bdc3-5299c2fce85f`<br>`019e02c8-5fb5-7a11-875d-83f01830bd7d` |
| merge | 1 | 3,612,588 | 5.32 | 0 | 29 | 21 | `019e02d2-cad6-7b60-8a46-2534d004c3ce` |

### NIE-83 - Prevent duplicate dispatch across overlapping poll and refresh ticks

Phase flow: `implementation -> implementation -> review -> merge`. Total: 4 iterations, 14,660,907 tokens, 21.38 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 2 | 12,788,306 | 15.9 | 1 | 38 | 62 | `019e0279-745a-7cd0-80f5-f249e487e4c8`<br>`019e027d-6aa7-73b2-b1dd-c45c1341cc1d` |
| review | 1 | 78,763 | 0.59 | 0 | 1 | 3 | `019e028a-62e7-7c22-9e3b-5af030df51a8` |
| merge | 1 | 1,793,838 | 4.89 | 2 | 18 | 20 | `019e028a-8b89-74f1-ba28-bba3d0015393` |

### NIE-82 - Suppress stale same-issue worker noise after fresh dispatch

Phase flow: `implementation -> implementation -> merge`. Total: 3 iterations, 13,816,679 tokens, 25.83 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 2 | 10,419,689 | 14.44 | 1 | 35 | 56 | `019e024e-6efd-7d51-85db-f09e61a3cd4a`<br>`019e024e-6efd-7c52-bf57-17b44986f285` |
| merge | 1 | 3,396,990 | 11.39 | 0 | 25 | 24 | `019e025b-0798-7003-b1d3-39bba5f2cd38` |

### NIE-79 - Surface blocked run root cause in dashboard

Phase flow: `implementation -> review -> review -> implementation -> implementation -> review -> review -> merge`. Total: 8 iterations, 16,110,434 tokens, 36.56 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 3 | 12,182,558 | 22.88 | 2 | 45 | 74 | `019e0219-8533-7103-b7ec-fa3e00a10340`<br>`019e022c-9669-70b3-b9e7-72d9a007126a`<br>`019e0238-4ce5-73f1-9a2c-de4371007f0b` |
| review | 4 | 2,818,838 | 8.61 | 0 | 53 | 55 | `019e022a-857c-7c31-b6fd-0861d5d8011e`<br>`019e022a-9b97-7153-99ff-eb9bbe2bbee4`<br>`019e023b-cc62-7d91-bfeb-a475926c2c2d`<br>`019e023b-d084-7e72-9d42-fd90872ced31` |
| merge | 1 | 1,109,038 | 5.07 | 1 | 17 | 8 | `019e023f-8c71-7302-b4db-d33dbe8052bb` |

### NIE-81 - Detect and recover from stuck dynamic Linear tool calls

Phase flow: `implementation -> review -> review -> implementation -> review -> implementation -> review -> implementation -> review -> review -> implementation -> review -> review -> review -> merge -> implementation`. Total: 16 iterations, 43,827,750 tokens, 78.25 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 6 | 30,327,606 | 48.85 | 11 | 164 | 206 | `019e01d9-b00f-7bb3-bd3e-220bbcbd3323`<br>`019e01e7-3f26-7ac0-a6c7-fab8cafac738`<br>`019e01ef-faaa-7f30-bb2c-28ff6ebc048d`<br>`019e01fc-3e53-7343-a059-136d7d7358d2`<br>`019e0207-9317-7541-b881-b7047b7c1e07`<br>`019e0210-2d54-7603-bcb7-101d22633c52` |
| review | 9 | 10,040,686 | 24.17 | 8 | 109 | 177 | `019e01e4-b09d-7072-8179-8f2be4fa8de5`<br>`019e01e5-9d50-7842-aef3-95229882d38d`<br>`019e01ee-3c2f-7380-b971-d6332316984a`<br>`019e01f9-43c0-7c93-a61a-4f20ea6bef05`<br>`019e0204-709f-7c40-8cda-f50c0152a2b4`<br>`019e0205-d043-70c3-a144-4aa18b3afcc0`<br>`019e0209-e971-7213-84c5-dd8beb3633f0`<br>`019e020c-acf1-7623-b1c1-b0159beefbfa`<br>`019e020d-3237-7472-86e6-20900996170e` |
| merge | 1 | 3,459,458 | 5.23 | 0 | 26 | 35 | `019e020d-6482-72d2-9f57-0fadd4da7acd` |

### NIE-80 - Release stale implementation runs when issues enter Agent Review handoff state

Phase flow: `implementation -> merge`. Total: 2 iterations, 12,701,333 tokens, 23.03 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 10,711,029 | 18.28 | 1 | 36 | 55 | `019e01cf-25aa-7381-89eb-0d6160c83b4b` |
| merge | 1 | 1,990,304 | 4.75 | 1 | 16 | 23 | `019e01e1-3dd5-7463-a4cd-74baa069fc72` |

### NIE-73 - Audit Agent Review handoff implementation against SPEC.ext.md

Phase flow: `implementation -> merge`. Total: 2 iterations, 8,398,219 tokens, 45.29 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 4,808,625 | 31.92 | 2 | 26 | 43 | `019e01a3-cf23-7320-8b9d-b67e9aef8d48` |
| merge | 1 | 3,589,594 | 13.37 | 0 | 20 | 19 | `019e01cc-6326-79f0-b605-27946b9bf028` |

### NIE-72 - Prove Agent Review lifecycle with e2e and failure-mode coverage

Phase flow: `implementation -> implementation -> merge`. Total: 3 iterations, 15,697,117 tokens, 19.46 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 2 | 13,966,685 | 14.71 | 1 | 33 | 54 | `019e0167-803f-7783-a893-516ed64b9655`<br>`019e017d-e468-79b0-a672-27653ee7702e` |
| merge | 1 | 1,730,432 | 4.75 | 0 | 15 | 6 | `019e018f-ca4e-7273-856a-42abbeaea53d` |

### NIE-71 - Enable Agent Review workflow with handoff and fresh-dispatch semantics

Phase flow: `implementation -> implementation -> merge -> merge`. Total: 4 iterations, 11,791,937 tokens, 25.73 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 2 | 10,449,627 | 20.49 | 4 | 51 | 59 | `019e0134-f3aa-7883-82e5-505cddf8d772`<br>`019e0148-8ad6-7113-8497-695fe8b4d489` |
| merge | 2 | 1,342,310 | 5.24 | 1 | 23 | 10 | `019e0160-7717-78a1-b5ec-81c78bc6c9d6`<br>`019e0165-2de6-7421-8476-cf40c84ee155` |

### NIE-77 - Show hidden stopped runs in dashboard recovery view

Phase flow: `implementation -> merge`. Total: 2 iterations, 23,145,164 tokens, 39.49 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 21,554,148 | 32.96 | 0 | 51 | 75 | `019e0132-b8ba-7962-a320-034dfbcb1ffe` |
| merge | 1 | 1,591,016 | 6.53 | 1 | 16 | 11 | `019e0157-ebd2-7360-bbab-20a353f482c5` |

### NIE-70 - Dispatch Agent Review as a fresh run without implementation context

Phase flow: `implementation -> merge`. Total: 2 iterations, 9,996,550 tokens, 16.08 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 1 | 9,043,999 | 12.23 | 0 | 32 | 49 | `019e010d-b465-7d12-afa2-9a38e2222ca6` |
| merge | 1 | 952,551 | 3.85 | 2 | 15 | 8 | `019e0132-5b99-7ed1-85e0-69c2819b9065` |

### NIE-76 - Preserve stopped-run forensics after tracker cancellation

Phase flow: `implementation -> implementation -> merge`. Total: 3 iterations, 18,313,702 tokens, 25.51 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 2 | 17,197,576 | 21.71 | 2 | 64 | 102 | `019dff37-4be8-71a1-85c7-a74264d7fcea`<br>`019e010b-cd58-74f0-a02e-27c6e388832f` |
| merge | 1 | 1,116,126 | 3.8 | 0 | 15 | 6 | `019e012f-caaa-7b13-9ce2-dc18309aab12` |

### NIE-74 - Block missing Codex tool output as operator-visible run

Phase flow: `implementation -> implementation -> implementation -> merge`. Total: 4 iterations, 25,495,789 tokens, 40.4 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 3 | 24,348,322 | 36.77 | 11 | 98 | 163 | `019dff00-e3ee-78e0-a7cd-e908f0ba2967`<br>`019dff14-4476-7302-8b74-9577c5a56bfa`<br>`019dff1f-1d9d-73b2-98d8-bcba00646cd6` |
| merge | 1 | 1,147,467 | 3.63 | 0 | 17 | 6 | `019dff34-51e7-7700-b238-0ca9dc3b2c8b` |

### NIE-69 - Stop implementation continuation when issue reaches handoff state

Phase flow: `implementation -> implementation -> merge -> merge`. Total: 4 iterations, 26,562,076 tokens, 41.74 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 2 | 21,086,537 | 29.23 | 4 | 75 | 106 | `019dfefc-bab7-7e91-a257-784d1fb086aa`<br>`019dff0c-e95b-7231-841e-8368ea0b3b1d` |
| merge | 2 | 5,475,539 | 12.51 | 2 | 50 | 43 | `019dff1e-80f9-7703-a10f-f47ad9f1ebab`<br>`019dff31-200c-73c3-94e3-7a4636bae0c1` |

### NIE-75 - Expose console resume dynamic-tool capability gaps

Phase flow: `implementation -> implementation -> merge`. Total: 3 iterations, 12,692,443 tokens, 24.3 minutes.

| Phase | Iterations | Tokens | Duration min | Failed cmds | Validation/git cmds | Discovery cmds | Thread ids |
|---|---:|---:|---:|---:|---:|---:|---|
| implementation | 2 | 10,297,306 | 19.86 | 2 | 49 | 89 | `019dff01-978b-7da0-9526-95db7983ef35`<br>`019dff10-145e-76e2-830b-652e329059a7` |
| merge | 1 | 2,395,137 | 4.44 | 0 | 19 | 6 | `019dff18-6c69-7e63-b347-88d525bc7370` |
