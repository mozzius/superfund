export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>labelled users</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0b0d10;
    --panel: #12151a;
    --border: #1f252d;
    --fg: #e6edf3;
    --muted: #8b949e;
    --accent: #ff6b6b;
    --link: #7aa7ff;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa;
      --panel: #ffffff;
      --border: #d0d7de;
      --fg: #1f2328;
      --muted: #656d76;
      --accent: #cf222e;
      --link: #0969da;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  main { max-width: 880px; margin: 0 auto; padding: 32px 20px 80px; }
  header { margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; }
  .summary { color: var(--muted); font-size: 13px; margin: 16px 0; }
  .account {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .account-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  .did { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
  .handle { font-weight: 600; }
  .meta { color: var(--muted); font-size: 12px; }
  .posts { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .post {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    word-break: break-all;
    padding: 6px 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .post a { color: var(--link); text-decoration: none; }
  .post a:hover { text-decoration: underline; }
  .no-posts { color: var(--muted); font-size: 12px; font-style: italic; }
  .err { color: var(--accent); }
  .empty { color: var(--muted); text-align: center; padding: 40px 0; }
</style>
</head>
<body>
<main>
  <header>
    <h1>labelled users</h1>
    <div class="sub">accounts carrying <code>doesnt-know-how-replyrefs-work</code> and the posts that tripped them</div>
  </header>
  <div id="summary" class="summary">loading…</div>
  <div id="list"></div>
</main>
<script>
  const listEl = document.getElementById("list");
  const summaryEl = document.getElementById("summary");

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  const fmtDate = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const bskyPostUrl = (uri, handle) => {
    // at://did:plc:xxx/app.bsky.feed.post/rkey
    const m = uri.match(/^at:\\/\\/([^/]+)\\/app\\.bsky\\.feed\\.post\\/(.+)$/);
    if (!m) return null;
    return "https://bsky.app/profile/" + (handle ?? m[1]) + "/post/" + m[2];
  };

  const bskyProfileUrl = (did, handle) =>
    "https://bsky.app/profile/" + (handle ?? did);

  async function resolveHandles(dids) {
    const entries = await Promise.all(dids.map(async (did) => {
      try {
        const res = await fetch(
          "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=" + encodeURIComponent(did)
        );
        if (!res.ok) return [did, null];
        const json = await res.json();
        return [did, json.handle ?? null];
      } catch {
        return [did, null];
      }
    }));
    return Object.fromEntries(entries);
  }

  async function load() {
    try {
      const res = await fetch("/dashboard/data");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const accounts = data.accounts ?? [];

      if (!accounts.length) {
        summaryEl.textContent = "";
        listEl.innerHTML = '<div class="empty">no labelled accounts right now</div>';
        return;
      }

      summaryEl.textContent =
        accounts.length + " labelled account" + (accounts.length === 1 ? "" : "s");

      const handles = await resolveHandles(accounts.map((a) => a.did));

      listEl.innerHTML = accounts.map((acc) => {
        const handle = handles[acc.did];
        const header = handle
          ? '<a class="handle" href="' + esc(bskyProfileUrl(acc.did, handle)) +
            '" target="_blank" rel="noopener">@' + esc(handle) + '</a>' +
            ' <span class="did">' + esc(acc.did) + '</span>'
          : '<span class="did">' + esc(acc.did) + '</span>';

        const posts = acc.posts.length
          ? acc.posts.map((p) => {
              const url = bskyPostUrl(p.uri, handle);
              const link = url
                ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">open</a>'
                : '';
              return '<div class="post"><span>' + esc(p.uri) + '</span>' +
                '<span class="meta">' + esc(fmtDate(p.labelledAt)) +
                (link ? ' &middot; ' + link : '') + '</span></div>';
            }).join("")
          : '<div class="no-posts">no currently-labelled posts (may have expired or been negated)</div>';

        return '<div class="account">' +
          '<div class="account-head">' +
            '<div>' + header + '</div>' +
            '<div class="meta">labelled ' + esc(fmtDate(acc.labelledAt)) +
              (acc.expiresAt ? ' &middot; expires ' + esc(fmtDate(acc.expiresAt)) : '') +
            '</div>' +
          '</div>' +
          '<div class="posts">' + posts + '</div>' +
        '</div>';
      }).join("");
    } catch (err) {
      summaryEl.innerHTML = '<span class="err">failed to load: ' + esc(String(err)) + '</span>';
    }
  }

  load();
</script>
</body>
</html>
`;
