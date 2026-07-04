/* Delurk HN frontend. Takes are stored in localStorage; the HN session lives
 * in an httpOnly cookie set by the server. */

const els = {
  list: document.getElementById('list'),
  more: document.getElementById('more'),
  moreWrap: document.getElementById('moreWrap'),
  q: document.getElementById('q'),
  tabs: Array.from(document.querySelectorAll('#tabs button')),
  banner: document.getElementById('banner'),
  intro: document.getElementById('intro'),
  introDismiss: document.getElementById('introDismiss'),
  split: document.getElementById('split'),
  listPane: document.getElementById('listPane'),
  reader: document.getElementById('reader'),
  readerTitle: document.getElementById('readerTitle'),
  readerViews: document.getElementById('readerViews'),
  readerPop: document.getElementById('readerPop'),
  readerClose: document.getElementById('readerClose'),
  readerContent: document.getElementById('readerContent'),
  readerFooter: document.getElementById('readerFooter'),
  loginBtn: document.getElementById('loginBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  whoami: document.getElementById('whoami'),
  username: document.getElementById('username'),
  dialog: document.getElementById('loginDialog'),
  loginForm: document.getElementById('loginForm'),
  loginError: document.getElementById('loginError'),
  loginCancel: document.getElementById('loginCancel'),
  loginSubmit: document.getElementById('loginSubmit'),
  cookieForm: document.getElementById('cookieForm'),
  cookieError: document.getElementById('cookieError'),
  cookieSubmit: document.getElementById('cookieSubmit'),
};

const TAKES_KEY = 'delurk.takes';
const INTRO_KEY = 'delurk.introSeen';

const state = {
  feed: 'top',
  page: 0,
  stories: [],
  mode: 'feed', // 'feed' | 'search' | 'mine'
  user: null,
  takes: loadTakes(), // [{id, title, url, text, time}]
  openId: null,
};

function loadTakes() {
  try {
    return JSON.parse(localStorage.getItem(TAKES_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveTakes() {
  localStorage.setItem(TAKES_KEY, JSON.stringify(state.takes));
}

function takeFor(id) {
  return state.takes.find((t) => t.id === id) || null;
}

async function api(path, opts = {}) {
  if (opts.body) {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  }
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) setUser(null);
    throw new Error(j.error || `Request failed (${r.status})`);
  }
  return j;
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  const units = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [sec, label] of units) {
    if (s >= sec) return `${Math.floor(s / sec)}${label} ago`;
  }
  return 'just now';
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---------- story list ----------

function render() {
  els.list.innerHTML = '';
  if (state.mode === 'mine') {
    renderMine();
    els.moreWrap.hidden = true;
    return;
  }
  const filter = els.q.value.trim().toLowerCase();
  const visible =
    state.mode === 'feed' && filter
      ? state.stories.filter((s) =>
          (s.title + ' ' + domainOf(s.url || '')).toLowerCase().includes(filter)
        )
      : state.stories;
  if (!visible.length) {
    els.list.appendChild(el('div', 'empty', 'Nothing here.'));
  }
  for (const s of visible) els.list.appendChild(storyRow(s));
  els.moreWrap.hidden = state.mode !== 'feed';
}

function renderMine() {
  if (!state.takes.length) {
    els.list.appendChild(
      el('div', 'empty', 'No takes yet. Pick a story and say what you think — before anyone tells you what to think.')
    );
    return;
  }
  for (const t of state.takes) {
    const art = el('article', 'story');
    art.style.cursor = 'default';
    const h = el('h2');
    const a = el('a', null, t.title || `Item ${t.id}`);
    a.href = `https://news.ycombinator.com/item?id=${t.id}`;
    a.target = '_blank';
    a.rel = 'noopener';
    h.appendChild(a);
    art.appendChild(h);
    const posted = el('div', 'posted');
    posted.appendChild(el('div', 'label', `your take · ${timeAgo(t.time)}`));
    posted.appendChild(el('blockquote', null, t.text));
    const link = el('a', null, 'Open the HN thread →');
    link.href = `https://news.ycombinator.com/item?id=${t.id}`;
    link.target = '_blank';
    link.rel = 'noopener';
    posted.appendChild(link);
    art.appendChild(posted);
    els.list.appendChild(art);
  }
}

function badgeFor(id) {
  return takeFor(id)
    ? el('span', 'badge done', '✓ take posted · thread unlocked')
    : el('span', 'badge locked', '🔒 thread locked — write to unlock');
}

function storyRow(s) {
  const art = el('article', 'story');
  art.dataset.id = s.id;
  if (state.openId === s.id) art.classList.add('selected');

  const h = el('h2');
  const a = el('a', null, s.title);
  a.href = s.url || `#${s.id}`;
  a.addEventListener('click', (e) => {
    // Plain click opens the reader pane; modified clicks keep browser behavior.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openReader(s);
  });
  h.appendChild(a);
  const dom = domainOf(s.url || '');
  if (dom) h.appendChild(el('span', 'domain', dom));
  art.appendChild(h);

  const meta = el('div', 'meta');
  meta.appendChild(el('span', null, timeAgo(s.time)));
  meta.appendChild(badgeFor(s.id));
  art.appendChild(meta);

  art.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    openReader(s);
  });

  return art;
}

function refreshRow(id) {
  const row = els.list.querySelector(`.story[data-id="${id}"]`);
  if (!row) return;
  const old = row.querySelector('.badge');
  if (old) old.replaceWith(badgeFor(id));
}

// ---------- reader pane ----------

let readerSeq = 0;

function openReader(s) {
  state.openId = s.id;
  els.list.querySelectorAll('.story.selected').forEach((n) => n.classList.remove('selected'));
  els.list.querySelector(`.story[data-id="${s.id}"]`)?.classList.add('selected');
  els.split.classList.add('open');
  els.reader.hidden = false;

  els.readerTitle.textContent = s.title;
  // "open ↗" points at the linked site for URL stories; hidden for text posts,
  // since HN's own item page would show the comments we're trying to withhold.
  if (s.url) {
    els.readerPop.href = s.url;
    els.readerPop.hidden = false;
  } else {
    els.readerPop.hidden = true;
  }

  buildViews(s);
  setReaderMode(s, s.url ? 'read' : 'text');
  renderReaderFooter(s);
}

function availableViews(s) {
  const views = s.url
    ? [{ id: 'read', label: 'Reader' }, { id: 'live', label: 'Live page' }]
    : [{ id: 'text', label: 'Post' }];
  views.push({ id: 'discussion', label: 'Discussion', locked: !takeFor(s.id) });
  return views;
}

function buildViews(s) {
  els.readerViews.innerHTML = '';
  for (const v of availableViews(s)) {
    const b = el('button', null, v.locked ? `🔒 ${v.label}` : v.label);
    b.dataset.mode = v.id;
    b.classList.toggle('active', v.id === state.readerMode);
    if (v.locked) {
      b.disabled = true;
      b.title = 'Post your take to unlock the discussion';
    } else {
      b.addEventListener('click', () => setReaderMode(s, v.id));
    }
    els.readerViews.appendChild(b);
  }
}

function setReaderMode(s, mode) {
  state.readerMode = mode;
  for (const b of els.readerViews.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === mode);
  }
  renderReaderContent(s, mode);
}

