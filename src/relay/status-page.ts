/**
 * Minimal single-file dashboard: presence toggle, pending approvals with
 * local Approve/Deny, job log, and the live spend ledger from the gateway.
 * While this tab is open it heartbeats every 15s => you are "present".
 * Close it (or force Away mode) and approvals route to your phone.
 */
export function statusPageHtml(): string {
  return /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OnGuardForYourBill</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-sans-serif, -apple-system, sans-serif; background:#0d1117; color:#e6edf3; margin:0; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; } .sub { color:#8b949e; font-size:13px; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns: 1.2fr 1fr; gap:18px; } @media (max-width:900px){ .grid{grid-template-columns:1fr} }
  .card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:16px; margin-bottom:18px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:1px; color:#8b949e; margin:0 0 12px; }
  .pill { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:600; }
  .away { background:#3d2300; color:#f0883e; } .present { background:#0f2e18; color:#3fb950; }
  .pending { background:#3d2300; color:#f0883e; } .approved { background:#0f2e18; color:#3fb950; }
  .denied,.expired { background:#3c1618; color:#f85149; }
  button { background:#21262d; color:#e6edf3; border:1px solid #30363d; border-radius:6px; padding:7px 14px; cursor:pointer; font-size:13px; }
  button.approve { background:#1f6feb; border-color:#1f6feb; } button.deny { background:#da3633; border-color:#da3633; }
  .row { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid #21262d; font-size:13px; }
  .mono { font-family: ui-monospace, monospace; font-size:12px; }
  .log { max-height:280px; overflow-y:auto; font-family:ui-monospace,monospace; font-size:11.5px; color:#8b949e; line-height:1.6; }
  .big { font-size:22px; font-weight:700; }
  .approval { border:1px solid #f0883e55; border-radius:8px; padding:12px; margin-bottom:10px; }
</style>
</head>
<body>
<h1>OnGuardForYourBill</h1>
<div class="sub">Remote, amount-bound approval for unattended AI spend — powered by TrueForge</div>
<div class="card" style="display:flex;justify-content:space-between;align-items:center">
  <div>Presence: <span id="presence" class="pill away">…</span>
  <span class="sub" style="margin-left:8px">away ⇒ approvals go to your phone; timeout always denies</span></div>
  <button id="awayBtn" onclick="toggleAway()">Toggle Away mode</button>
</div>
<div class="grid">
  <div>
    <div class="card"><h2>Pending approvals</h2><div id="approvals">none</div></div>
    <div class="card"><h2>Job log</h2><div id="jobs" class="log">no jobs yet</div></div>
  </div>
  <div>
    <div class="card"><h2>Spend ledger (gateway)</h2><div id="ledger">gateway unreachable</div></div>
    <div class="card"><h2>Policy</h2><div id="policy" class="mono"></div></div>
  </div>
</div>
<script>
let manualAway = true, token = "";
const fmtUsd = n => '$' + (n >= 0.01 ? n.toFixed(2) : n.toPrecision(3));
async function refresh() {
  const r = await fetch('/api/state'); const s = await r.json();
  manualAway = s.manualAway; token = s.webhookToken;
  const p = document.getElementById('presence');
  p.textContent = s.away ? 'AWAY' : 'PRESENT'; p.className = 'pill ' + (s.away ? 'away' : 'present');

  const apr = s.approvals || [];
  document.getElementById('approvals').innerHTML = apr.length ? apr.map(a => \`
    <div class="approval">
      <div class="big">\${a.requestedUsd != null ? fmtUsd(a.requestedUsd) : a.toolName}</div>
      <div class="mono">\${a.toolName} · \${(a.args.provider||'')}/\${(a.args.model||'')} · \${a.args.max_calls||'?'} calls · expires \${new Date(a.expiresAt).toLocaleTimeString()}</div>
      <div style="margin-top:8px">
        <span class="pill \${a.status}">\${a.status.toUpperCase()}</span> <span class="mono">routed to \${a.routedTo}</span>
        \${a.status === 'pending' ? \`
          <button class="approve" onclick="decide('\${a.approvalId}','approve')">Approve exactly \${a.requestedUsd != null ? fmtUsd(a.requestedUsd) : ''}</button>
          <button class="deny" onclick="decide('\${a.approvalId}','deny')">Deny</button>\` : (a.decidedBy ? '<span class="mono"> · by ' + a.decidedBy + '</span>' : '')}
      </div>
    </div>\`).join('') : 'none';

  const jobs = s.jobs || [];
  document.getElementById('jobs').innerHTML = jobs.length ? jobs.map(j => \`
    <div><b>\${j.jobId}</b> · \${j.status} · session \${j.sessionId}</div>
    \${j.log.map(l => '<div>' + l.at.slice(11,19) + '  ' + l.line + '</div>').join('')}
    \${j.output ? '<div style="color:#3fb950;white-space:pre-wrap;margin-top:6px">' + j.output.slice(0, 2000) + '</div>' : ''}\`).join('<hr style="border-color:#21262d">') : 'no jobs yet';

  if (s.gateway) {
    const u = s.gateway.usage, t = u.totals, cp = u.control_plane;
    document.getElementById('ledger').innerHTML = \`
      <div class="row"><span>Granted</span><b>$\${t.granted_usd.toFixed(4)}</b></div>
      <div class="row"><span>Spent</span><b>$\${t.spent_usd.toFixed(4)}</b></div>
      <div class="row"><span>Reserved (in flight)</span><b>$\${t.reserved_usd.toFixed(4)}</b></div>
      <div class="row"><span>Remaining</span><b>$\${t.remaining_usd.toFixed(4)}</b></div>
      <div class="row"><span>Calls / failures</span><b>\${t.calls} / \${t.failures}</b></div>
      <div class="row"><span>Control-plane (harness tokens)</span><b>$\${cp.spent_usd.toFixed(4)} / $\${cp.cap_usd.toFixed(2)}</b></div>
      \${u.grants.map(g => \`<div class="row mono"><span>\${g.provider}/\${g.model} \${g.status}</span><span>\${fmtUsd(g.used_usd)} of \${fmtUsd(g.max_usd)} · \${g.calls}/\${g.max_calls} calls</span></div>\`).join('')}\`;
    const pol = s.gateway.policy;
    document.getElementById('policy').innerHTML =
      'auto-approve ≤ $' + pol.auto_approve_usd + ' · hard cap $' + pol.hard_cap_usd +
      ' · retries ' + pol.retry.max_attempts + ' · approval timeout ' + pol.approval_timeout_seconds + 's<br>allowlist: ' +
      pol.allowlist.map(a => a.provider + '/' + a.model).join(', ');
  }
}
async function decide(id, action) {
  await fetch('/decision/' + id + '/' + action + '?token=' + encodeURIComponent(token), { method: 'POST' });
  refresh();
}
async function toggleAway() {
  await fetch('/away', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ away: !manualAway }) });
  refresh();
}
setInterval(() => fetch('/heartbeat', { method: 'POST' }), 15000);
fetch('/heartbeat', { method: 'POST' });
setInterval(refresh, 3000); refresh();
</script>
</body>
</html>`;
}
