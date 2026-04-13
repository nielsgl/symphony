import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { completeTodo, createTodo, deleteTodo, listTodos, reopenTodo } from './store.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/todos') {
    const status = url.searchParams.get('status') || undefined;
    sendJson(res, 200, { todos: listTodos(status) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/todos') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}');
      const todo = createTodo(parsed.title);
      sendJson(res, 201, { todo });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid request' });
    }
    return;
  }

  const idMatch = /^\/todos\/([^/]+)$/.exec(url.pathname);
  if (idMatch && req.method === 'DELETE') {
    const deleted = deleteTodo(idMatch[1]);
    if (!deleted) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    sendJson(res, 200, { deleted: true });
    return;
  }

  const completeMatch = /^\/todos\/([^/]+)\/complete$/.exec(url.pathname);
  if (completeMatch && req.method === 'PATCH') {
    const todo = completeTodo(completeMatch[1]);
    if (!todo) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    sendJson(res, 200, { todo });
    return;
  }

  const reopenMatch = /^\/todos\/([^/]+)\/reopen$/.exec(url.pathname);
  if (reopenMatch && req.method === 'PATCH') {
    const todo = reopenTodo(reopenMatch[1]);
    if (!todo) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    sendJson(res, 200, { todo });
    return;
  }

  sendJson(res, 404, { error: 'route not found' });
}

export function createServer() {
  return http.createServer((req, res) => {
    void handle(req, res);
  });
}

const isDirectExecution = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isDirectExecution && process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT || 4020);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`todo sample app listening on http://127.0.0.1:${port}\n`);
  });
}
