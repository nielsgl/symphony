#!/usr/bin/env python3
"""Analyze local Codex/Symphony workflow runs from ~/.codex data.

This script is intentionally self-contained and read-only with respect to
Codex state. By default it writes outputs only under docs/workflow-analysis/.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import statistics
from collections import Counter, OrderedDict, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ISSUE_RE = re.compile(r"/(NIE-\d+)(?:/|$)|Identifier:\s*(NIE-\d+)|`(NIE-\d+)`")
COMMAND_RE = re.compile(
    r"\b(npm\s+(run\s+)?(test|build|check:meta|submit:pr-governed)|"
    r"npm\s+test|vitest|tsc|playwright|gh\s+pr\s+(checks|view|merge|diff|status)|"
    r"git\s+(status|diff|show|log|fetch|pull|merge|push|commit))\b"
)
DISCOVERY_RE = re.compile(
    r"\b(rg\s|sed\s+-n|ls\b|find\s|git\s+(status|diff|show|log)|cat\s|nl\s|wc\s|pwd\b)"
)
LINEAR_TOOLS = {
    "get_issue",
    "list_comments",
    "save_comment",
    "save_issue",
    "list_issue_statuses",
    "list_issue_labels",
    "list_issues",
}


@dataclass(frozen=True)
class DataPaths:
    codex_home: Path
    state_db: Path
    logs_db: Path
    sessions_root: Path
    archived_sessions_root: Path

    @classmethod
    def from_codex_home(cls, codex_home: Path) -> "DataPaths":
        return cls(
            codex_home=codex_home,
            state_db=codex_home / "state_5.sqlite",
            logs_db=codex_home / "logs_2.sqlite",
            sessions_root=codex_home / "sessions",
            archived_sessions_root=codex_home / "archived_sessions",
        )


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def iso_from_ms(ms: int | None) -> str | None:
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def short_path(path: Path | str, home: Path) -> str:
    text = str(path)
    prefix = str(home.parent) + "/"
    return text.replace(prefix, "~/") if text.startswith(prefix) else text


def parse_json_args(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def response_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                parts.append(stringify(item.get("text") or item.get("input_text") or ""))
            else:
                parts.append(stringify(item))
        return "".join(parts)
    return stringify(content)


def percentile(values: list[int | float], pct: float) -> int | float | None:
    if not values:
        return None
    sorted_values = sorted(values)
    k = (len(sorted_values) - 1) * pct / 100
    floor = math.floor(k)
    ceil = math.ceil(k)
    if floor == ceil:
        return sorted_values[int(k)]
    return sorted_values[floor] * (ceil - k) + sorted_values[ceil] * (k - floor)


def format_number(value: int | float) -> str:
    if isinstance(value, float) and not value.is_integer():
        return f"{value:,.2f}"
    return f"{int(value):,}"


def extract_issue(row: sqlite3.Row) -> str | None:
    text = " ".join(stringify(row[key]) for key in ("cwd", "title", "first_user_message"))
    match = ISSUE_RE.search(text)
    if not match:
        return None
    return next(group for group in match.groups() if group)


def phase_from_status(status: str | None, final_message: str) -> str:
    status_text = stringify(status).lower()
    final_text = stringify(final_message).lower()
    if "merging" in status_text or "merged" in final_text:
        return "merge"
    if "agent review" in status_text:
        return "review"
    if "human review" in status_text or "human review" in final_text:
        return "handoff"
    if "todo" in status_text or "in progress" in status_text:
        return "implementation"
    return "investigation_or_setup"


def infer_run_status(run: dict[str, Any]) -> str:
    events = run["event_counts"]
    final = stringify(run.get("final_assistant_message")).lower()
    if events.get("turn_aborted", 0) > 0 or "aborted" in final or "interrupted" in final:
        return "aborted_or_interrupted"
    if (
        "no blockers" in final
        or "no code blockers" in final
        or "merged" in final
        or "human review" in final
        or "agent review" in final
        or "done" in final
        or events.get("task_complete", 0) > 0
    ):
        return "completed_or_handoff"
    if "blocker" in final or "blocking" in final or "moved back to in progress" in final or "failed" in final:
        return "blocked_or_failed"
    if (run.get("duration_minutes") or 0) < 3 and run.get("tokens_total", 0) < 1_500_000:
        return "short_incomplete_or_retry"
    return "ambiguous_incomplete"


def load_issue_workspace_rows(paths: DataPaths, current_thread_id: str | None) -> list[sqlite3.Row]:
    connection = sqlite3.connect(paths.state_db)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        select id, rollout_path, created_at_ms, updated_at_ms, source, thread_source, archived, tokens_used,
               cwd, title, model, reasoning_effort, cli_version, first_user_message, git_branch, git_sha
        from threads
        where (? is null or id != ?)
          and cwd like '%/symphony/.symphony/workspaces/NIE-%'
        order by created_at_ms desc
        """,
        (current_thread_id, current_thread_id),
    ).fetchall()
    connection.close()
    return rows


