import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { resetStore } from '../src/store.js';

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const data = await response.json();
  return { response, data };
}

test('create, list, complete, reopen, delete todo lifecycle', async () => {
  resetStore();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const create = await requestJson(baseUrl, '/todos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Write tutorial docs' })
  });
  assert.equal(create.response.status, 201);
  const todoId = create.data.todo.id;

  const listOpen = await requestJson(baseUrl, '/todos?status=open');
  assert.equal(listOpen.response.status, 200);
  assert.equal(listOpen.data.todos.length, 1);

  const completed = await requestJson(baseUrl, `/todos/${todoId}/complete`, { method: 'PATCH' });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.data.todo.completed, true);

  const listCompleted = await requestJson(baseUrl, '/todos?status=completed');
  assert.equal(listCompleted.response.status, 200);
  assert.equal(listCompleted.data.todos.length, 1);

  const reopened = await requestJson(baseUrl, `/todos/${todoId}/reopen`, { method: 'PATCH' });
  assert.equal(reopened.response.status, 200);
  assert.equal(reopened.data.todo.completed, false);

  const deleted = await requestJson(baseUrl, `/todos/${todoId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);

  const empty = await requestJson(baseUrl, '/todos');
  assert.equal(empty.response.status, 200);
  assert.equal(empty.data.todos.length, 0);

  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
