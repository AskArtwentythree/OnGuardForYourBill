/**
 * OnGuardForYourBill Approval Relay.
 *
 * Drives the Overnight Evaluation Operator through the TrueForge TypeScript
 * SDK. When TrueForge pauses on the gated `reserve_budget` MCP tool
 * (`tool.approval_required`), the relay:
 *
 *   1. reads the exact tool call + arguments from the event stream,
 *   2. routes the decision — auto-approve under the threshold, reject over the
 *      hard cap, otherwise a REAL push notification to your phone (ntfy.sh)
 *      with "Approve exactly $X" / "Deny" buttons,
 *   3. resumes the SAME TrueForge session with `user.tool_approval`.
 *
 * Timeouts, unreachable phones, and invalid webhooks all fail closed (deny).
 * Duplicate webhook deliveries are idempotent: one terminal decision only.
 */
import "dotenv/config";
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  TrueForge,
  type TrueForgeApi,
  isEventDelta,
  mergeEventDelta,
} from "@truefoundry/trueforge-sdk";
import { sendApprovalPush, sendInfoPush } from "./notify.js";
import { statusPageHtml } from "./status-page.js";

// ---------------- Config ----------------

const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8789);
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8788";
const AGENT_NAME = process.env.AGENT_NAME ?? "overnight-eval-operator";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN ?? randomUUID();
const PUBLIC_RELAY_URL = process.env.PUBLIC_RELAY_URL ?? `http://${lanIp()}:${RELAY_PORT}`;

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
  timeoutInSeconds: 900,
  ...(process.env.TRUEFORGE_TOKEN ? { token: process.env.TRUEFORGE_TOKEN } : {}),
});

function lanIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "localhost";
}

// ---------------- State ----------------

type Decision = { status: "allow" } | { status: "deny"; reason?: string };

interface PendingApproval {
  approvalId: string;
  sessionId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  requestedUsd: number | null;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedBy?: string;
  routedTo: "phone" | "dashboard" | "auto";
}

interface JobRecord {
  jobId: string;
  sessionId: string;
  status: "running" | "waiting_for_approval" | "done" | "error";
  log: { at: string; line: string }[];
  output?: string;
  startedAt: string;
}

const pendingApprovals = new Map<string, PendingApproval>();
const approvalWaiters = new Map<string, (d: Decision) => void>(); // approvalId -> resolver
const approvalTimers = new Map<string, NodeJS.Timeout>();
const jobs = new Map<string, JobRecord>(); // sessionId -> job

// Presence: deterministic, computed outside the model. Away routes approvals
// to the phone; it never grants or weakens anything.
let manualAway = true; // default Away for predictable demos
let lastHeartbeatAt = 0;
const isAway = () => manualAway || Date.now() - lastHeartbeatAt > 90_000;

let policyCache: { auto_approve_usd: number; hard_cap_usd: number; approval_timeout_seconds: number } = {
  auto_approve_usd: 0.05,
  hard_cap_usd: 5,
  approval_timeout_seconds: 600,
};