function fallbackNote(s, message) {
  const note = el('div', 'reader-note');
  note.appendChild(el('p', null, message));
  if (s.url) {
    const live = el('button', 'ghost', 'Try the live page');
    live.addEventListener('click', () => setReaderMode(s, 'live'));
    note.appendChild(live);
    const open = el('a', 'ghost', 'open ↗');
    open.href = s.url;
    open.target = '_blank';
    open.rel = 'noopener';
    note.appendChild(open);
  }
  return note;
}

async function renderReaderContent(s, mode) {
  const seq = ++readerSeq;
  const c = els.readerContent;
  c.innerHTML = '';

  if (mode === 'live') {
    const f = document.createElement('iframe');
    f.src = s.url;
    f.referrerPolicy = 'no-referrer';
    // Let the page run, but withhold top-navigation so a frame-buster can't
    // hijack the whole app.
    f.sandbox = 'allow-scripts allow-same-origin allow-popups allow-forms';
    c.appendChild(f);
    c.appendChild(
      el('div', 'embed-note', 'Blank page? The site refuses to be embedded — try the Reader tab or "open ↗".')
    );
    return;
  }

  if (mode === 'text') {
    const d = el('div', 'reader-text');
    if (s.text) d.innerHTML = s.text; // HN-sanitized HTML
    else d.textContent = '(no text)';
    c.appendChild(d);
    return;
  }

  if (mode === 'read') {
    c.appendChild(el('div', 'reader-note', 'Extracting readable text…'));
    try {
      const j = await api('/api/read?url=' + encodeURIComponent(s.url));
      if (seq !== readerSeq) return;
      c.innerHTML = '';
      if (j.kind === 'article') {
        const d = el('div', 'reader-text');
        d.appendChild(el('h1', null, j.title || s.title));
        const body = document.createElement('div');
        body.innerHTML = j.html; // server-sanitized: whitelist tags only
        d.appendChild(body);
        c.appendChild(d);
      } else if (j.kind === 'nonhtml') {
        c.appendChild(fallbackNote(s, `This link is a ${j.contentType} file, not an article.`));
      } else {
        c.appendChild(fallbackNote(s, "This page doesn't look like an article, so there's no clean text to pull out."));
      }
    } catch (e) {
      if (seq !== readerSeq) return;
      c.innerHTML = '';
      c.appendChild(fallbackNote(s, `Could not fetch this page: ${e.message}`));
    }
    return;
  }

  if (mode === 'discussion') {
    c.appendChild(el('div', 'reader-note', 'Loading the discussion…'));
    try {
      const j = await api('/api/thread?id=' + s.id);
      if (seq !== readerSeq) return;
      c.innerHTML = '';
      c.appendChild(renderThread(j));
    } catch (e) {
      if (seq !== readerSeq) return;
      c.innerHTML = '';
      c.appendChild(el('div', 'reader-note', `Could not load the discussion: ${e.message}`));
    }
  }
}

