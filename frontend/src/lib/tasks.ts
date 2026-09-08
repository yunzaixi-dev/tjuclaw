import { authRequest, AuthError } from './auth';

export type TaskStatus = 'draft';

export interface Task {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  created_at: string;
}

interface TasksResponse {
  tasks: unknown;
}

interface TaskResponse {
  task: unknown;
}

const HEX_32_REGEX = /^[0-9a-f]{32}$/;

function isValidTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.id !== 'string' || !HEX_32_REGEX.test(record.id)) {
    return false;
  }

  if (typeof record.title !== 'string') {
    return false;
  }

  if (typeof record.prompt !== 'string') {
    return false;
  }

  if (record.status !== 'draft') {
    return false;
  }

  if (typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at))) {
    return false;
  }

  return true;
}

function parseTaskResponse(data: unknown): Task {
  if (!data || typeof data !== 'object') {
    throw new AuthError(503, {});
  }

  const res = data as TaskResponse;
  if (!isValidTask(res.task)) {
    throw new AuthError(503, {});
  }

  return res.task;
}

function parseTasksResponse(data: unknown): Task[] {
  if (!data || typeof data !== 'object') {
    throw new AuthError(503, {});
  }

  const res = data as TasksResponse;
  if (!Array.isArray(res.tasks)) {
    throw new AuthError(503, {});
  }

  for (const item of res.tasks) {
    if (!isValidTask(item)) {
      throw new AuthError(503, {});
    }
  }

  return res.tasks;
}

export async function listTasks(signal?: AbortSignal): Promise<Task[]> {
  const data = await authRequest<unknown>('/api/tasks', {
    method: 'GET',
    signal,
  });
  return parseTasksResponse(data);
}

export async function createTask(prompt: string, signal?: AbortSignal): Promise<Task> {
  const data = await authRequest<unknown>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
    signal,
  });
  return parseTaskResponse(data);
}

export async function getTask(id: string, signal?: AbortSignal): Promise<Task> {
  if (!HEX_32_REGEX.test(id)) {
    throw new AuthError(404, { error: { id: 'task_not_found' } });
  }

  const data = await authRequest<unknown>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'GET',
    signal,
  });
  return parseTaskResponse(data);
}

export function describeTaskError(error: unknown): string {
  if (error instanceof AuthError) {
    const errorId = error.body?.error?.id;

    if (error.status === 401) {
      return '登录状态已失效，请重新登录。';
    }

    if (error.status === 400 || errorId === 'invalid_task') {
      return '任务内容不符合要求，请检查后重试。';
    }

    if (error.status === 413 || errorId === 'request_too_large') {
      return '任务内容过长，请缩短后重试。';
    }

    if (error.status === 415 || errorId === 'unsupported_media_type') {
      return '请求格式不受���持，请刷新页面后重试。';
    }

    if (error.status === 404 || errorId === 'task_not_found') {
      return '未找到指定的任务，可能已被移除。';
    }

    if (error.status === 409 || errorId === 'task_limit_reached') {
      return '任务保存数量已达上限（最多 1000 条），无法继续保存。';
    }

    if (error.status === 503 && errorId === 'auth_not_configured') {
      return '认证服务未就绪，请稍后重试。';
    }

    if (error.status === 503 || errorId === 'task_storage_unavailable') {
      return '任务存储服务暂时不可用，请稍后重试。';
    }

    if (error.status === 429) {
      return '操作过于频繁，请稍后再试。';
    }

    if (error.status >= 500) {
      return '服务暂时不可用，请稍后重试。';
    }
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return '请求已取消。';
  }

  return '操作失败，请检查网络连接后重试。';
}