async function refreshPolicy() {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/status`);
    const body = (await res.json()) as { policy: typeof policyCache };
    policyCache = body.policy;
  } catch {
    console.warn("[relay] gateway unreachable; using cached policy (fail-closed thresholds).");
  }
}

/** "$4.54" for normal amounts, "$0.000776" for sub-cent demo amounts. */
function fmtUsd(n: number): string {
  return `$${n >= 0.01 ? n.toFixed(2) : n.toPrecision(3)}`;
}

function log(job: JobRecord | undefined, line: string) {
  console.log(`[relay] ${line}`);
  job?.log.push({ at: new Date().toISOString(), line });
}

// ---------------- Turn runner ----------------

interface PendingRef {
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Stream one turn to completion. Returns approval refs if the turn paused on
 * tool.approval_required, plus the final output when done.
 */
async function streamTurn(
  sessionId: string,
  input: TrueForgeApi.TurnInputItem[] | undefined,
  job: JobRecord,
): Promise<{ pending: PendingRef[]; output?: string }> {
  const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
  const pausedRefs: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
  let output: string | undefined;

  const stream = await client.sessions.createTurnStream(sessionId, input ? { input } : {});
  for await (const { data: event } of stream.withMetadata()) {
    if (isEventDelta(event)) {
      const base = events.get(event.id);
      if (base) mergeEventDelta(base, event);
      continue;
    }
    events.set(event.id, event);

    switch (event.type) {
      case "thread.created":
        log(job, `subagent started: ${event.title}`);
        break;
      case "thread.done":
        log(job, `subagent finished (${event.threadId})`);
        break;
      case "sandbox.created":
        log(job, `sandbox provisioned: ${event.sandboxId}`);
        break;
      case "tool.approval_required":
        pausedRefs.push(event);
        break;
      case "turn.done":
        if (event.state.status === "done") {
          const c = event.state.output?.content;
          output = typeof c === "string" ? c : c?.map((part) => ("text" in part ? part.text : "")).join("");
        } else log(job, `turn ended: ${event.state.status}`);
        break;
    }
  }

  const pending: PendingRef[] = [];
  for (const paused of pausedRefs) {
    for (const ref of paused.toolCalls) {
      const msg = events.get(ref.sourceEventId);
      if (msg?.type !== "model.message") continue;
      const call = msg.toolCalls?.find((tc) => tc.id === ref.id);
      if (!call) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* keep {} */
      }
      handledToolCalls.add(ref.id); // the runner owns this pause; the UI watcher must skip it
      pending.push({
        threadId: paused.threadId ?? "main",
        toolCallId: ref.id,
        toolName: call.toolInfo?.name ?? call.function.name,
        args,
      });
    }
  }
  return { pending, output };
}

/** The main loop: run turns, resolve approval pauses, resume, until done. */
async function continueSession(sessionId: string, input: TrueForgeApi.TurnInputItem[] | undefined) {
  const job = jobs.get(sessionId);
  if (!job) return;
  job.status = "running";
  try {
    let next: TrueForgeApi.TurnInputItem[] | undefined = input;
    while (true) {
      const { pending, output } = await streamTurn(sessionId, next, job);
      if (pending.length === 0) {
        job.status = "done";
        job.output = output;
        log(job, `job finished`);
        await sendInfoPush(
          "OnGuard: job finished",
          (output ?? "Run complete.").slice(0, 400),
          ["white_check_mark"],
        );
        return;
      }
      job.status = "waiting_for_approval";
      const decisions = await Promise.all(pending.map((p) => routeApproval(sessionId, p, job)));
      next = decisions.map((d, i) => ({
        type: "user.tool_approval" as const,
        threadId: pending[i].threadId,
        toolCallId: pending[i].toolCallId,
        approval: d,
      }));
      job.status = "running";
    }
  } catch (err) {
    job.status = "error";
    log(job, `error: ${(err as Error).message}`);
  }
}

// ---------------- Approval routing ----------------

async function routeApproval(sessionId: string, ref: PendingRef, job: JobRecord): Promise<Decision> {
  await refreshPolicy();
  const requestedUsd =
    ref.toolName === "reserve_budget" && typeof ref.args.max_usd === "number" ? ref.args.max_usd : null;

  // 1) Hard cap: reject outright. No approval button exists for this.
  if (requestedUsd != null && requestedUsd > policyCache.hard_cap_usd) {
    log(job, `DENIED without prompt: ${fmtUsd(requestedUsd)} exceeds hard cap ${fmtUsd(policyCache.hard_cap_usd)}`);
    await sendInfoPush(
      "OnGuard: blocked over hard cap",
      `The agent asked for ${fmtUsd(requestedUsd)} but the hard cap is ${fmtUsd(policyCache.hard_cap_usd)}. Denied automatically — only you can raise the policy.`,
      ["no_entry"],
    );
    return {
      status: "deny",
      reason: `Requested ${fmtUsd(requestedUsd)} exceeds the absolute hard cap of ${fmtUsd(policyCache.hard_cap_usd)}. This is not negotiable; propose a cheaper plan within policy.`,
    };
  }

  // 2) Under the automatic threshold: approve, but log it as an explicit decision.
  if (requestedUsd != null && requestedUsd <= policyCache.auto_approve_usd) {
    log(job, `auto-approved $${requestedUsd.toFixed(4)} (<= auto threshold $${policyCache.auto_approve_usd})`);
    return { status: "allow" };
  }

  // 3) Human decision required: phone when away, dashboard when present (both always work).
  const approvalId = `apr_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + policyCache.approval_timeout_seconds * 1000).toISOString();
  const away = isAway();
  const approval: PendingApproval = {
    approvalId,
    sessionId,
    threadId: ref.threadId,
    toolCallId: ref.toolCallId,
    toolName: ref.toolName,
    args: ref.args,
    requestedUsd,
    createdAt: new Date().toISOString(),
    expiresAt,
    status: "pending",
    routedTo: away ? "phone" : "dashboard",
  };
  pendingApprovals.set(approvalId, approval);

  const scope = describeScope(ref);
  log(job, `PAUSED for approval ${approvalId}: ${scope} (routed to ${approval.routedTo}, expires ${expiresAt})`);

  if (away) {
    const base = `${PUBLIC_RELAY_URL}/decision/${approvalId}`;
    try {
      await sendApprovalPush({
        approvalId,
        title:
          requestedUsd != null
            ? `${ref.args.provider ?? "Provider"} requests up to ${fmtUsd(requestedUsd)}`
            : `Approval required: ${ref.toolName}`,
        body: buildPhoneBody(ref, expiresAt),
        approveUrl: `${base}/approve?token=${WEBHOOK_TOKEN}`,
        denyUrl: `${base}/deny?token=${WEBHOOK_TOKEN}`,
        dashboardUrl: `${PUBLIC_RELAY_URL}/`,
      });
      log(job, `push notification sent to phone (ntfy topic)`);
    } catch (err) {
      log(job, `phone push FAILED (${(err as Error).message}) — decision available on dashboard; timeout still denies`);
    }
  }

  return new Promise<Decision>((resolve) => {
    approvalWaiters.set(approvalId, resolve);
    const timer = setTimeout(() => {
      // Silence is never consent.
      finalizeDecision(approvalId, { status: "deny", reason: "Approval expired with no decision (fail closed)." }, "timeout");
    }, policyCache.approval_timeout_seconds * 1000);
    approvalTimers.set(approvalId, timer);
  });
}

