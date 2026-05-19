import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';

describe('SqlitePersistenceStore token facts', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);
  it('persists token and effective model facts across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-token-model-fact-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-token-model-1', issue_identifier: 'TOK-1' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const started = storeA.recordRunStarted({
      issue_id: 'remote-token-model-1',
      issue_identifier: 'TOK-1',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const threadId = storeA.appendThread({
      attempt_id: started.attempt_id,
      thread_id: 'thread-token-model',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    const turnId = storeA.appendTurn({
      thread_id: threadId,
      turn_id: 'turn-token-model',
      turn_index: 0,
      started_at: '2026-04-11T10:00:03.000Z',
      status: 'running'
    });
    storeA.appendTokenModelFact({
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      requested_model: 'gpt-requested',
      effective_model: 'gpt-effective',
      model_source: 'thread/tokenUsage/updated.params.tokenUsage.total',
      input_tokens: 10,
      output_tokens: 4,
      cached_input_tokens: 3,
      reasoning_output_tokens: 2,
      total_tokens: 14,
      model_context_window: 128000,
      telemetry_confidence: 'observed_live',
      observed_at: '2026-04-11T10:00:04.000Z'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);

    expect(storeB.reconstructThreadLineage(threadId)?.token_model_facts).toEqual([
      expect.objectContaining({
        issue_run_id: started.issue_run_id,
        attempt_id: started.attempt_id,
        thread_id: threadId,
        turn_id: turnId,
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        model_source: 'thread/tokenUsage/updated.params.tokenUsage.total',
        input_tokens: 10,
        output_tokens: 4,
        cached_input_tokens: 3,
        reasoning_output_tokens: 2,
        total_tokens: 14,
        model_context_window: 128000,
        telemetry_confidence: 'observed_live',
        observed_at: '2026-04-11T10:00:04.000Z'
      })
    ]);
    expect(storeB.reconstructThreadLineage(threadId)?.turns[0]?.token_model_facts).toHaveLength(1);
    expect(storeB.reconstructTicketTimeline(durableIdentity).token_model_facts).toHaveLength(1);
    expect(storeB.listRunHistory().find((run) => run.run_id === started.run_id)?.token_model_facts).toEqual([
      expect.objectContaining({
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        total_tokens: 14
      })
    ]);
  });

  it('scopes run history token model facts to each issue run across repeated ticket runs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-token-model-run-scope-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-token-model-repeat', issue_identifier: 'TOK-REPEAT' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const first = storeA.recordRunStarted({
      issue_id: 'remote-token-model-repeat',
      issue_identifier: 'TOK-REPEAT',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const firstThreadId = storeA.appendThread({
      attempt_id: first.attempt_id,
      thread_id: 'thread-token-model-first',
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    storeA.appendTokenModelFact({
      issue_run_id: first.issue_run_id,
      attempt_id: first.attempt_id,
      thread_id: firstThreadId,
      requested_model: 'gpt-first-requested',
      effective_model: 'gpt-first-effective',
      total_tokens: 11,
      telemetry_confidence: 'observed_live',
      observed_at: '2026-04-11T10:00:02.000Z'
    });

    const second = storeA.recordRunStarted({
      issue_id: 'remote-token-model-repeat',
      issue_identifier: 'TOK-REPEAT',
      identity: durableIdentity,
      started_at: '2026-04-11T11:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const secondThreadId = storeA.appendThread({
      attempt_id: second.attempt_id,
      thread_id: 'thread-token-model-second',
      started_at: '2026-04-11T11:00:01.000Z',
      status: 'running'
    });
    storeA.appendTokenModelFact({
      issue_run_id: second.issue_run_id,
      attempt_id: second.attempt_id,
      thread_id: secondThreadId,
      requested_model: 'gpt-second-requested',
      effective_model: 'gpt-second-effective',
      total_tokens: 22,
      telemetry_confidence: 'observed_live',
      observed_at: '2026-04-11T11:00:02.000Z'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const firstRun = storeB.listRunHistory(10).find((run) => run.run_id === first.run_id);
    const secondRun = storeB.listRunHistory(10).find((run) => run.run_id === second.run_id);

    expect(firstRun?.identity_projection?.issue_run_id).toBe(first.issue_run_id);
    expect(secondRun?.identity_projection?.issue_run_id).toBe(second.issue_run_id);
    expect(firstRun?.token_model_facts).toEqual([
      expect.objectContaining({
        issue_run_id: first.issue_run_id,
        requested_model: 'gpt-first-requested',
        effective_model: 'gpt-first-effective',
        total_tokens: 11
      })
    ]);
    expect(secondRun?.token_model_facts).toEqual([
      expect.objectContaining({
        issue_run_id: second.issue_run_id,
        requested_model: 'gpt-second-requested',
        effective_model: 'gpt-second-effective',
        total_tokens: 22
      })
    ]);
  });

  it('rejects malformed token telemetry without writing a partial fact', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-token-model-invalid-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-token-model-2', issue_identifier: 'TOK-2' });

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const issueRunId = store.appendIssueRun({
      issue_id: 'remote-token-model-2',
      issue_identifier: 'TOK-2',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });

    expect(() =>
      store.appendTokenModelFact({
        issue_run_id: issueRunId,
        input_tokens: -1,
        telemetry_confidence: 'observed_live',
        observed_at: '2026-04-11T10:00:01.000Z'
      })
    ).toThrow('input_tokens must be a non-negative safe integer');
    expect(store.reconstructTicketTimeline(durableIdentity).token_model_facts).toEqual([]);
  });


});
