import type { Workspace } from './types';

type Issue = { loc: Array<string | number>; msg: string };

export class ApiError extends Error {
  fields: Record<string, string>;

  constructor(detail: string | Issue[]) {
    super(typeof detail === 'string' ? detail : 'Check the highlighted fields.');
    this.fields = Array.isArray(detail) ? Object.fromEntries(detail.map(({ loc, msg }) => [
      loc.slice(1).join('.'), msg.replace(/^Value error, /, ''),
    ])) : {};
  }
}

export async function api<T>(path: string, workspace: Workspace, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-PawPass-Workspace', workspace);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch('/api' + path, { ...init, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('PawPass could not reach the server. Try again.');
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    const detail = data?.detail;
    throw new ApiError(typeof detail === 'string' || Array.isArray(detail) ? detail : 'Something went wrong. Try again.');
  }
  return data as T;
}
