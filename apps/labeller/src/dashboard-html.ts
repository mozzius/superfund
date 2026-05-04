const html = String.raw
export const dashboardHtml = html`<!doctype html>
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
  .controls {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 16px 0;
    font-size: 13px;
  }
  .controls .label { color: var(--muted); }
  .controls button {
    background: var(--panel);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
    font: inherit;
    cursor: pointer;
  }
  .controls button[aria-pressed="true"] {
    background: var(--link);
    border-color: var(--link);
    color: #fff;
  }
  .controls .spacer { flex: 1; }
  .controls .copy-status { color: var(--muted); font-size: 12px; }
  details.more { margin-top: 4px; }
  details.more > summary {
    cursor: pointer;
    color: var(--link);
    font-size: 12px;
    list-style: none;
    padding: 4px 0;
    user-select: none;
  }
  details.more > summary::-webkit-details-marker { display: none; }
  details.more > summary:hover { text-decoration: underline; }
  details.more[open] > summary::after { content: " (hide)"; color: var(--muted); }
  details.more > .posts { margin-top: 6px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>labelled users</h1>
    <div class="sub">accounts carrying <code>doesnt-know-how-replyrefs-work</code> and the posts that tripped them</div>
  </header>
  <div id="summary" class="summary">loading…</div>
  <div id="controls" class="controls" hidden>
    <span class="label">sort by</span>
    <button type="button" data-sort="latest" aria-pressed="true">latest</button>
    <button type="button" data-sort="most" aria-pressed="false">most posts</button>
    <span class="spacer"></span>
    <span id="copy-status" class="copy-status" aria-live="polite"></span>
    <button type="button" id="copy-profiles">copy profile urls</button>
  </div>
  <div id="list"></div>
</main>
<script>
  const listEl = document.getElementById("list");
  const summaryEl = document.getElementById("summary");
  const controlsEl = document.getElementById("controls");
  const copyBtn = document.getElementById("copy-profiles");
  const copyStatusEl = document.getElementById("copy-status");
  const POSTS_BEFORE_COLLAPSE = 5;
  let currentAccounts = [];
  let currentHandles = {};
  let currentSort = "latest";

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  const fmtDate = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const bskyPostUrl = (uri, handle) => {
    // at://did:plc:xxx/app.bsky.feed.post/rkey
    const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
    if (!m) return null;
    return "https://bsky.app/profile/" + (handle ?? m[1]) + "/post/" + m[2];
  };

  const bskyProfileUrl = (did, handle) =>
    "https://bsky.app/profile/" + (handle ?? did);

  // Sentinel returned when getProfile says the account is gone (suspended /
  // deactivated / taken down) — we hide these entries entirely.
  const HIDDEN = Symbol("hidden");
  const HIDDEN_ERRORS = new Set([
    "AccountTakedown",
    "AccountDeactivated",
    "AccountSuspended",
  ]);

  async function resolveHandles(dids) {
    const entries = await Promise.all(dids.map(async (did) => {
      try {
        const res = await fetch(
          "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=" + encodeURIComponent(did)
        );
        if (res.ok) {
          const json = await res.json();
          return [did, json.handle ?? null];
        }
        // Try to read the XRPC error body to distinguish gone-forever from
        // transient failures.
        try {
          const json = await res.json();
          if (json && HIDDEN_ERRORS.has(json.error)) return [did, HIDDEN];
        } catch {}
        return [did, null];
      } catch {
        return [did, null];
      }
    }));
    return Object.fromEntries(entries);
  }

  const renderPost = (p, handle) => {
    const url = bskyPostUrl(p.uri, handle);
    const link = url
      ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">open</a>'
      : '';
    return '<div class="post"><span>' + esc(p.uri) + '</span>' +
      '<span class="meta">' + esc(fmtDate(p.labelledAt)) +
      (link ? ' &middot; ' + link : '') + '</span></div>';
  };

  const sortAccounts = (accounts, sort) => {
    const copy = accounts.slice();
    if (sort === "most") {
      copy.sort((a, b) => {
        if (b.posts.length !== a.posts.length) return b.posts.length - a.posts.length;
        return a.labelledAt < b.labelledAt ? 1 : -1;
      });
    } else {
      copy.sort((a, b) => (a.labelledAt < b.labelledAt ? 1 : -1));
    }
    return copy;
  };

  const render = () => {
    const handles = currentHandles;
    const visibleAccounts = currentAccounts.filter((acc) => handles[acc.did] !== HIDDEN);
    const hiddenCount = currentAccounts.length - visibleAccounts.length;
    const accounts = sortAccounts(visibleAccounts, currentSort);

    summaryEl.textContent =
      visibleAccounts.length + " labelled account" + (visibleAccounts.length === 1 ? "" : "s") +
      (hiddenCount ? " (" + hiddenCount + " hidden: suspended or deactivated)" : "");

    if (!accounts.length) {
      controlsEl.hidden = true;
      listEl.innerHTML = '<div class="empty">no labelled accounts right now</div>';
      return;
    }
    controlsEl.hidden = false;

    listEl.innerHTML = accounts.map((acc) => {
      const handle = handles[acc.did];
      const header = handle
        ? '<a class="handle" href="' + esc(bskyProfileUrl(acc.did, handle)) +
          '" target="_blank" rel="noopener">@' + esc(handle) + '</a>' +
          ' <span class="did">' + esc(acc.did) + '</span>'
        : '<span class="did">' + esc(acc.did) + '</span>';

      let postsHtml;
      if (!acc.posts.length) {
        postsHtml = '<div class="no-posts">no currently-labelled posts (may have expired or been negated)</div>';
      } else if (acc.posts.length <= POSTS_BEFORE_COLLAPSE) {
        postsHtml = '<div class="posts">' +
          acc.posts.map((p) => renderPost(p, handle)).join("") +
          '</div>';
      } else {
        const visible = acc.posts.slice(0, POSTS_BEFORE_COLLAPSE);
        const rest = acc.posts.slice(POSTS_BEFORE_COLLAPSE);
        postsHtml = '<div class="posts">' +
          visible.map((p) => renderPost(p, handle)).join("") +
          '</div>' +
          '<details class="more"><summary>show ' + rest.length + ' more</summary>' +
          '<div class="posts">' +
          rest.map((p) => renderPost(p, handle)).join("") +
          '</div></details>';
      }

      return '<div class="account">' +
        '<div class="account-head">' +
          '<div>' + header + '</div>' +
          '<div class="meta">' + acc.posts.length + ' post' + (acc.posts.length === 1 ? '' : 's') +
            ' &middot; labelled ' + esc(fmtDate(acc.labelledAt)) +
            (acc.expiresAt ? ' &middot; expires ' + esc(fmtDate(acc.expiresAt)) : '') +
          '</div>' +
        '</div>' +
        postsHtml +
      '</div>';
    }).join("");
  };

  controlsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-sort]");
    if (!btn) return;
    const sort = btn.dataset.sort;
    if (sort === currentSort) return;
    currentSort = sort;
    for (const b of controlsEl.querySelectorAll("button[data-sort]")) {
      b.setAttribute("aria-pressed", b.dataset.sort === sort ? "true" : "false");
    }
    render();
  });

  let copyStatusTimer;
  const setCopyStatus = (msg) => {
    copyStatusEl.textContent = msg;
    clearTimeout(copyStatusTimer);
    if (msg) copyStatusTimer = setTimeout(() => { copyStatusEl.textContent = ""; }, 2500);
  };

  copyBtn.addEventListener("click", async () => {
    const urls = currentAccounts
      .filter((acc) => currentHandles[acc.did] !== HIDDEN)
      .map((acc) => {
        const handle = currentHandles[acc.did];
        return "https://bsky.app/profile/" + (handle ?? acc.did);
      });
    if (!urls.length) {
      setCopyStatus("nothing to copy");
      return;
    }
    const text = urls.join(String.fromCharCode(10));
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied " + urls.length + " url" + (urls.length === 1 ? "" : "s"));
    } catch {
      setCopyStatus("copy failed");
    }
  });

  async function load() {
    try {
      const res = await fetch("/dashboard/data");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const accounts = data.accounts ?? [];

      currentAccounts = accounts;
      currentHandles = accounts.length
        ? await resolveHandles(accounts.map((a) => a.did))
        : {};
      render();
    } catch (err) {
      summaryEl.innerHTML = '<span class="err">failed to load: ' + esc(String(err)) + '</span>';
    }
  }

  load();
</script>
</body>
</html>
`;
