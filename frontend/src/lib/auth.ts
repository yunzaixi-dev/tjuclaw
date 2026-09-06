export type AuthKind = 'login' | 'registration' | 'verification';
export type IdentitySession = {
  id: string;
  email: string;
  email_verified: boolean;
  expires_at: string;
};
export type Message = { id: number; text: string; type: string };
export type FlowNode = {
  group: string;
  attributes: { name?: string; type?: string; value?: string; disabled?: boolean; required?: boolean };
  messages?: Message[];
};
export type Flow = {
  id: string;
  state?: string;
  expires_at: string;
  ui: { action: string; method: string; nodes: FlowNode[]; messages?: Message[] };
};
type ErrorBody = { error?: { id?: string }; redirect_browser_to?: string; ui?: Flow['ui']; id?: string };

export class AuthError extends Error {
  constructor(public status: number, public body: ErrorBody) {
    super(body.error?.id || 'auth_request_failed');
  }
}

// No bearer/session tokens in browser storage. Kratos owns the HttpOnly cookie.
export async function authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('Invalid API path');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(abort, 15000);
  try {
    const response = await fetch(path, {
      ...init, signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    const body = response.status === 204 ? {} : await response.json().catch(() => {
      // Proxies may return HTML error pages; keep their HTTP status for retry UX.
      throw new AuthError(response.ok ? 503 : response.status, {});
    });
    if (!response.ok) throw new AuthError(response.status, body);
    return body as T;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

export async function readSession(signal?: AbortSignal): Promise<IdentitySession | null> {
  try {
    const session = await authRequest<IdentitySession>('/api/auth/session', { signal });
    if (!session || typeof session.id !== 'string' || typeof session.email !== 'string' ||
      typeof session.email_verified !== 'boolean' || !Number.isFinite(Date.parse(session.expires_at))) {
      throw new AuthError(503, {});
    }
    return session;
  }
  catch (error) { if (error instanceof AuthError && error.status === 401) return null; throw error; }
}

export function validateFlow(flow: Flow) {
  if (!flow || typeof flow.id !== 'string' || !Number.isFinite(Date.parse(flow.expires_at)) ||
    typeof flow.ui?.action !== 'string' || typeof flow.ui?.method !== 'string' ||
    !Array.isArray(flow.ui.nodes) || !flow.ui.nodes.every(node => node && typeof node.attributes === 'object' && node.attributes !== null)) {
    throw new AuthError(503, {});
  }
}

export function flowPath(kind: AuthKind, id?: string) {
  return `/api/kratos/self-service/${kind}/${id ? `flows?id=${encodeURIComponent(id)}` : 'browser'}`;
}

export function actionPath(flow: Flow, kind: AuthKind) {
  const url = new URL(flow.ui.action, location.origin);
  if (url.origin !== location.origin || url.pathname !== `/api/kratos/self-service/${kind}` ||
    url.searchParams.get('flow') !== flow.id || flow.ui.method.toLowerCase() !== 'post') {
    throw new Error('Unexpected authentication action');
  }
  return url.pathname + url.search;
}

export function flowMessages(flow: Flow): Message[] {
  return [...(flow.ui.messages || []), ...flow.ui.nodes.flatMap(n => n.messages || [])];
}

export function describeError(error: unknown) {
  if (!(error instanceof AuthError)) return '暂时连接不上认证服务。请检查网络后重试。';
  if (error.status === 410 || error.status === 404) return '这次验证已过期或失效，请重新开始。';
  if (error.status === 429) return '操作有些频繁，请稍后再试。';
  if (error.status === 403) return '安全校验未通过，请在当前浏览器重新开始。';
  if (error.status >= 500) return '认证服务暂时不可用。你的信息没有丢失，请稍后重试。';
  return '暂时无法完成这次验证，请重新开始。';
}

export function safeAuthRedirect(value: string) {
  const url = new URL(value, location.origin);
  if (url.origin !== location.origin || !/^\/auth\/(login|registration|verification|complete|logged-out|error)$/.test(url.pathname)) {
    throw new Error('Unexpected authentication redirect');
  }
  return url.pathname + url.search;
}

export async function logout() {
  const result = await authRequest<{ logout_url: string }>('/api/kratos/self-service/logout/browser');
  const url = new URL(result.logout_url, location.origin);
  if (url.origin !== location.origin || url.pathname !== '/api/kratos/self-service/logout' || !url.searchParams.has('token')) {
    throw new Error('Unexpected logout URL');
  }
  await authRequest(url.pathname + url.search);
  if (await readSession()) throw new Error('Session was not revoked');
  location.replace('/auth/logged-out');
}
