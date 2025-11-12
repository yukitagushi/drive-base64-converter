let tokenProvider = () => '';
let workspaceProvider = () => '';

export function setTokenProvider(provider) {
  if (typeof provider === 'function') {
    tokenProvider = provider;
  } else {
    tokenProvider = () => '';
  }
}

export function setWorkspaceProvider(provider) {
  if (typeof provider === 'function') {
    workspaceProvider = provider;
  } else {
    workspaceProvider = () => '';
  }
}

function buildHeaders(initHeaders = {}, hasBody = false, bodyIsFormData = false) {
  const headers = new Headers(initHeaders);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  if (hasBody && !bodyIsFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = tokenProvider();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  } else {
    headers.delete('Authorization');
  }
  const workspace = workspaceProvider();
  if (workspace) {
    headers.set('X-Office', workspace);
  } else {
    headers.delete('X-Office');
  }
  return headers;
}

export async function authFetch(input, init = {}) {
  const body = init.body;
  const bodyIsFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers = buildHeaders(init.headers, Boolean(body), bodyIsFormData);

  const requestInit = { ...init, headers };
  if (bodyIsFormData) {
    // Let the browser set the multipart boundary automatically.
    requestInit.body = body;
  }

  return fetch(input, requestInit);
}
