#!/usr/bin/env node
/*
 * Delurk HN — a blinders-on Hacker News client.
 *
 * Shows the HN feed with no points, no comment counts, and no threads,
 * and lets you post a comment before you've seen anyone else's opinion.
 *
 * Zero dependencies; requires Node 18+.
 *
 * The server is stateless: after login the HN session cookie is handed back
 * to the browser inside an httpOnly cookie, and every write request carries
 * it back here. Nothing is persisted server-side.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3311;
// Bind localhost when run locally; bind all interfaces on hosts (Render, Fly)
// that inject PORT and front the app with their own proxy.
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');

const HN = 'https://news.ycombinator.com';
const API = 'https://hacker-news.firebaseio.com/v0';
// news.ycombinator.com answers 429 "Sorry." to non-browser user agents on
// login/comment POSTs, so we present a plain browser UA.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SESSION_COOKIE = 'dl_session';

const FEEDS = {
  top: 'topstories',
  new: 'newstories',
  best: 'beststories',
  ask: 'askstories',
  show: 'showstories',
};
const PAGE_SIZE = 30;
const idCache = new Map(); // feed -> { ids, at }

// ---------- small helpers ----------

function sendJSON(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function getSession(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  try {
    const s = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return s && s.user && s.cookie ? s : null;
  } catch {
    return null;
  }
}

function sessionCookieHeader(req, session) {
  const secure =
    req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  if (!session) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  const value = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`;
}

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Upstream error (${r.status})`);
  return r.json();
}

function setCookiesOf(r) {
  if (typeof r.headers.getSetCookie === 'function') return r.headers.getSetCookie();
  const single = r.headers.get('set-cookie');
  return single ? [single] : [];
}

// ---------- HN read side (metrics stripped) ----------

// Deliberately drop score, descendants (comment count), kids, and author, so
// the browser never even receives them.
function stripped(it) {
  return {
    id: it.id,
    title: it.title,
    url: it.url || null,
    time: it.time,
    text: it.text || null,
  };
}

async function feedIds(feed) {
  const cached = idCache.get(feed);
  if (cached && Date.now() - cached.at < 60_000) return cached.ids;
  const ids = await fetchJSON(`${API}/${FEEDS[feed] || 'topstories'}.json`);
  idCache.set(feed, { ids, at: Date.now() });
  return ids;
}

async function getStories(feed, page) {
  const ids = await feedIds(feed);
  const slice = ids.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const items = await Promise.all(
    slice.map((id) => fetchJSON(`${API}/item/${id}.json`).catch(() => null))
  );
  return {
    stories: items
      .filter((it) => it && !it.dead && !it.deleted && it.title)
      .map(stripped),
    hasMore: (page + 1) * PAGE_SIZE < ids.length,
  };
}

async function searchStories(q) {
  const j = await fetchJSON(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=30`
  );
  return j.hits
    .filter((h) => h.title)
    .map((h) => ({
      id: Number(h.objectID),
      title: h.title,
      url: h.url || null,
      time: h.created_at_i,
      text: h.story_text || null,
    }));
}

// ---------- in-app thread reading (comment tree via the API) ----------

// Fetch a story's comment tree. Bounded by a shared node budget so large
// front-page threads don't balloon into hundreds of upstream requests.
async function fetchThread(id, budget, depth) {
  const it = await fetchJSON(`${API}/item/${id}.json`).catch(() => null);
  if (!it) return null;
  const node = {
    id: it.id,
    by: it.by || null,
    time: it.time || null,
    text: it.deleted || it.dead ? null : it.text || null,
    dead: !!(it.deleted || it.dead),
    kids: [],
  };
  const kids = it.kids || [];
  if (depth >= 12) {
    if (kids.length) node.more = true;
    return node;
  }
  const children = await Promise.all(
    kids.map(async (kid) => {
      if (budget.n <= 0) return null;
      budget.n--;
      return fetchThread(kid, budget, depth + 1);
    })
  );
  node.kids = children.filter(Boolean);
  if (budget.n <= 0 && kids.length > node.kids.length) node.more = true;
  return node;
}

async function getThread(id) {
  const budget = { n: 200 };
  const root = await fetchThread(id, budget, 0);
  if (!root) throw new Error('Thread not found.');
  return { comments: root.kids, truncated: !!root.more || budget.n <= 0 };
}

// ---------- reader mode (server-side readable extraction) ----------

// Block obvious SSRF targets so a deployed instance can't be used to probe the
// host's private network via /api/read.
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
]);

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function absolutize(raw, base) {
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

// Turn a raw page into sanitized, article-only HTML. Heuristic and zero-dep:
// it keeps a whitelist of structural tags, drops everything else, and rewrites
// links/images to absolute URLs. No third-party script ever runs.
function extractReadable(html, baseUrl) {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const rawTitle = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const title = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim();

  // Drop whole noisy subtrees, content included.
  s = s.replace(
    /<(script|style|noscript|svg|template|iframe|form|nav|header|footer|aside|button|select|input)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ' '
  );

  // Prefer the tightest semantic container that exists.
  const region =
    s.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ||
    s;

  const cleaned = region.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (m, slash, tag, attrs) => {
    tag = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return ' ';
    if (slash) return `</${tag}>`;
    if (tag === 'a') {
      const abs = absolutize(attr(attrs, 'href') || '', baseUrl);
      return abs && /^(https?:|mailto:)/i.test(abs)
        ? `<a href="${escapeAttr(abs)}" target="_blank" rel="noopener noreferrer">`
        : '<a>';
    }
    if (tag === 'img') {
      const abs = absolutize(attr(attrs, 'src') || attr(attrs, 'data-src') || '', baseUrl);
      if (!abs || !/^https?:/i.test(abs)) return ' ';
      const alt = attr(attrs, 'alt') || '';
      return `<img src="${escapeAttr(abs)}" alt="${escapeAttr(alt)}" loading="lazy">`;
    }
    return `<${tag}>`; // allowed structural tag, attributes stripped
  });

  const collapsed = cleaned
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/(\s*<p>\s*<\/p>\s*)+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const words = collapsed.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return { title, html: collapsed, words };
}

async function readArticle(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be read.');
  if (isBlockedHost(u.hostname)) throw new Error('That host is not allowed.');

  const ctrl = AbortSignal.timeout(12_000);
  const r = await fetch(u.href, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    redirect: 'follow',
    signal: ctrl,
  });
  const type = r.headers.get('content-type') || '';
  if (!type.includes('html')) {
    return { kind: 'nonhtml', contentType: type.split(';')[0].trim() || 'unknown' };
  }
  const body = await r.text();
  const { title, html, words } = extractReadable(body, r.url || u.href);
  if (words < 40) return { kind: 'thin', title, words };
  return { kind: 'article', title, html, words };
}

// ---------- HN write side (login + comment via the website) ----------

async function hnLogin(username, password) {
  const body = new URLSearchParams({ acct: username, pw: password, goto: 'news' });
  const r = await fetch(`${HN}/login`, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
  });
  const userCookie = setCookiesOf(r).find((c) => c.startsWith('user='));
  if (r.status === 302 && userCookie) {
    return { user: username, cookie: userCookie.split(';')[0] };
  }
  if (r.status === 429) {
    throw new Error('HN is rate-limiting login attempts from this address — wait a minute and retry.');
  }
  const text = await r.text().catch(() => '');
  if (/Bad login/i.test(text)) {
    throw new Error('Bad login — check your username and password.');
  }
  if (/Validation required|recaptcha/i.test(text)) {
    throw new Error(
      'HN wants a captcha for this login. Instead, log in at news.ycombinator.com in a normal tab and paste your session cookie here — see "Stuck on a captcha?" in the login box.'
    );
  }
  throw new Error('Login failed — HN returned an unexpected response.');
}

// Adopt a session the user established themselves in a real browser. The user
// pastes the value of HN's `user` cookie (username&token); we verify it is
// live and read the username straight off it. This never performs the login
// POST, so it never trips HN's login captcha.
async function hnAdoptCookie(raw) {
  const value = String(raw || '')
    .trim()
    .replace(/^user=/, '') // tolerate a pasted "user=..." or the bare value
    .replace(/;.*$/, '')
    .trim();
  if (!/^[^&\s]+&[0-9a-zA-Z]+$/.test(value)) {
    throw new Error(
      'That does not look like an HN "user" cookie. It should look like yourname&a1b2c3… — copy the whole value.'
    );
  }
  const cookie = `user=${value}`;
  const r = await fetch(`${HN}/news`, { headers: { Cookie: cookie, 'User-Agent': UA } });
  if (r.status === 429) {
    throw new Error('HN is rate-limiting requests from this address — wait a minute and retry.');
  }
  const page = await r.text();
  if (!/logout\?/i.test(page)) {
    throw new Error('That cookie is not a valid logged-in HN session (it may be stale — re-copy it).');
  }
  return { user: value.split('&')[0], cookie };
}

async function hnComment(session, id, text) {
  const pageRes = await fetch(`${HN}/item?id=${id}`, {
    headers: { Cookie: session.cookie, 'User-Agent': UA },
  });
  if (pageRes.status === 429) {
    throw new Error('HN is rate-limiting requests from this address — wait a minute and retry.');
  }
  const page = await pageRes.text();
  const hmac = page.match(/name="hmac" value="([0-9a-f]+)"/)?.[1];
  if (!hmac) {
    if (!page.includes('logout')) {
      const err = new Error('Your HN session expired — log in again.');
      err.expired = true;
      throw err;
    }
    throw new Error('No comment form on this item (the thread may be locked or too old).');
  }
  const body = new URLSearchParams({
    parent: String(id),
    goto: `item?id=${id}`,
    hmac,
    text,
  });
  const r = await fetch(`${HN}/comment`, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookie,
      'User-Agent': UA,
    },
  });
  if (r.status === 302 || r.status === 303) return;
  if (r.status === 429) {
    throw new Error("HN is rate-limiting you — wait a minute and retry.");
  }
  const resp = await r.text().catch(() => '');
  if (/posting too fast/i.test(resp)) {
    throw new Error("HN says you're posting too fast — wait a minute and retry.");
  }
  throw new Error('HN did not accept the comment.');
}

// ---------- routing ----------

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/stories') {
    const feed = url.searchParams.get('feed') || 'top';
    const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0);
    return sendJSON(res, 200, await getStories(feed, page));
  }

  if (req.method === 'GET' && p === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJSON(res, 400, { error: 'Missing query' });
    return sendJSON(res, 200, { stories: await searchStories(q) });
  }

  if (req.method === 'GET' && p === '/api/item') {
    const id = Number(url.searchParams.get('id'));
    if (!id) return sendJSON(res, 400, { error: 'Missing id' });
    const it = await fetchJSON(`${API}/item/${id}.json`).catch(() => null);
    if (!it || it.deleted || it.dead || !it.title) {
      return sendJSON(res, 404, { error: 'Story not found.' });
    }
    return sendJSON(res, 200, { story: stripped(it) });
  }

  if (req.method === 'GET' && p === '/api/read') {
    const target = url.searchParams.get('url') || '';
    if (!target) return sendJSON(res, 400, { error: 'Missing url' });
    return sendJSON(res, 200, await readArticle(target));
  }

  if (req.method === 'GET' && p === '/api/thread') {
    const id = Number(url.searchParams.get('id'));
    if (!id) return sendJSON(res, 400, { error: 'Missing id' });
    return sendJSON(res, 200, await getThread(id));
  }

  if (req.method === 'GET' && p === '/api/me') {
    const session = getSession(req);
    return sendJSON(res, 200, { user: session ? session.user : null });
  }

  if (req.method === 'POST' && p === '/api/login') {
    const { username, password } = await readBody(req);
    if (!username || !password) {
      return sendJSON(res, 400, { error: 'Username and password required.' });
    }
    const session = await hnLogin(String(username), String(password));
    return sendJSON(res, 200, { user: session.user }, {
      'Set-Cookie': sessionCookieHeader(req, session),
    });
  }

  if (req.method === 'POST' && p === '/api/session') {
    const { cookie } = await readBody(req);
    const session = await hnAdoptCookie(cookie);
    return sendJSON(res, 200, { user: session.user }, {
      'Set-Cookie': sessionCookieHeader(req, session),
    });
  }

  if (req.method === 'POST' && p === '/api/logout') {
    return sendJSON(res, 200, { ok: true }, {
      'Set-Cookie': sessionCookieHeader(req, null),
    });
  }

  if (req.method === 'POST' && p === '/api/comment') {
    const session = getSession(req);
    if (!session) return sendJSON(res, 401, { error: 'Not logged in.' });
    const { id, text } = await readBody(req);
    if (!id || !String(text || '').trim()) {
      return sendJSON(res, 400, { error: 'Missing story id or comment text.' });
    }
    try {
      await hnComment(session, Number(id), String(text));
    } catch (e) {
      if (e.expired) {
        return sendJSON(res, 401, { error: e.message }, {
          'Set-Cookie': sessionCookieHeader(req, null),
        });
      }
      throw e;
    }
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'Not found' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url);
      } catch (e) {
        sendJSON(res, 400, { error: e.message || 'Request failed' });
      }
    } else if (/^\/s\/\d+\/?$/.test(url.pathname)) {
      // Shareable deep link to a single story — serve the app, which reads the
      // id off the path and opens that story in the reader pane.
      serveStatic(res, '/');
    } else {
      serveStatic(res, url.pathname);
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`Delurk HN running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
