const GLOBAL_PATHS = [
  '/api/auth/', '/api/workspaces', '/api/invite/', '/api/health',
  '/api/users', '/api/users/', '/api/logs', '/api/debug/',
  '/api/preferences', '/api/perf',
];

function isGlobal(pathname) {
  return GLOBAL_PATHS.some(prefix =>
    prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}?`),
  );
}

/** HTTP client that exercises the public, explicitly workspace-scoped API. */
export function createApiClient(base) {
  let workspaceIdPromise;

  async function workspaceId() {
    if (!workspaceIdPromise) {
      workspaceIdPromise = fetch(`${base}/api/workspaces`, {credentials: 'include'})
        .then(async response => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || 'Could not list workspaces');
          const id = body.defaultWorkspaceId || body.workspaces?.[0]?.id;
          if (!id) throw new Error('The integration identity has no workspace');
          return id;
        });
    }
    return workspaceIdPromise;
  }

  return async function api(method, requestedPath, body, opts = {}) {
    let target = requestedPath;
    if (!target.startsWith('http') && target.startsWith('/api/')
        && !target.startsWith('/api/workspaces/') && !isGlobal(target)) {
      const id = await workspaceId();
      target = `/api/workspaces/${encodeURIComponent(id)}${target.slice('/api'.length)}`;
    }
    const url = target.startsWith('http') ? target : `${base}${target}`;
    const init = {method, headers: {}, credentials: 'include'};
    if (body !== undefined && body !== null) {
      if (typeof body === 'string' || body instanceof Buffer) {
        init.body = body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    if (opts.headers) Object.assign(init.headers, opts.headers);
    if (opts.signal) init.signal = opts.signal;
    const response = await fetch(url, init);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    return {status: response.status, data, headers: response.headers};
  };
}