function describeScope(ref: PendingRef): string {
  if (ref.toolName === "reserve_budget") {
    const a = ref.args as Record<string, unknown>;
    return `reserve_budget ${fmtUsd(Number(a.max_usd ?? 0))} for ${a.provider}/${a.model}, ${a.max_calls} calls, concurrency ${a.max_concurrency}`;
  }
  return `${ref.toolName}(${JSON.stringify(ref.args).slice(0, 120)})`;
}

function buildPhoneBody(ref: PendingRef, expiresAt: string): string {
  const a = ref.args as Record<string, unknown>;
  const mins = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000);
  if (ref.toolName === "reserve_budget") {
    return [
      `Job: ${a.job_id}`,
      `Scope: ${a.provider}/${a.model} · ${a.max_calls} calls · concurrency ${a.max_concurrency}`,
      `Provider fallback: forbidden`,
      `Expires in ${mins} min — no answer means DENY.`,
      `The proxy stops at the approved ceiling.`,
    ].join("\n");
  }
  return `Tool: ${ref.toolName}\nArgs: ${JSON.stringify(a).slice(0, 300)}\nExpires in ${mins} min — no answer means DENY.`;
}

/** One terminal decision only; duplicates and late webhooks are no-ops. */
function finalizeDecision(approvalId: string, decision: Decision, decidedBy: string): boolean {
  const approval = pendingApprovals.get(approvalId);
  if (!approval || approval.status !== "pending") return false;
  approval.status = decidedBy === "timeout" ? "expired" : decision.status === "allow" ? "approved" : "denied";
  approval.decidedBy = decidedBy;
  const timer = approvalTimers.get(approvalId);
  if (timer) clearTimeout(timer);
  approvalTimers.delete(approvalId);

  const job = jobs.get(approval.sessionId);
  log(job, `decision for ${approvalId}: ${approval.status} (by ${decidedBy})`);

  const waiter = approvalWaiters.get(approvalId);
  approvalWaiters.delete(approvalId);
  if (waiter) {
    waiter(decision);
  } else {
    // Relay restarted while the approval was pending: the session is durable,
    // so resume it directly with the decision.
    void continueSession(approval.sessionId, [
      {
        type: "user.tool_approval",
        threadId: approval.threadId,
        toolCallId: approval.toolCallId,
        approval: decision,
      },
    ]);
  }
  return true;
}