def load_inventory(paths: DataPaths, issue_workspace_count: int, unique_issue_count: int) -> dict[str, Any]:
    connection = sqlite3.connect(paths.state_db)
    inventory = {
        "all_threads": connection.execute("select count(*) from threads").fetchone()[0],
        "symphony_cwd_threads": connection.execute(
            "select count(*) from threads where lower(cwd) like '%symphony%'"
        ).fetchone()[0],
        "symphony_issue_workspace_threads": issue_workspace_count,
        "unique_symphony_issue_tickets": unique_issue_count,
        "state_5_tables": [
            "threads",
            "thread_dynamic_tools",
            "stage1_outputs",
            "jobs",
            "agent_jobs",
            "agent_job_items",
            "thread_spawn_edges",
            "thread_goals",
        ],
        "codex_dev_db_note": (
            "codex-dev.db contains automations/inbox/local app feature state, not primary "
            "token/run metrics for this analysis."
        ),
    }
    connection.close()
    inventory["active_session_jsonl"] = sum(1 for _ in paths.sessions_root.rglob("*.jsonl"))
    inventory["archived_session_jsonl"] = (
        sum(1 for _ in paths.archived_sessions_root.rglob("*.jsonl"))
        if paths.archived_sessions_root.exists()
        else 0
    )
    if paths.logs_db.exists():
        logs_connection = sqlite3.connect(paths.logs_db)
        total_logs = logs_connection.execute("select count(*), count(thread_id) from logs").fetchone()
        inventory["logs_2_total_rows"] = total_logs[0]
        inventory["logs_2_rows_with_thread_id"] = total_logs[1]
        logs_connection.close()
    return inventory


def load_log_counts(paths: DataPaths, thread_ids: list[str]) -> dict[str, dict[str, int]]:
    if not paths.logs_db.exists() or not thread_ids:
        return {}
    connection = sqlite3.connect(paths.logs_db)
    placeholders = ",".join("?" for _ in thread_ids)
    result: dict[str, dict[str, int]] = {}
    for thread_id, rows, warnings, errors in connection.execute(
        f"""
        select thread_id, count(*), sum(level in ('WARN','WARNING')), sum(level='ERROR')
        from logs
        where thread_id in ({placeholders})
        group by thread_id
        """,
        thread_ids,
    ):
        result[thread_id] = {
            "log_rows": rows,
            "warning_rows": warnings or 0,
            "error_rows": errors or 0,
        }
    connection.close()
    return result


