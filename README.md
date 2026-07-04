# Delurk HN

Hacker News with the herd muted. **De-lurk** (Usenet, 1990s): when a lurker
finally breaks silence and posts.

Delurk shows the HN front page (Top / New / Best / Ask / Show, plus filter and
full-HN search) but strips out every social signal before it reaches your
browser: no points, no comment counts, no usernames, no threads. Clicking a
story opens it in a Gmail-style reading pane with a comment composer
underneath. You write your take and post it to HN directly — and only then
does the link to the real thread unlock, so you can compare your view against
the crowd's.

## Run it

Requires Node 18+. No dependencies, no build step.

```sh
node server.js
# open http://localhost:3311
```

## How it works

- **Reading** goes through the official [HN Firebase API](https://github.com/HackerNews/API)
  and [Algolia HN Search](https://hn.algolia.com/api). The server strips
  `score`, `descendants`, `by`, and `kids` from every item, so the metrics
  never even reach the client.
- **Writing** (login + commenting) proxies the news.ycombinator.com website
  itself, since HN has no official write API. Login exchanges your
  credentials for HN's session cookie; commenting fetches the item page to
  pick up the form's `hmac` token and posts the comment form. HN's bot filter
  429s non-browser user agents, so the proxy presents a browser UA.
- **Captcha fallback.** HN sometimes demands a captcha on password logins it
  suspects are automated, and this app won't try to defeat that. Instead, log
  into HN yourself in a normal browser tab (solving the captcha there) and
  paste your `user` cookie value into the "Stuck on a captcha?" box. The app
  verifies the session is live and reuses it — your password never reaches the
  server, and no automated login is ever attempted.
- **The server is stateless.** Your HN session cookie is handed back to your
  browser inside an httpOnly cookie; your posted takes are kept in
  localStorage. Nothing is stored server-side, which also means you can
  deploy it on any free tier as-is — or run it locally if you'd rather not
  route your HN login through someone else's box.

## Deploying

Any host that runs `node server.js` works (the server binds `0.0.0.0` and
respects `PORT` when the host sets it). On Render: New → Web Service → point
it at this repo → build command *(empty)* → start command `node server.js`.

## Reading in the pane

Clicking a story opens a reading pane with a segmented control:

- **Reader** (default for links): the server fetches the page and extracts the
  article text into sanitized, whitelist-only HTML — no third-party scripts
  run, and it renders even for sites that forbid being iframed. Extraction is
  heuristic, so non-article pages (a GitHub repo, a web app) fall back to a
  "not an article" note with **Live page** and **open ↗**.
- **Live page**: the raw site in a sandboxed iframe (works for sites that
  permit embedding; blocked ones show a note).
- **Discussion**: the HN comment thread, rendered in-app from the Firebase API
  (nested, collapsible, capped at ~200 nodes on huge threads). It stays
  **locked until you post your take** — the whole point of the app — and opens
  automatically the moment you do.

## Sharing

Every open story has a **Share** button that copies a Delurk link —
`https://your-host/s/<id>` — and the address bar tracks the story you're
reading, so it's shareable too. Opening someone's Delurk link lands the
recipient in the same herd-muted view: article on one side, composer on the
other, and the discussion still locked until they post their own take.

## Caveats

- Reader extraction is a zero-dep heuristic, not Readability — it does well on
  articles and blogs, poorly on app-like pages. "open ↗" is always there.
- Many sites send `X-Frame-Options`/`frame-ancestors` and refuse to render in
  the Live-page iframe; use Reader or "open ↗".
- HN occasionally requires a captcha at login; if that happens, log in once
  at news.ycombinator.com in a normal tab, then retry.
- HN rate-limits commenting ("posting too fast") — the error is surfaced in
  the composer.
- Be a good citizen: this posts real comments to the real HN as your account.