// ---------------- UI session watcher ----------------
// Sessions started in the TrueForge chat UI pause in the browser. This watcher
// polls recent sessions for turns that ended on tool.approval_required and
// routes those approvals through the exact same phone flow, then resumes the
// session over the SDK. Local mode has a single user, so the relay can see and
// resume UI sessions.

const handledToolCalls = new Set<string>();

async function watchUiSessions() {
  try {
    let inspected = 0;
    for await (const session of await client.sessions.list()) {
      if (++inspected > 10) break; // only recent sessions
      await checkSessionForPause(session.id);
    }
  } catch (err) {
    console.warn("[relay] session watcher:", (err as Error).message);
  }
}

async function checkSessionForPause(sessionId: string) {
  // Find the newest turn; only an unanswered pause on the LAST turn matters.
  let last: TrueForgeApi.Turn | undefined;
  for await (const turn of await client.sessions.listTurns(sessionId)) {
    if (!last || turn.createdAt > last.createdAt) last = turn;
  }
  if (!last || last.state.status !== "done") return;
  const pauses = last.state.requiredActions.filter(
    (a): a is TrueForgeApi.ToolApprovalRequiredEvent => a.type === "tool.approval_required",
  );
  if (pauses.length === 0) return;

  // Read the paused tool call's name/args from the persisted (pre-merged) events.
  const messages = new Map<string, TrueForgeApi.ModelMessageEvent>();
  for await (const event of await client.sessions.listTurnEvents(sessionId, last.id)) {
    if (event.type === "model.message") messages.set(event.id, event);
  }

  for (const pause of pauses) {
    for (const refCall of pause.toolCalls) {
      if (handledToolCalls.has(refCall.id)) continue;
      handledToolCalls.add(refCall.id);

      const msg = messages.get(refCall.sourceEventId);
      const call = msg?.toolCalls?.find((tc) => tc.id === refCall.id);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call?.function.arguments || "{}");
      } catch {
        /* keep {} */
      }
      const ref: PendingRef = {
        threadId: pause.threadId ?? "main",
        toolCallId: refCall.id,
        toolName: call?.toolInfo?.name ?? call?.function.name ?? "unknown_tool",
        args,
      };

      // Adopt the UI session so it shows up on the dashboard with a log.
      let job = jobs.get(sessionId);
      if (!job) {
        job = {
          jobId: `ui-${sessionId.slice(-6)}`,
          sessionId,
          status: "waiting_for_approval",
          log: [],
          startedAt: new Date().toISOString(),
        };
        jobs.set(sessionId, job);
        log(job, `adopted chat-UI session ${sessionId} (paused on ${ref.toolName})`);
      }

      void (async () => {
        const decision = await routeApproval(sessionId, ref, job!);
        await continueSession(sessionId, [
          {
            type: "user.tool_approval",
            threadId: ref.threadId,
            toolCallId: ref.toolCallId,
            approval: decision,
          },
        ]);
      })();
    }
  }
}

// ---------------- Jobs ----------------