def parse_rollout_jsonl(path: Path, home: Path) -> dict[str, Any]:
    event_counts: Counter[str] = Counter()
    item_counts: Counter[str] = Counter()
    tool_counts: Counter[str] = Counter()
    command_counts: Counter[str] = Counter()
    command_categories: Counter[str] = Counter()
    failed_commands: list[dict[str, Any]] = []
    command_samples: list[str] = []
    evidence: list[dict[str, Any]] = []
    call_command: dict[str, str] = {}
    call_name: dict[str, str] = {}
    output_token_counts: list[int] = []
    token_usage: dict[str, Any] | None = None
    first_workflow_message = ""
    first_workflow_line: int | None = None
    final_assistant_message = ""
    final_assistant_line: int | None = None

    if not path.exists():
        return {
            "missing_rollout": True,
            "event_counts": {},
            "response_item_counts": {},
            "tool_counts": {},
            "command_counts": {},
            "command_categories": {},
            "failed_commands_sample": [],
            "commands_sample": [],
            "repeated_commands": [],
            "evidence": [],
        }

    for line_number, line in enumerate(path.open(errors="replace"), 1):
        try:
            item = json.loads(line)
        except Exception:
            continue
        payload = item.get("payload") or {}
        item_type = item.get("type")
        if item_type == "event_msg":
            event_type = payload.get("type")
            event_counts[event_type] += 1
            if (
                event_type == "token_count"
                and isinstance(payload.get("info"), dict)
                and payload["info"].get("total_token_usage")
            ):
                token_usage = dict(payload["info"]["total_token_usage"])
                token_usage.update({"line": line_number, "timestamp": item.get("timestamp")})
            if event_type in {"task_complete", "turn_aborted", "context_compacted"}:
                evidence.append(
                    {
                        "kind": event_type,
                        "source": short_path(path, home),
                        "line": line_number,
                        "timestamp": item.get("timestamp"),
                    }
                )
        elif item_type == "response_item":
            response_type = payload.get("type")
            item_counts[response_type] += 1
            if response_type == "message":
                text = response_content_text(payload.get("content"))
                if (
                    payload.get("role") == "user"
                    and not first_workflow_message
                    and ("You are working on a Linear ticket" in text or "Issue context:" in text)
                ):
                    first_workflow_message = text[:1400]
                    first_workflow_line = line_number
                if payload.get("role") == "assistant":
                    final_assistant_message = text
                    final_assistant_line = line_number
            elif response_type == "function_call":
                name = payload.get("name") or "unknown"
                tool_counts[name] += 1
                call_name[payload.get("call_id")] = name
                arguments = parse_json_args(payload.get("arguments"))
                command = arguments.get("cmd") if isinstance(arguments, dict) else None
                if name == "exec_command" and command:
                    normalized = re.sub(r"\s+", " ", stringify(command).strip())
                    call_command[payload.get("call_id")] = normalized
                    command_counts[normalized] += 1
                    if len(command_samples) < 12:
                        command_samples.append(normalized[:240])
                    if COMMAND_RE.search(normalized):
                        command_categories["validation_or_git"] += 1
                    if DISCOVERY_RE.search(normalized):
                        command_categories["discovery"] += 1
                    if "npm test" in normalized or "npm run test" in normalized or "vitest" in normalized:
                        command_categories["test"] += 1
                    if "npm run build" in normalized or re.search(r"\btsc\b", normalized):
                        command_categories["build"] += 1
                    if "check:meta" in normalized:
                        command_categories["meta_check"] += 1
                    if "playwright" in normalized or "ui-e2e-evidence" in normalized:
                        command_categories["ui_evidence"] += 1
                    if "gh pr" in normalized or "submit:pr-governed" in normalized:
                        command_categories["pr_or_merge"] += 1
                    if "git status" in normalized:
                        command_categories["git_status"] += 1
            elif response_type == "function_call_output":
                call_id = payload.get("call_id")
                output = stringify(payload.get("output"))
                exit_match = re.search(r"Process exited with code (\d+)", output)
                if call_name.get(call_id) == "exec_command" and exit_match and exit_match.group(1) != "0":
                    failed_commands.append(
                        {
                            "command": call_command.get(call_id, "<unknown exec_command>")[:300],
                            "exit_code": int(exit_match.group(1)),
                            "source": short_path(path, home),
                            "line": line_number,
                        }
                    )
                token_match = re.search(r"Original token count: (\d+)", output)
                if token_match:
                    output_token_counts.append(int(token_match.group(1)))
            elif response_type == "custom_tool_call":
                tool_counts[payload.get("name") or "custom"] += 1

    if token_usage:
        evidence.append(
            {
                "kind": "final_token_count",
                "source": short_path(path, home),
                "line": token_usage.get("line"),
                "timestamp": token_usage.get("timestamp"),
            }
        )
    if first_workflow_line:
        evidence.append({"kind": "workflow_prompt", "source": short_path(path, home), "line": first_workflow_line})
    if final_assistant_line:
        evidence.append({"kind": "final_assistant", "source": short_path(path, home), "line": final_assistant_line})

    return {
        "missing_rollout": False,
        "event_counts": dict(event_counts),
        "response_item_counts": dict(item_counts),
        "tool_counts": dict(tool_counts),
        "command_counts": dict(command_counts),
        "command_categories": dict(command_categories),
        "failed_commands_sample": failed_commands[:8],
        "commands_sample": command_samples,
        "repeated_commands": [
            {"command": command[:220], "count": count}
            for command, count in command_counts.most_common()
            if count > 1
        ][:8],
        "first_workflow_message": first_workflow_message,
        "first_user_line": first_workflow_line,
        "final_assistant_message": final_assistant_message[:1800],
        "final_assistant_line": final_assistant_line,
        "token_usage_jsonl": token_usage,
        "output_token_count_sum_from_tool_outputs": sum(output_token_counts),
        "output_token_count_max_from_tool_outputs": max(output_token_counts) if output_token_counts else 0,
        "evidence": evidence[:12],
    }


