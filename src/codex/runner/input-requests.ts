import type { CodexInputRequestPayload } from '../types';

import { asRecord, readString, type ProtocolMessage } from './common';

const NON_INTERACTIVE_TOOL_INPUT_ANSWER = 'This is a non-interactive session. Operator input is unavailable.';

function readToolCallId(message: ProtocolMessage): string {
  const params = asRecord(message.params);
  return readString(params?.call_id) ?? readString(params?.callId) ?? readString(params?.id) ?? String(message.id);
}

function readOptionalToolCallId(value: Record<string, unknown> | null): string | null {
  if (!value) {
    return null;
  }
  return readString(value.call_id) ?? readString(value.callId) ?? readString(value.id) ?? null;
}

function readResponseItem(message: ProtocolMessage): Record<string, unknown> | null {
  const params = asRecord(message.params);
  if (!params) {
    return null;
  }

  return (
    asRecord(params.item) ??
    asRecord(params.rawResponseItem) ??
    asRecord(params.raw_response_item) ??
    asRecord(params.responseItem) ??
    asRecord(params.response_item) ??
    params
  );
}

function normalizeOptionText(value: string): string {
  return value.trim().toLowerCase();
}

function optionCandidateStrings(option: Record<string, unknown> | null): string[] {
  if (!option) {
    return [];
  }
  const candidates: string[] = [];
  for (const key of ['label', 'value', 'title', 'name', 'text']) {
    const parsed = readString(option[key]);
    if (parsed) {
      candidates.push(parsed);
    }
  }
  return candidates;
}

function selectApprovalOptionLabel(options: unknown[]): string | null {
  const optionRecords = options.map((option) => asRecord(option));
  const denyPatterns = [/\bdeny\b/i, /\breject\b/i, /\bcancel\b/i, /\bblock\b/i, /\bstop\b/i, /\bno\b/i];
  const exactApprovalLabels = ['Approve this Session', 'Approve Once'];
  const permissiveApprovalPatterns = [/\bapprove\b/i, /\ballow\b/i, /\brun\b/i, /\bcontinue\b/i, /\byes\b/i, /\bok\b/i];

  for (const preferred of exactApprovalLabels) {
    for (const option of optionRecords) {
      const candidates = optionCandidateStrings(option);
      if (candidates.some((candidate) => candidate === preferred)) {
        return readString(option?.label) ?? preferred;
      }
    }
  }

  interface Candidate {
    answerLabel: string;
    rank: number;
  }

  let best: Candidate | null = null;
  for (const option of optionRecords) {
    const answerLabel = readString(option?.label);
    if (!answerLabel) {
      continue;
    }
    const candidates = optionCandidateStrings(option);
    if (candidates.length === 0) {
      continue;
    }
    if (candidates.some((candidate) => denyPatterns.some((pattern) => pattern.test(candidate)))) {
      continue;
    }

    const normalized = candidates.map(normalizeOptionText);
    let rank = Number.POSITIVE_INFINITY;
    normalized.forEach((candidate) => {
      permissiveApprovalPatterns.forEach((pattern, index) => {
        if (pattern.test(candidate) && index < rank) {
          rank = index;
        }
      });
    });
    if (!Number.isFinite(rank)) {
      continue;
    }
    if (!best || rank < best.rank) {
      best = {
        answerLabel,
        rank
      };
    }
  }

  return best?.answerLabel ?? null;
}

type NonInteractiveInputAnswerMode =
  | 'approval_option_exact'
  | 'approval_option_permissive'
  | 'non_interactive_fallback';

interface NonInteractiveInputAnswers {
  answers: Record<string, { answers: string[] }>;
  mode: NonInteractiveInputAnswerMode;
}

function buildNonInteractiveInputAnswers(params: Record<string, unknown>): NonInteractiveInputAnswers | null {
  const questions = Array.isArray(params.questions) ? params.questions : null;
  if (!questions || questions.length === 0) {
    return null;
  }

  const answers: Record<string, { answers: string[] }> = {};
  let validQuestionCount = 0;
  let usedFallback = false;
  let usedPermissiveApproval = false;

  for (const question of questions) {
    const questionRecord = asRecord(question);
    const questionId = readString(questionRecord?.id);
    if (!questionId) {
      return null;
    }

    validQuestionCount += 1;
    const options = Array.isArray(questionRecord?.options) ? questionRecord.options : null;
    const approvalLabel = options ? selectApprovalOptionLabel(options) : null;
    const answerLabel = approvalLabel ?? NON_INTERACTIVE_TOOL_INPUT_ANSWER;
    if (!approvalLabel) {
      usedFallback = true;
    } else if (approvalLabel !== 'Approve this Session' && approvalLabel !== 'Approve Once') {
      usedPermissiveApproval = true;
    }
    answers[questionId] = { answers: [answerLabel] };
  }

  if (validQuestionCount === 0) {
    return null;
  }

  if (usedFallback) {
    return { answers, mode: 'non_interactive_fallback' };
  }
  if (usedPermissiveApproval) {
    return { answers, mode: 'approval_option_permissive' };
  }

  return { answers, mode: 'approval_option_exact' };
}

function toInputRequestPayload(message: ProtocolMessage): CodexInputRequestPayload | null {
  const params = asRecord(message.params);
  if (!params || typeof message.id !== 'number') {
    return null;
  }
  const questionsRaw = Array.isArray(params.questions) ? params.questions : [];
  const questions = questionsRaw
    .map((question) => {
      const q = asRecord(question);
      const id = readString(q?.id);
      if (!id) {
        return null;
      }
      const optionsRaw = Array.isArray(q?.options) ? q.options : [];
      const options = optionsRaw
        .map((option) => {
          const o = asRecord(option);
          const label = readString(o?.label);
          if (!label) {
            return null;
          }
          const value = readString(o?.value);
          return value ? { label, value } : { label };
        })
        .filter((option): option is { label: string; value?: string } => option !== null);
      return {
        id,
        ...(readString(q?.question) ? { prompt: readString(q?.question) } : {}),
        ...(options.length > 0 ? { options } : {})
      };
    })
    .filter((question): question is { id: string; prompt?: string; options?: Array<{ label: string; value?: string }> } => question !== null);

  const promptText = readString(params.prompt) ?? readString(params.message) ?? null;
  const flattenedOptions = questions.flatMap((question) => (question.options ?? []).map((option) => option.label));
  const inputSchemaType = flattenedOptions.length > 0 ? 'options' : promptText || questions.length > 0 ? 'text' : 'unknown';

  return {
    request_id: String(message.id),
    request_method: readString(message.method) ?? 'unknown',
    prompt_text: promptText,
    questions,
    options: flattenedOptions,
    input_schema_type: inputSchemaType,
    input_required_at: new Date().toISOString()
  };
}

export { buildNonInteractiveInputAnswers, readOptionalToolCallId, readResponseItem, readToolCallId, toInputRequestPayload };