function renderThread(j) {
  const wrap = el('div', 'reader-thread');
  const bits = [];
  if (!j.comments.length) bits.push('No comments on this story yet.');
  bits.push("You've posted your take, so the discussion is unlocked.");
  if (j.truncated) bits.push('Showing the top of a long thread.');
  wrap.appendChild(el('div', 'thread-head', bits.join(' ')));
  for (const c of j.comments) wrap.appendChild(renderComment(c));
  return wrap;
}

function renderComment(c) {
  const node = el('div', 'comment');
  if (c.dead) node.classList.add('dead');

  const meta = el('div', 'comment-meta');
  const kids = c.kids || [];
  if (kids.length) {
    const toggle = el('span', 'comment-collapse', '[–]');
    toggle.addEventListener('click', () => {
      const collapsed = node.classList.toggle('collapsed');
      toggle.textContent = collapsed ? `[+] ${kids.length}` : '[–]';
    });
    meta.appendChild(toggle);
    meta.appendChild(document.createTextNode(' '));
  }
  meta.appendChild(el('span', 'who', c.by || (c.dead ? '[dead]' : '[deleted]')));
  if (c.time) meta.appendChild(document.createTextNode(` · ${timeAgo(c.time)}`));
  node.appendChild(meta);

  const body = el('div', 'comment-body');
  if (c.text) body.innerHTML = c.text; // HN-sanitized HTML
  else body.textContent = c.dead ? '[flagged or deleted]' : '';
  node.appendChild(body);

  for (const k of kids) node.appendChild(renderComment(k));
  return node;
}