async function startJob(prompt: string, jobId: string): Promise<JobRecord> {
  const { data: session } = await client.sessions.create({ agent: { name: AGENT_NAME } });
  const job: JobRecord = {
    jobId,
    sessionId: session.id,
    status: "running",
    log: [],
    startedAt: new Date().toISOString(),
  };
  jobs.set(session.id, job);
  log(job, `session ${session.id} created for job '${jobId}' (agent: ${AGENT_NAME})`);
  void continueSession(session.id, [{ type: "user.message", content: prompt }]);
  return job;
}

// ---------------- HTTP surface ----------------

const app = express();
app.use(express.json({ limit: "1mb" }));

function tokenOk(req: express.Request): boolean {
  const provided = String(req.query.token ?? "");
  const expected = WEBHOOK_TOKEN;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

// Phone webhook (ntfy action buttons POST here). Invalid token/id/replay => no effect.
app.post("/decision/:id/:action", (req, res) => {
  if (!tokenOk(req)) return res.status(403).send("invalid token");
  const { id, action } = req.params;
  if (action !== "approve" && action !== "deny") return res.status(400).send("bad action");
  const approval = pendingApprovals.get(id);
  if (!approval) return res.status(404).send("unknown approval");
  if (new Date(approval.expiresAt).getTime() < Date.now()) {
    finalizeDecision(id, { status: "deny", reason: "Approval expired with no decision (fail closed)." }, "timeout");
    return res.status(410).send("expired — denied");
  }
  const ok = finalizeDecision(
    id,
    action === "approve"
      ? { status: "allow" }
      : { status: "deny", reason: "Denied by human on mobile." },
    "phone/dashboard",
  );
  if (!ok) return res.status(409).send("already decided");
  res.send(action === "approve" ? "✅ Approved — the agent is resuming." : "🛑 Denied — the agent cannot spend.");
});

// Job submission (used by `npm run job`).
app.post("/jobs", async (req, res) => {
  const { prompt, job_id } = req.body as { prompt?: string; job_id?: string };
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  try {
    const job = await startJob(prompt, job_id ?? "demo-eval");
    res.json({ session_id: job.sessionId, job_id: job.jobId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Presence.
app.post("/heartbeat", (_req, res) => {
  lastHeartbeatAt = Date.now();
  res.json({ away: isAway() });
});
app.post("/away", (req, res) => {
  manualAway = Boolean((req.body as { away?: boolean }).away);
  res.json({ away: isAway(), manualAway });
});

// Dashboard state.
app.get("/api/state", async (_req, res) => {
  let gateway: unknown = null;
  try {
    const r = await fetch(`${GATEWAY_URL}/api/status`);
    gateway = await r.json();
  } catch {
    /* gateway down */
  }
  res.json({
    away: isAway(),
    manualAway,
    webhookToken: WEBHOOK_TOKEN, // dashboard runs on the same trusted host
    approvals: [...pendingApprovals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    jobs: [...jobs.values()].map((j) => ({ ...j, log: j.log.slice(-40) })),
    gateway,
  });
});

app.get("/", (_req, res) => {
  res.type("html").send(statusPageHtml());
});

setInterval(() => void watchUiSessions(), 5000);

app.listen(RELAY_PORT, "0.0.0.0", () => {
  console.log(`[onguard-relay] listening on ${PUBLIC_RELAY_URL}`);
  console.log(`  Watching TrueForge chat-UI sessions for approval pauses (every 5s).`);
  console.log(`  Dashboard:        ${PUBLIC_RELAY_URL}/`);
  console.log(`  Phone webhook:    ${PUBLIC_RELAY_URL}/decision/:id/:action`);
  console.log(`  TrueForge:        ${process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790"} (agent: ${AGENT_NAME})`);
  console.log(`  ntfy topic:       ${process.env.NTFY_TOPIC ?? "(NTFY_TOPIC NOT SET — phone pushes disabled)"}`);
  if (!process.env.WEBHOOK_TOKEN) {
    console.log(`  WEBHOOK_TOKEN not set — generated for this run: ${WEBHOOK_TOKEN}`);
  }
  console.log(`  Phone must reach the relay: same Wi-Fi via ${PUBLIC_RELAY_URL}, or set PUBLIC_RELAY_URL to a tunnel URL.`);
});
