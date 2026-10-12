// REST calls + session token storage. The token is only a bearer credential;
// the server validates it on every request and socket connection.
const KEY = 'yoink_token';

// Static build (no Node server): the server runs inside the page, bots only (see js/local/).
export const LOCAL = !!window.yoinkLocal;

export const session = {
  get token() {
    try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY); } catch { return null; }
  },
  save(token, remember) {
    try {
      sessionStorage.setItem(KEY, token);
      if (remember) localStorage.setItem(KEY, token); else localStorage.removeItem(KEY);
    } catch { /* storage unavailable */ }
  },
  // this tab keeps its own copy, so another tab can't take the login away from it
  adopt(token) {
    try { sessionStorage.setItem(KEY, token); } catch { /* storage unavailable */ }
  },
  clear() {
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch { /* ignore */ }
  },
  clearTab() {
    try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  },
};

async function call(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = session.token;
  if (t) headers.Authorization = 'Bearer ' + t;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    return { error: 'Cannot reach the yoink! server. Is it running?' };
  }
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) return { error: data.error || `Request failed (${res.status}).`, field: data.field, status: res.status };
  return data;
}

export const api = {
  register: (username, password) => call('POST', '/api/register', { username, password }),
  login: (username, password) => call('POST', '/api/login', { username, password }),
  logout: () => call('POST', '/api/logout'),
  me: () => call('GET', '/api/me'),
};
