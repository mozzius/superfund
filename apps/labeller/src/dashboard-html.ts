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
  .tabs { display: flex; gap: 6px; margin-top: 16px; }
  .tabs button {
    background: none;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .tabs button[aria-selected="true"] { color: var(--fg); background: var(--panel); border-color: var(--muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 16px; }
  .chip {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 12px;
    color: var(--muted);
  }
  .chip b { color: var(--fg); font-variant-numeric: tabular-nums; }
  .row {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 8px;
  }
  .row .rank { color: var(--muted); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .row .who { min-width: 0; }
  .row .who a { color: var(--fg); text-decoration: none; font-weight: 600; }
  .row .who a:hover { text-decoration: underline; }
  .row .who .did { color: var(--muted); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; word-break: normal; }
  .row .score { text-align: right; min-width: 110px; }
  .row .pct { font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; }
  .row .bar { height: 3px; background: var(--border); border-radius: 2px; margin-top: 4px; overflow: hidden; }
  .row .bar span { display: block; height: 100%; background: var(--accent); }
</style>
</head>
<body>
<main>
  <header>
    <h1>labelled users</h1>
    <div class="sub" id="sub-replyrefs">accounts carrying <code>doesnt-know-how-replyrefs-work</code> and the posts that tripped them</div>
    <div class="sub" id="sub-follows" hidden>accounts whose follows have been taken down the most (up to 1,000 most recent follows each)</div>
    <div class="sub" id="sub-followers" hidden>accounts whose followers have been taken down the most (up to 1,000 most recent followers each)</div>
    <nav class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="replyrefs" aria-selected="true">replyrefs</button>
      <button type="button" role="tab" data-tab="follows" aria-selected="false">follows taken down</button>
      <button type="button" role="tab" data-tab="followers" aria-selected="false">followers taken down</button>
    </nav>
  </header>
  <section id="view-takedowns" hidden>
    <div id="takedowns-summary" class="summary">loading…</div>
    <div id="takedowns-chips" class="chips"></div>
    <div id="takedowns-list"></div>
  </section>
  <section id="view-replyrefs">
  <div id="summary" class="summary">loading…</div>
  <div id="controls" class="controls" hidden>
    <span class="label">sort by</span>
    <button type="button" data-sort="latest" aria-pressed="true">latest</button>
    <button type="button" data-sort="most" aria-pressed="false">most posts</button>
    <button type="button" id="toggle-bots" aria-pressed="false">hide bots</button>
    <span class="spacer"></span>
    <span id="copy-status" class="copy-status" aria-live="polite"></span>
    <button type="button" id="copy-profiles">copy profile urls</button>
  </div>
  <div id="list"></div>
  </section>
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
  let currentBots = new Set();
  let currentSort = "latest";
  let hideBots = false;

  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  const fmtDate = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  // bsky.app can't open "handle.invalid", so those link by DID.
  const profileId = (did, handle) =>
    typeof handle === "string" && handle !== "handle.invalid" ? handle : did;

  const bskyPostUrl = (uri, handle) => {
    // at://did:plc:xxx/app.bsky.feed.post/rkey
    const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
    if (!m) return null;
    return "https://bsky.app/profile/" + profileId(m[1], handle) + "/post/" + m[2];
  };

  const bskyProfileUrl = (did, handle) =>
    "https://bsky.app/profile/" + profileId(did, handle);

  // Sentinel returned when getProfile says the account is gone (suspended /
  // deactivated / taken down) — we hide these entries entirely.
  const HIDDEN = Symbol("hidden");
  const HIDDEN_ERRORS = new Set([
    "AccountTakedown",
    "AccountDeactivated",
    "AccountSuspended",
  ]);

  async function resolveProfiles(dids) {
    const handles = {};
    const bots = new Set();
    await Promise.all(dids.map(async (did) => {
      try {
        const res = await fetch(
          "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=" + encodeURIComponent(did)
        );
        if (res.ok) {
          const json = await res.json();
          handles[did] = json.handle ?? null;
          if (Array.isArray(json.labels) && json.labels.some((l) => l.val === "bot")) {
            bots.add(did);
          }
          return;
        }
        try {
          const json = await res.json();
          if (json && HIDDEN_ERRORS.has(json.error)) {
            handles[did] = HIDDEN;
            return;
          }
        } catch {}
        handles[did] = null;
      } catch {
        handles[did] = null;
      }
    }));
    return { handles, bots };
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
    const notGone = currentAccounts.filter((acc) => handles[acc.did] !== HIDDEN);
    const goneCount = currentAccounts.length - notGone.length;
    const visibleAccounts = hideBots
      ? notGone.filter((acc) => !currentBots.has(acc.did))
      : notGone;
    const botHiddenCount = notGone.length - visibleAccounts.length;
    const accounts = sortAccounts(visibleAccounts, currentSort);

    const summaryParts = [];
    summaryParts.push(visibleAccounts.length + " labelled account" + (visibleAccounts.length === 1 ? "" : "s"));
    const detail = [];
    if (goneCount) detail.push(goneCount + " suspended/deactivated");
    if (botHiddenCount) detail.push(botHiddenCount + " bots");
    if (detail.length) summaryParts.push("(" + detail.join(", ") + " hidden)");
    summaryEl.textContent = summaryParts.join(" ");

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
    const sortBtn = e.target.closest("button[data-sort]");
    if (sortBtn) {
      const sort = sortBtn.dataset.sort;
      if (sort === currentSort) return;
      currentSort = sort;
      for (const b of controlsEl.querySelectorAll("button[data-sort]")) {
        b.setAttribute("aria-pressed", b.dataset.sort === sort ? "true" : "false");
      }
      render();
      return;
    }
    if (e.target.closest("#toggle-bots")) {
      hideBots = !hideBots;
      const btn = document.getElementById("toggle-bots");
      btn.setAttribute("aria-pressed", hideBots ? "true" : "false");
      render();
    }
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
      .filter((acc) => !hideBots || !currentBots.has(acc.did))
      .map((acc) => bskyProfileUrl(acc.did, currentHandles[acc.did]));
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
      if (accounts.length) {
        const { handles, bots } = await resolveProfiles(accounts.map((a) => a.did));
        currentHandles = handles;
        currentBots = bots;
      } else {
        currentHandles = {};
        currentBots = new Set();
      }
      render();
    } catch (err) {
      summaryEl.innerHTML = '<span class="err">failed to load: ' + esc(String(err)) + '</span>';
    }
  }

  load();

  // --- "follows / followers taken down" tabs (data proxied from follows-audit).

  const tdSummaryEl = document.getElementById("takedowns-summary");
  const tdChipsEl = document.getElementById("takedowns-chips");
  const tdListEl = document.getElementById("takedowns-list");
  let takedownData = null; // { generatedAt, follows, followers, profiles }
  let takedownLoading = null;
  let currentTab = "replyrefs";

  const ago = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };

  // Batched lookup. getProfiles silently drops taken-down / deactivated
  // accounts, so anything missing from the response is treated as gone.
  async function batchProfiles(dids) {
    const found = new Map();
    for (let i = 0; i < dids.length; i += 25) {
      const q = dids.slice(i, i + 25).map((d) => "actors=" + encodeURIComponent(d)).join("&");
      const res = await fetch("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?" + q);
      if (!res.ok) throw new Error("getProfiles HTTP " + res.status);
      for (const p of (await res.json()).profiles ?? []) found.set(p.did, p);
    }
    return found;
  }

  async function loadTakedowns() {
    const res = await fetch("/dashboard/follows");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "HTTP " + res.status);
    const dids = [...new Set([...data.follows.accounts, ...data.followers.accounts].map((a) => a.did))];
    data.profiles = dids.length ? await batchProfiles(dids) : new Map();
    takedownData = data;
  }

  function renderTakedowns(direction) {
    const data = takedownData;
    const view = data[direction];
    const profiles = data.profiles;
    const buckets = view.buckets ?? {};
    const checked = Object.values(buckets).reduce((a, n) => a + n, 0);
    tdChipsEl.innerHTML = view.thresholds.map((t, i) => {
      const next = view.thresholds[i + 1];
      const range = next ? t + "–" + next + "%" : t + "%+";
      return '<span class="chip">' + range + ' <b>' + (buckets[t] ?? 0) + '</b></span>';
    }).join("");

    const visible = view.accounts.filter((a) => profiles.has(a.did));
    const gone = view.accounts.length - visible.length;
    tdSummaryEl.textContent = checked + " accounts checked in the last 30 days" +
      (gone ? " (" + gone + " suspended/deactivated hidden)" : "") +
      " · updated " + ago(data.generatedAt);

    if (!visible.length) {
      tdListEl.innerHTML = '<div class="empty">nobody checked yet</div>';
      return;
    }
    const max = Math.max(...visible.map((a) => a.pct), 1);
    tdListEl.innerHTML = visible.map((a, i) => {
      const p = profiles.get(a.did);
      return '<div class="row">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<div class="who"><a href="' + esc(bskyProfileUrl(a.did, p.handle)) + '" target="_blank" rel="noopener">@' +
          esc(p.handle) + '</a><span class="did">' + esc(a.did) + '</span></div>' +
        '<div class="score"><div class="pct">' + a.pct.toFixed(1) + '%</div>' +
          '<div class="meta">' + a.takendown + ' / ' + a.counted + ' &middot; ' + esc(ago(a.checkedAt)) + '</div>' +
          '<div class="bar"><span style="width:' + (a.pct / max * 100).toFixed(1) + '%"></span></div></div>' +
      '</div>';
    }).join("");
  }

  async function showTakedowns(direction) {
    if (!takedownData) {
      tdSummaryEl.textContent = "loading…";
      tdChipsEl.innerHTML = "";
      tdListEl.innerHTML = "";
      try {
        takedownLoading ??= loadTakedowns();
        await takedownLoading;
      } catch (err) {
        takedownLoading = null;
        tdSummaryEl.innerHTML = '<span class="err">failed to load: ' + esc(String(err.message ?? err)) + '</span>';
        return;
      }
    }
    if (currentTab === direction) renderTakedowns(direction);
  }

  const tabs = ["replyrefs", "follows", "followers"];
  function showTab(tab) {
    if (!tabs.includes(tab)) tab = "replyrefs";
    currentTab = tab;
    document.getElementById("view-replyrefs").hidden = tab !== "replyrefs";
    document.getElementById("view-takedowns").hidden = tab === "replyrefs";
    for (const t of tabs) document.getElementById("sub-" + t).hidden = t !== tab;
    for (const b of document.querySelectorAll(".tabs button")) {
      b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
    }
    if (tab !== "replyrefs") showTakedowns(tab);
  }
  document.querySelector(".tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    history.replaceState(null, "", btn.dataset.tab === "replyrefs" ? location.pathname : "#" + btn.dataset.tab);
    showTab(btn.dataset.tab);
  });
  showTab(location.hash.slice(1));
</script>
</body>
</html>
`;
