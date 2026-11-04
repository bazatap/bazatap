export function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bazatap</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #e5e7eb; --bad: #b91c1c; --good: #047857; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 24px; }
  h1 { font-size: 18px; margin: 0; letter-spacing: -0.01em; }
  .muted { color: var(--muted); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  .card .value { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
  .card .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 8px; }
  section { margin-bottom: 28px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li.row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--line); }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 0 8px 6px 0; }
  td { padding: 6px 8px 6px 0; border-top: 1px solid var(--line); white-space: nowrap; }
  td.path { white-space: normal; overflow-wrap: anywhere; }
  .bad { color: var(--bad); }
  .good { color: var(--good); }
  .empty { color: var(--muted); padding: 8px 0; }
</style>
</head>
<body>
<header>
  <h1>bazatap</h1>
  <span class="muted" id="meta">waiting for traffic</span>
</header>

<div class="cards">
  <div class="card"><div class="label">Requests</div><div class="value" id="requests">0</div></div>
  <div class="card"><div class="label">Agent traffic</div><div class="value" id="ucp">0</div></div>
  <div class="card"><div class="label">Checkout attempts</div><div class="value" id="attempts">0</div></div>
  <div class="card"><div class="label">Sessions created</div><div class="value" id="created">0</div></div>
  <div class="card"><div class="label">Completion rate</div><div class="value" id="acr">—</div></div>
</div>

<section>
  <h2>Why agents fail</h2>
  <ul id="failures"><li class="empty">No failures recorded.</li></ul>
</section>

<section>
  <h2>Agents</h2>
  <ul id="agents"><li class="empty">No agent traffic recorded.</li></ul>
</section>

<section>
  <h2>Recent requests</h2>
  <table>
    <thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Operation</th><th>Failure</th><th>ms</th></tr></thead>
    <tbody id="recent"><tr><td colspan="7" class="empty">Nothing yet.</td></tr></tbody>
  </table>
</section>

<script>
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function list(node, items, render) {
  if (!items.length) return;
  node.innerHTML = items.map(render).join("");
}

async function tick() {
  let data;
  try {
    data = await (await fetch("/__bazatap/api/summary")).json();
  } catch {
    el("meta").textContent = "disconnected";
    return;
  }
  el("meta").textContent = "since " + new Date(data.startedAt).toLocaleTimeString();
  el("requests").textContent = data.requests;
  el("ucp").textContent = data.ucpRequests;
  el("attempts").textContent = data.checkout.attempts;
  el("created").textContent = data.checkout.created;
  el("acr").textContent = data.checkout.completionRate === null ? "—" : Math.round(data.checkout.completionRate * 100) + "%";

  const failures = el("failures");
  if (data.failures.length) {
    failures.innerHTML = data.failures.map((f) =>
      '<li class="row"><span class="bad">' + esc(f.reason) + '</span><span>' + f.count + "</span></li>"
    ).join("");
  }

  const agents = el("agents");
  if (data.agents.length) {
    agents.innerHTML = data.agents.map((a) =>
      '<li class="row"><span>' + esc(a.agent) + '</span><span>' + a.count + "</span></li>"
    ).join("");
  }

  const recent = el("recent");
  if (data.recent.length) {
    recent.innerHTML = data.recent.map((r) =>
      "<tr>" +
      "<td>" + new Date(r.ts).toLocaleTimeString() + "</td>" +
      "<td>" + esc(r.method) + "</td>" +
      '<td class="path">' + esc(r.path) + "</td>" +
      '<td class="' + (r.status >= 400 ? "bad" : "good") + '">' + r.status + "</td>" +
      "<td>" + esc(r.operation) + "</td>" +
      "<td>" + esc(r.failure ?? "") + "</td>" +
      "<td>" + r.durationMs + "</td>" +
      "</tr>"
    ).join("");
  }
}

tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
}