def build_run(row: sqlite3.Row, issue: str, paths: DataPaths, log_counts: dict[str, int]) -> dict[str, Any]:
    rollout_path = Path(row["rollout_path"])
    parsed = parse_rollout_jsonl(rollout_path, paths.codex_home)
    duration = None
    if row["created_at_ms"] and row["updated_at_ms"]:
        duration = round((row["updated_at_ms"] - row["created_at_ms"]) / 60000, 2)
    first_message = parsed.get("first_workflow_message") or stringify(row["first_user_message"])[:1400]
    title_match = re.search(r"Title:\s*(.+)", first_message)
    status_match = re.search(r"Current status:\s*(.+)", first_message)
    start_status = status_match.group(1).split("\n")[0].strip() if status_match else None
    final_message = parsed.get("final_assistant_message", "")
    phase = phase_from_status(start_status, final_message)
    token_usage = parsed.get("token_usage_jsonl")
    tool_counts = parsed.get("tool_counts", {})
    event_counts = parsed.get("event_counts", {})
    run = {
        "id": row["id"],
        "issue": issue,
        "rollout_path": str(rollout_path),
        "rollout_ref": short_path(rollout_path, paths.codex_home),
        "created_at_ms": row["created_at_ms"],
        "updated_at_ms": row["updated_at_ms"],
        "created_at": iso_from_ms(row["created_at_ms"]),
        "updated_at": iso_from_ms(row["updated_at_ms"]),
        "duration_minutes": duration,
        "source": row["source"],
        "thread_source": row["thread_source"],
        "archived": row["archived"],
        "tokens_total": int(row["tokens_used"] or 0),
        "cwd": row["cwd"],
        "title": row["title"],
        "model": row["model"],
        "reasoning_effort": row["reasoning_effort"],
        "cli_version": row["cli_version"],
        "first_user_message": row["first_user_message"],
        "git_branch": row["git_branch"],
        "git_sha": row["git_sha"],
        "event_counts": event_counts,
        "response_item_counts": parsed.get("response_item_counts", {}),
        "tool_counts": tool_counts,
        "exec_commands": tool_counts.get("exec_command", 0),
        "write_stdin_calls": tool_counts.get("write_stdin", 0),
        "linear_tool_calls": sum(tool_counts.get(name, 0) for name in LINEAR_TOOLS),
        "apply_patch_count": tool_counts.get("apply_patch", 0),
        "patch_apply_count": event_counts.get("patch_apply_end", 0) or tool_counts.get("apply_patch", 0),
        "mcp_tool_call_end_count": event_counts.get("mcp_tool_call_end", 0),
        "agent_messages": event_counts.get("agent_message", 0),
        "token_count_events": event_counts.get("token_count", 0),
        "context_compactions": event_counts.get("context_compacted", 0),
        "task_complete_events": event_counts.get("task_complete", 0),
        "turn_aborted_events": event_counts.get("turn_aborted", 0),
        "failed_command_count": len(parsed.get("failed_commands_sample", [])),
        "failed_commands_sample": parsed.get("failed_commands_sample", []),
        "commands_sample": parsed.get("commands_sample", []),
        "repeated_commands": parsed.get("repeated_commands", []),
        "command_categories": parsed.get("command_categories", {}),
        "first_workflow_message": first_message,
        "first_user_line": parsed.get("first_user_line"),
        "final_assistant_message": final_message,
        "final_assistant_line": parsed.get("final_assistant_line"),
        "token_usage_jsonl": token_usage,
        "issue_title": title_match.group(1).split("\n")[0].strip()
        if title_match
        else stringify(row["title"]).split("\n")[0][:120],
        "linear_status_at_start": start_status,
        "phase": phase,
        "output_token_count_sum_from_tool_outputs": parsed.get("output_token_count_sum_from_tool_outputs", 0),
        "output_token_count_max_from_tool_outputs": parsed.get("output_token_count_max_from_tool_outputs", 0),
        "evidence": parsed.get("evidence", []),
        **log_counts,
    }
    if token_usage:
        run.update(
            {
                "input_tokens": token_usage.get("input_tokens"),
                "cached_input_tokens": token_usage.get("cached_input_tokens"),
                "output_tokens": token_usage.get("output_tokens"),
                "reasoning_output_tokens": token_usage.get("reasoning_output_tokens"),
                "cache_ratio": round(
                    (token_usage.get("cached_input_tokens") or 0) / max(1, token_usage.get("input_tokens") or 0),
                    4,
                ),
            }
        )
    else:
        run.update(
            {
                "input_tokens": None,
                "cached_input_tokens": None,
                "output_tokens": None,
                "reasoning_output_tokens": None,
                "cache_ratio": None,
            }
        )
    run["run_status_inferred"] = infer_run_status(run)
    return run


