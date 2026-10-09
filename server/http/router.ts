/**
 * Tiny method + path router. Patterns are split on `/`; `:name` captures one segment and a final
 * `*` captures the rest of the path (available as `params['*']`). Exact segments win over params
 * only by registration order, so register specific routes first. HEAD falls back to GET.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Params = Record<string, string>;

/** Everything a route handler needs for one request. */
export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Parsed request URL (origin is a placeholder; use pathname / searchParams). */
  url: URL;
  params: Params;
}

export type RouteHandler = (rc: RequestContext) => unknown;

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

interface Route {
  method: HttpMethod;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

export type RouteMatch =
  | { kind: 'found'; handler: RouteHandler; params: Params }
  | { kind: 'method_not_allowed'; allow: HttpMethod[] }
  | { kind: 'not_found' };

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(pattern: string[], path: string[]): Params | null {
  const params: Params = {};
  for (let i = 0; i < pattern.length; i++) {
    const segment = pattern[i];
    if (segment === '*' && i === pattern.length - 1) {
      params['*'] = path.slice(i).join('/');
      return params;
    }
    const value = path[i];
    if (value === undefined) return null;
    if (segment.startsWith(':')) {
      try {
        params[segment.slice(1)] = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (segment !== value) {
      return null;
    }
  }
  return pattern.length === path.length ? params : null;
}

export class Router {
  readonly #routes: Route[] = [];

  add(method: HttpMethod | HttpMethod[], pattern: string, handler: RouteHandler): this {
    for (const m of Array.isArray(method) ? method : [method]) {
      this.#routes.push({ method: m, pattern, segments: split(pattern), handler });
    }
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** Registered `METHOD pattern` pairs, for the startup log. */
  list(): string[] {
    return this.#routes.map((route) => `${route.method} ${route.pattern}`);
  }

  match(method: string, pathname: string): RouteMatch {
    const path = split(pathname);
    const allow = new Set<HttpMethod>();
    let headFallback: RouteMatch | null = null;
    for (const route of this.#routes) {
      const params = matchSegments(route.segments, path);
      if (!params) continue;
      if (route.method === method) return { kind: 'found', handler: route.handler, params };
      if (method === 'HEAD' && route.method === 'GET' && !headFallback) {
        headFallback = { kind: 'found', handler: route.handler, params };
      }
      allow.add(route.method);
    }
    if (headFallback) return headFallback;
    if (allow.size > 0) return { kind: 'method_not_allowed', allow: [...allow] };
    return { kind: 'not_found' };
  }
}
