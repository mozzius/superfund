import { createServer, type Server } from "node:http";
import { FOLLOWS_TAKEDOWN_LABELS } from "labeller-client";
import type { AuditStore } from "./store.ts";

const TOP_LIMIT = 300;
const CACHE_MS = 30_000;

/** Tiny read-only dashboard: who follows the most taken-down accounts. */
export function createDashboard(store: AuditStore, stats: () => Record<string, unknown>): Server {
  let cached: { at: number; body: string } | undefined;
  const data = () => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(),
      buckets: store.bucketCounts("follows"),
      thresholds: FOLLOWS_TAKEDOWN_LABELS.map((l) => l.minPercent),
      stats: stats(),
      accounts: store.topEvaluations("follows", TOP_LIMIT).map((e) => ({
        did: e.did,
        pct: Math.round((e.takendown / e.counted) * 1000) / 10,
        takendown: e.takendown,
        counted: e.counted,
        bucket: e.bucket,
        checkedAt: new Date(e.evaluatedAtMs).toISOString(),
      })),
    });
    cached = { at: Date.now(), body };
    return body;
  };

  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (path === "/health") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      } else if (path === "/data.json") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=30" }).end(data());
      } else if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
      } else {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
    } catch (err) {
      console.error("[dashboard] request failed", err);
      res.writeHead(500, { "content-type": "text/plain" }).end("error");
    }
  });
}

const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Baddest Boys</title>
<style>
  :root {
    --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --card: #fff;
    --bar: #dc2626; --bar-bg: #fee2e2; --chip: #f5f5f4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --line: #292524; --card: #1c1917;
      --bar: #f87171; --bar-bg: #450a0a; --chip: #292524;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 16px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
  .chip { background: var(--chip); border-radius: 999px; padding: 3px 10px; font-size: 12px; color: var(--muted); }
  .chip b { color: var(--fg); font-variant-numeric: tabular-nums; }
  ol { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  li { display: grid; grid-template-columns: 32px 36px 1fr auto; gap: 10px; align-items: center; padding: 10px 12px; border-top: 1px solid var(--line); }
  li:first-child { border-top: 0; }
  .rank { color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
  .av { width: 36px; height: 36px; border-radius: 50%; background: var(--chip); object-fit: cover; }
  .who { min-width: 0; }
  .who a { color: inherit; text-decoration: none; font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who a:hover { text-decoration: underline; }
  .who .h { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gone { color: var(--muted); font-style: italic; }
  .score { text-align: right; min-width: 120px; }
  .pct { font-weight: 700; font-size: 16px; font-variant-numeric: tabular-nums; }
  .detail { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .bar { height: 4px; background: var(--bar-bg); border-radius: 2px; margin-top: 4px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--bar); }
  .empty { padding: 24px; text-align: center; color: var(--muted); }
  footer { color: var(--muted); font-size: 12px; margin-top: 12px; }
</style>
</head>
<body>
<main>
  <h1>Baddest boys</h1>
  <p class="sub">Accounts whose follows have been taken down the most. Sampled from up to 1,000 most recent follows each.</p>
  <div class="chips" id="chips"></div>
  <ol id="list"><li class="empty">Loading…</li></ol>
  <footer id="foot"></footer>
</main>
<script>
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
};

async function profiles(dids) {
  const out = new Map();
  for (let i = 0; i < dids.length; i += 25) {
    const q = dids.slice(i, i + 25).map((d) => "actors=" + encodeURIComponent(d)).join("&");
    try {
      const r = await fetch("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?" + q);
      const j = await r.json();
      for (const p of j.profiles || []) out.set(p.did, p);
    } catch {}
  }
  return out;
}

async function load() {
  const data = await (await fetch("data.json")).json();
  const b = data.buckets || {};
  const total = Object.values(b).reduce((a, n) => a + n, 0);
  document.getElementById("chips").innerHTML =
    '<span class="chip">checked <b>' + total + '</b></span>' +
    data.thresholds.map((t, i) => {
      const next = data.thresholds[i + 1];
      const range = next ? t + "–" + next + "%" : t + "%+";
      return '<span class="chip">' + range + ' <b>' + (b[t] || 0) + '</b></span>';
    }).join("");
  document.getElementById("foot").textContent = "Updated " + ago(data.generatedAt);

  const list = document.getElementById("list");
  if (!data.accounts.length) { list.innerHTML = '<li class="empty">Nobody checked yet.</li>'; return; }
  const max = Math.max(...data.accounts.map((a) => a.pct), 1);
  const render = (profs) => {
    list.innerHTML = data.accounts.map((a, i) => {
      const p = profs.get(a.did);
      const url = "https://bsky.app/profile/" + encodeURIComponent(a.did);
      const name = p ? esc(p.displayName || p.handle) : '<span class="gone">' + (profs.size ? "gone" : "…") + '</span>';
      const handle = p ? "@" + esc(p.handle) : esc(a.did);
      const av = p && p.avatar ? '<img class="av" loading="lazy" src="' + esc(p.avatar) + '" alt="">' : '<div class="av"></div>';
      return '<li><span class="rank">' + (i + 1) + '</span>' + av +
        '<div class="who"><a href="' + url + '" target="_blank" rel="noopener">' + name + '</a><div class="h">' + handle + '</div></div>' +
        '<div class="score"><div class="pct">' + a.pct.toFixed(1) + '%</div>' +
        '<div class="detail">' + a.takendown + ' / ' + a.counted + ' · ' + ago(a.checkedAt) + '</div>' +
        '<div class="bar"><span style="width:' + (a.pct / max * 100).toFixed(1) + '%"></span></div></div></li>';
    }).join("");
  };
  render(new Map());
  render(await profiles(data.accounts.map((a) => a.did)));
}
load().catch((e) => { document.getElementById("list").innerHTML = '<li class="empty">Failed to load: ' + esc(e.message) + '</li>'; });
</script>
</body>
</html>`;