def group_rows_by_issue(rows: list[sqlite3.Row]) -> OrderedDict[str, list[sqlite3.Row]]:
    grouped: OrderedDict[str, list[sqlite3.Row]] = OrderedDict()
    for row in rows:
        issue = extract_issue(row)
        if not issue:
            continue
        grouped.setdefault(issue, []).append(row)
    return grouped


def build_ticket_mode(paths: DataPaths, limit: int, current_thread_id: str | None) -> dict[str, Any]:
    rows = load_issue_workspace_rows(paths, current_thread_id)
    issue_rows = group_rows_by_issue(rows)
    selected_issues = list(issue_rows.keys())[:limit]
    selected_thread_ids = [row["id"] for issue in selected_issues for row in issue_rows[issue]]
    log_counts = load_log_counts(paths, selected_thread_ids)
    runs: list[dict[str, Any]] = []
    for issue in selected_issues:
        for row in sorted(issue_rows[issue], key=lambda item: item["created_at_ms"] or 0):
            runs.append(build_run(row, issue, paths, log_counts.get(row["id"], default_log_counts())))

    by_issue: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        by_issue[run["issue"]].append(run)
    for issue, issue_runs in by_issue.items():
        phase_counts: Counter[str] = Counter()
        for index, run in enumerate(sorted(issue_runs, key=lambda item: item["created_at"] or ""), 1):
            phase_counts[run["phase"]] += 1
            run["ticket_iteration"] = index
            run["phase_iteration"] = phase_counts[run["phase"]]

    tickets = build_ticket_summaries(selected_issues, by_issue)
    return build_metrics(paths, rows, issue_rows, tickets, runs, selected=f"{limit} tickets")


def default_log_counts() -> dict[str, int]:
    return {"log_rows": 0, "warning_rows": 0, "error_rows": 0}