function closeReader() {
  state.openId = null;
  state.readerMode = null;
  els.split.classList.remove('open');
  els.reader.hidden = true;
  els.readerContent.innerHTML = '';
  els.readerViews.innerHTML = '';
  els.readerFooter.innerHTML = '';
  els.list.querySelectorAll('.story.selected').forEach((n) => n.classList.remove('selected'));
}

function renderReaderFooter(s) {
  els.readerFooter.innerHTML = '';
  if (takeFor(s.id)) {
    els.readerFooter.appendChild(postedBox(s));
    return;
  }

  const composer = el('div', 'composer');
  const ta = document.createElement('textarea');
  ta.placeholder = "Your take — written before seeing anyone else's. Posted to HN as a top-level comment.";
  composer.appendChild(ta);

  const row = el('div', 'composer-row');
  const post = el('button', 'primary', 'Post to HN');
  const count = el('span', 'count', '');
  const status = el('span', 'status', '');
  row.appendChild(post);
  row.appendChild(count);
  row.appendChild(status);
  composer.appendChild(row);

  ta.addEventListener('input', () => {
    const words = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
    count.textContent = words ? `${words} word${words === 1 ? '' : 's'}` : '';
  });

  post.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) {
      status.textContent = 'Write something first.';
      return;
    }
    if (!state.user) {
      status.textContent = 'Log in first.';
      openLogin();
      return;
    }
    post.disabled = true;
    status.textContent = 'Posting…';
    try {
      await api('/api/comment', {
        method: 'POST',
        body: JSON.stringify({ id: s.id, text }),
      });
      state.takes.unshift({
        id: s.id,
        title: s.title,
        url: s.url,
        text,
        time: Math.floor(Date.now() / 1000),
      });
      saveTakes();
      refreshRow(s.id);
      renderReaderFooter(s);
      // Unlock and jump straight into the discussion, right here in the pane.
      buildViews(s);
      setReaderMode(s, 'discussion');
    } catch (e) {
      status.textContent = e.message;
      post.disabled = false;
    }
  });

  els.readerFooter.appendChild(composer);
}

// Once you've committed your own view, the thread unlocks.
function postedBox(s) {
  const box = el('div', 'posted');
  box.appendChild(el('div', 'label', 'your take'));
  box.appendChild(el('blockquote', null, takeFor(s.id).text));
  const btn = el('button', 'primary', '🔓 Read the discussion here →');
  btn.addEventListener('click', () => setReaderMode(s, 'discussion'));
  box.appendChild(btn);
  const alt = el('a', null, 'or open the HN thread ↗');
  alt.href = `https://news.ycombinator.com/item?id=${s.id}`;
  alt.target = '_blank';
  alt.rel = 'noopener';
  alt.style.marginLeft = '0.7rem';
  box.appendChild(alt);
  return box;
}

// ---------- data loading ----------

let loadSeq = 0;

async function loadFeed(reset = true) {
  const seq = ++loadSeq;
  if (reset) {
    state.page = 0;
    state.stories = [];
    els.list.innerHTML = '';
    els.list.appendChild(el('div', 'empty', 'Loading…'));
  }
  try {
    const data = await api(`/api/stories?feed=${state.feed}&page=${state.page}`);
    if (seq !== loadSeq) return;
    const known = new Set(state.stories.map((s) => s.id));
    state.stories = state.stories.concat(data.stories.filter((s) => !known.has(s.id)));
    els.more.hidden = !data.hasMore;
    render();
  } catch (e) {
    if (seq !== loadSeq) return;
    els.list.innerHTML = '';
    els.list.appendChild(el('div', 'empty', `Could not load stories: ${e.message}`));
  }
}

