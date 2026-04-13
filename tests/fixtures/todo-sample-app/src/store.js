const todos = new Map();
let nextId = 1;

export function createTodo(title) {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed) {
    throw new Error('title is required');
  }

  const todo = {
    id: String(nextId++),
    title: trimmed,
    completed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  todos.set(todo.id, todo);
  return todo;
}

export function listTodos(status) {
  const all = Array.from(todos.values());
  if (status === 'open') {
    return all.filter((todo) => !todo.completed);
  }

  if (status === 'completed') {
    return all.filter((todo) => todo.completed);
  }

  return all;
}

export function completeTodo(id) {
  const existing = todos.get(id);
  if (!existing) {
    return null;
  }

  if (!existing.completed) {
    existing.completed = true;
    existing.updatedAt = new Date().toISOString();
  }

  return existing;
}

export function reopenTodo(id) {
  const existing = todos.get(id);
  if (!existing) {
    return null;
  }

  if (existing.completed) {
    existing.completed = false;
    existing.updatedAt = new Date().toISOString();
  }

  return existing;
}

export function deleteTodo(id) {
  return todos.delete(id);
}

export function resetStore() {
  todos.clear();
  nextId = 1;
}