def build_thread_mode(paths: DataPaths, limit: int, current_thread_id: str | None) -> dict[str, Any]:
    rows = load_issue_workspace_rows(paths, current_thread_id)[:limit]
    log_counts = load_log_counts(paths, [row["id"] for row in rows])
    runs: list[dict[str, Any]] = []
    for index, row in enumerate(reversed(rows), 1):
        issue = extract_issue(row) or "unknown"
        run = build_run(row, issue, paths, log_counts.get(row["id"], default_log_counts()))
        run["ticket_iteration"] = index
        run["phase_iteration"] = 1
        runs.append(run)
    by_issue: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        by_issue[run["issue"]].append(run)
    selected_issues = list(by_issue.keys())
    tickets = build_ticket_summaries(selected_issues, by_issue)
    all_rows = load_issue_workspace_rows(paths, current_thread_id)
    issue_rows = group_rows_by_issue(all_rows)
    return build_metrics(paths, all_rows, issue_rows, tickets, runs, selected=f"{limit} threads")


def build_ticket_summaries(
    selected_issues: list[str], by_issue: dict[str, list[dict[str, Any]]]
) -> list[dict[str, Any]]:
    tickets: list[dict[str, Any]] = []
    for ticket_rank, issue in enumerate(selected_issues, 1):
        issue_runs = sorted(by_issue[issue], key=lambda item: item["created_at"] or "")
        phase_breakdown: dict[str, dict[str, Any]] = {}
        for phase in ("implementation", "review", "merge", "handoff", "investigation_or_setup"):
            phase_runs = [run for run in issue_runs if run["phase"] == phase]
            if phase_runs:
                phase_breakdown[phase] = {
                    "iterations": len(phase_runs),
                    "tokens_total": sum(run["tokens_total"] for run in phase_runs),
                    "duration_minutes_total": round(sum(run["duration_minutes"] or 0 for run in phase_runs), 2),
                    "failed_commands": sum(run["failed_command_count"] for run in phase_runs),
                    "validation_or_git_commands": sum(
                        run["command_categories"].get("validation_or_git", 0) for run in phase_runs
                    ),
                    "discovery_commands": sum(run["command_categories"].get("discovery", 0) for run in phase_runs),
                    "thread_ids": [run["id"] for run in phase_runs],
                }
        flow = " -> ".join(run["phase"] for run in issue_runs)
        compact_flow: list[str] = []
        for phase in [run["phase"] for run in issue_runs]:
            if not compact_flow or compact_flow[-1] != phase:
                compact_flow.append(phase)
        tickets.append(
            {
                "ticket_rank_recent": ticket_rank,
                "issue": issue,
                "title": issue_runs[-1]["issue_title"] if issue_runs else "",
                "latest_created_at": max(run["created_at"] for run in issue_runs),
                "earliest_created_at": min(run["created_at"] for run in issue_runs),
                "iterations_total": len(issue_runs),
                "phase_flow": flow,
                "phase_flow_compact": " -> ".join(compact_flow),
                "tokens_total": sum(run["tokens_total"] for run in issue_runs),
                "duration_minutes_total": round(sum(run["duration_minutes"] or 0 for run in issue_runs), 2),
                "failed_commands_total": sum(run["failed_command_count"] for run in issue_runs),
                "task_complete_iterations": sum(1 for run in issue_runs if run["task_complete_events"] > 0),
                "aborted_iterations": sum(run["turn_aborted_events"] for run in issue_runs),
                "phase_breakdown": phase_breakdown,
                "thread_ids": [run["id"] for run in issue_runs],
                "evidence": [evidence for run in issue_runs for evidence in run["evidence"][:1]][:6],
            }
        )
    return tickets