async function runSearch(q) {
  const seq = ++loadSeq;
  state.mode = 'search';
  els.list.innerHTML = '';
  els.list.appendChild(el('div', 'empty', 'Searching…'));
  setBanner(q);
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (seq !== loadSeq) return;
    state.stories = data.stories;
    render();
  } catch (e) {
    if (seq !== loadSeq) return;
    els.list.innerHTML = '';
    els.list.appendChild(el('div', 'empty', `Search failed: ${e.message}`));
  }
}

function setBanner(q) {
  els.banner.innerHTML = '';
  if (!q) {
    els.banner.hidden = true;
    return;
  }
  els.banner.hidden = false;
  els.banner.appendChild(document.createTextNode(`Results from all of HN for “${q}” · `));
  const clear = el('a', null, 'back to the feed');
  clear.addEventListener('click', () => {
    els.q.value = '';
    state.mode = 'feed';
    setBanner(null);
    loadFeed(true);
  });
  els.banner.appendChild(clear);
}

// ---------- auth ----------

function setUser(user) {
  state.user = user;
  els.loginBtn.hidden = !!user;
  els.whoami.hidden = !user;
  els.username.textContent = user || '';
}

function openLogin() {
  els.loginError.hidden = true;
  els.dialog.showModal();
}

els.loginBtn.addEventListener('click', openLogin);
els.loginCancel.addEventListener('click', () => els.dialog.close());

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(els.loginForm);
  els.loginSubmit.disabled = true;
  els.loginError.hidden = true;
  try {
    const j = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: fd.get('username'),
        password: fd.get('password'),
      }),
    });
    setUser(j.user);
    els.dialog.close();
    els.loginForm.reset();
  } catch (err) {
    els.loginError.textContent = err.message;
    els.loginError.hidden = false;
  } finally {
    els.loginSubmit.disabled = false;
  }
});

els.cookieForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cookie = new FormData(els.cookieForm).get('cookie');
  els.cookieSubmit.disabled = true;
  els.cookieError.hidden = true;
  try {
    const j = await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ cookie }),
    });
    setUser(j.user);
    els.dialog.close();
    els.cookieForm.reset();
  } catch (err) {
    els.cookieError.textContent = err.message;
    els.cookieError.hidden = false;
  } finally {
    els.cookieSubmit.disabled = false;
  }
});

els.logoutBtn.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' });
  setUser(null);
});

// ---------- wiring ----------

for (const btn of els.tabs) {
  btn.addEventListener('click', () => {
    els.tabs.forEach((b) => b.classList.toggle('active', b === btn));
    els.q.value = '';
    setBanner(null);
    closeReader();
    const feed = btn.dataset.feed;
    if (feed === 'mine') {
      state.mode = 'mine';
      state.takes = loadTakes();
      render();
    } else {
      state.mode = 'feed';
      state.feed = feed;
      loadFeed(true);
    }
  });
}

els.q.addEventListener('input', () => {
  if (state.mode !== 'search') render();
});

els.q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && els.q.value.trim()) {
    runSearch(els.q.value.trim());
  } else if (e.key === 'Escape' && state.mode === 'search') {
    els.q.value = '';
    state.mode = 'feed';
    setBanner(null);
    loadFeed(true);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.openId !== null && document.activeElement !== els.q) {
    closeReader();
  }
});

els.readerClose.addEventListener('click', closeReader);

els.more.addEventListener('click', () => {
  state.page += 1;
  loadFeed(false);
});

if (localStorage.getItem(INTRO_KEY)) els.intro.hidden = true;
els.introDismiss.addEventListener('click', () => {
  els.intro.hidden = true;
  localStorage.setItem(INTRO_KEY, '1');
});

(async function init() {
  try {
    const me = await api('/api/me');
    setUser(me.user);
  } catch {
    setUser(null);
  }
  loadFeed(true);
})();