def build_metrics(
    paths: DataPaths,
    all_rows: list[sqlite3.Row],
    issue_rows: OrderedDict[str, list[sqlite3.Row]],
    tickets: list[dict[str, Any]],
    runs: list[dict[str, Any]],
    selected: str,
) -> dict[str, Any]:
    ticket_tokens = [ticket["tokens_total"] for ticket in tickets]
    run_tokens = [run["tokens_total"] for run in runs]
    durations = [ticket["duration_minutes_total"] for ticket in tickets]
    by_phase: dict[str, list[dict[str, Any]]] = defaultdict(list)
    all_tools: Counter[str] = Counter()
    all_commands: Counter[str] = Counter()
    command_categories: Counter[str] = Counter()
    for run in runs:
        by_phase[run["phase"]].append(run)
        all_tools.update(run["tool_counts"])
        all_commands.update({item["command"]: item["count"] for item in run["repeated_commands"]})
        command_categories.update(run["command_categories"])

    aggregates = {
        "cohort": {
            "selection": selected,
            "ticket_count": len(tickets),
            "run_iteration_count": len(runs),
            "created_at_min": min((run["created_at"] for run in runs), default=None),
            "created_at_max": max((run["created_at"] for run in runs), default=None),
        },
        "ticket_tokens": describe_numbers(ticket_tokens),
        "run_tokens": describe_numbers(run_tokens),
        "ticket_duration_minutes": describe_numbers(durations),
        "tooling": {
            "exec_commands_total": sum(run["exec_commands"] for run in runs),
            "exec_commands_mean_per_run": round(
                statistics.mean([run["exec_commands"] for run in runs]), 2
            )
            if runs
            else 0,
            "failed_commands_total": sum(run["failed_command_count"] for run in runs),
            "apply_patch_events_total": sum(run["patch_apply_count"] for run in runs),
            "linear_tool_calls_total": sum(run["linear_tool_calls"] for run in runs),
            "task_complete_iterations": sum(1 for run in runs if run["task_complete_events"] > 0),
            "iterations_with_no_task_complete": sum(1 for run in runs if run["task_complete_events"] == 0),
            "turn_aborted_count": sum(run["turn_aborted_events"] for run in runs),
            "context_compactions_total": sum(run["context_compactions"] for run in runs),
        },
        "by_phase": {
            phase: {
                "iterations": len(phase_runs),
                "tickets_touched": len({run["issue"] for run in phase_runs}),
                "tokens_total": sum(run["tokens_total"] for run in phase_runs),
                "tokens_median_per_iteration": statistics.median([run["tokens_total"] for run in phase_runs]),
                "duration_minutes_total": round(sum(run["duration_minutes"] or 0 for run in phase_runs), 2),
                "failed_commands": sum(run["failed_command_count"] for run in phase_runs),
                "validation_or_git_commands": sum(
                    run["command_categories"].get("validation_or_git", 0) for run in phase_runs
                ),
                "discovery_commands": sum(run["command_categories"].get("discovery", 0) for run in phase_runs),
            }
            for phase, phase_runs in sorted(by_phase.items())
        },
        "command_categories": dict(command_categories),
        "top_tools": all_tools.most_common(20),
        "top_repeated_commands_global": [
            {"command": command[:240], "count": count}
            for command, count in all_commands.most_common(40)
            if count > 1
        ],
    }
    findings = {
        "ticket_token_outliers": sorted(
            [
                {
                    key: ticket[key]
                    for key in (
                        "issue",
                        "title",
                        "iterations_total",
                        "phase_flow_compact",
                        "tokens_total",
                        "duration_minutes_total",
                        "failed_commands_total",
                        "phase_breakdown",
                        "evidence",
                    )
                }
                for ticket in tickets
            ],
            key=lambda item: item["tokens_total"],
            reverse=True,
        )[:12],
        "iteration_token_outliers": sorted(
            [
                {
                    "thread_id": run["id"],
                    "issue": run["issue"],
                    "issue_title": run["issue_title"],
                    "phase": run["phase"],
                    "ticket_iteration": run.get("ticket_iteration"),
                    "phase_iteration": run.get("phase_iteration"),
                    "tokens_total": run["tokens_total"],
                    "duration_minutes": run["duration_minutes"],
                    "evidence": run["evidence"][:4],
                }
                for run in runs
            ],
            key=lambda item: item["tokens_total"],
            reverse=True,
        )[:12],
        "multi_iteration_tickets": sorted(
            [
                {
                    "issue": ticket["issue"],
                    "iterations_total": ticket["iterations_total"],
                    "phase_flow_compact": ticket["phase_flow_compact"],
                    "tokens_total": ticket["tokens_total"],
                    "duration_minutes_total": ticket["duration_minutes_total"],
                    "phase_breakdown": ticket["phase_breakdown"],
                    "thread_ids": ticket["thread_ids"],
                }
                for ticket in tickets
                if ticket["iterations_total"] > 1
            ],
            key=lambda item: (item["iterations_total"], item["tokens_total"]),
            reverse=True,
        )[:20],
    }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "data_sources": {
            "state_db": str(paths.state_db),
            "logs_db": str(paths.logs_db),
            "sessions_root": str(paths.sessions_root),
            "archived_sessions_root": str(paths.archived_sessions_root),
        },
        "inventory": load_inventory(paths, len(all_rows), len(issue_rows)),
        "aggregates": aggregates,
        "tickets": tickets,
        "runs": runs,
        "findings": findings,
    }


def describe_numbers(values: list[int | float]) -> dict[str, Any]:
    if not values:
        return {"total": 0, "mean": 0, "median": 0, "p90": None, "max": 0, "min": 0}
    return {
        "total": sum(values),
        "mean": round(statistics.mean(values), 2),
        "median": statistics.median(values),
        "p90": percentile(values, 90),
        "max": max(values),
        "min": min(values),
    }


def evidence_ref(item: dict[str, Any]) -> str:
    evidence = item.get("evidence") or []
    if not evidence:
        return ""
    first = evidence[0]
    return f"`{first['source']}:{first.get('line')}`"


def write_metrics(metrics: dict[str, Any], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "metrics.generated.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")


def write_ticket_table(metrics: dict[str, Any], out_dir: Path) -> None:
    tickets = metrics["tickets"]
    aggregates = metrics["aggregates"]
    lines = [
        "# Tickets Analyzed (Generated)\n\n",
        "Generated by `docs/workflow-analysis/scripts/analyze_codex_workflows.py`.\n\n",
        f"Totals: {len(tickets)} tickets, {aggregates['cohort']['run_iteration_count']} run iterations, "
        f"{format_number(aggregates['ticket_tokens']['total'])} recorded tokens.\n\n",
        "| # | Ticket | Title | Iterations | Phase flow | Tokens | Duration min | Failed cmds | Evidence |\n",
        "|---:|---|---|---:|---|---:|---:|---:|---|\n",
    ]
    for ticket in tickets:
        title = ticket["title"].replace("|", "/")
        lines.append(
            f"| {ticket['ticket_rank_recent']} | `{ticket['issue']}` | {title} | "
            f"{ticket['iterations_total']} | {ticket['phase_flow_compact']} | "
            f"{format_number(ticket['tokens_total'])} | {ticket['duration_minutes_total']} | "
            f"{ticket['failed_commands_total']} | {evidence_ref(ticket)} |\n"
        )
    (out_dir / "tickets-analyzed.generated.md").write_text("".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", default=str(Path.home() / ".codex"))
    parser.add_argument("--out-dir", default="docs/workflow-analysis")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--mode", choices=("tickets", "threads"), default="tickets")
    parser.add_argument("--current-thread-id", default=None)
    parser.add_argument(
        "--write",
        action="store_true",
        help="Write metrics.generated.json and tickets-analyzed.generated.md under --out-dir.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    paths = DataPaths.from_codex_home(Path(args.codex_home).expanduser())
    metrics = (
        build_ticket_mode(paths, args.limit, args.current_thread_id)
        if args.mode == "tickets"
        else build_thread_mode(paths, args.limit, args.current_thread_id)
    )
    summary = {
        "mode": args.mode,
        "tickets": metrics["aggregates"]["cohort"]["ticket_count"],
        "run_iterations": metrics["aggregates"]["cohort"]["run_iteration_count"],
        "tokens_total": metrics["aggregates"]["ticket_tokens"]["total"],
        "created_at_min": metrics["aggregates"]["cohort"]["created_at_min"],
        "created_at_max": metrics["aggregates"]["cohort"]["created_at_max"],
    }
    print(json.dumps(summary, indent=2))
    if args.write:
        out_dir = Path(args.out_dir)
        write_metrics(metrics, out_dir)
        write_ticket_table(metrics, out_dir)


if __name__ == "__main__":
    main()
