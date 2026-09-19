/**
 * One-shot setup: registers the OnGuardForYourBill MCP server in TrueForge and
 * creates (or updates) the `overnight-eval-operator` agent with:
 *   - only the onguard MCP server attached (no ambient tools or keys),
 *   - human approval REQUIRED for reserve_budget,
 *   - sandbox + dynamic subagents enabled,
 *   - the budget-policy skill attached when SKILL_REPO_URL is configured.
 *
 * Run TrueForge first (npx @truefoundry/trueforge), then: npm run setup
 */
import "dotenv/config";

const TRUEFORGE_URL = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
const TOKEN = process.env.TRUEFORGE_TOKEN;
const AGENT_NAME = process.env.AGENT_NAME ?? "overnight-eval-operator";
const MCP_NAME = process.env.MCP_NAME ?? "onguard";
// From TrueForge's perspective. Local npx mode => localhost works. Docker
// compose => use http://host.docker.internal:8788/mcp
const GATEWAY_MCP_URL = process.env.GATEWAY_MCP_URL ?? "http://localhost:8788/mcp";
const MODEL = process.env.TRUEFORGE_MODEL ?? "openai/gpt-4o-mini";
const SANDBOX_ENABLED = process.env.SANDBOX_ENABLED !== "false";
const SKILL_REPO_URL = process.env.SKILL_REPO_URL; // e.g. https://github.com/you/onguard-for-your-bill
const SKILL_REF = process.env.SKILL_REF ?? "main";

const headers: Record<string, string> = { "content-type": "application/json" };
if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${TRUEFORGE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

const INSTRUCTIONS = `You are the Overnight Evaluation Operator. You run ONE model-evaluation
benchmark job end to end within an externally enforced budget. You cannot access provider
credentials; every paid request goes through the OnGuardForYourBill MCP gateway, which enforces
the policy even if you make a mistake.

ALL of your tools live on the single MCP server named 'onguard'. Its complete tool list:
list_benchmarks, get_benchmark, get_job_policy, get_price_catalog, estimate_run,
propose_cheaper_plan, reserve_budget, execute_case, execute_all, get_usage. There are NO other
MCP servers (no 'deferred-tools' server exists); if a tool schema is not yet loaded, discover it
on the 'onguard' server.

Users usually name the job loosely ("run the overnight benchmark", "the small demo") without
pasting a manifest. In that case call list_benchmarks, pick the matching entry, fetch it with
get_benchmark, and use its 'defaults' as the provider/model unless the user names different ones.
Derive the job id from the benchmark name if the user gave none. Only ask for a manifest if
nothing in the library matches.

Standard operating procedure for a job:

1. POLICY — Call get_job_policy first. Note the allowlist, the auto-approve threshold, the hard
   cap, and the retry policy. You may never propose a provider/model outside the allowlist.
2. ESTIMATE — If a sandbox is available, write and run a short script that parses the manifest,
   counts cases and token ceilings, and computes the worst-case cost from get_price_catalog.
   Then call estimate_run: it is the AUTHORITATIVE number. If your sandbox estimate disagrees by
   more than 5%, explain the difference before proceeding.
3. AUDIT — Delegate a read-only plan audit to a subagent: it should verify the provider/model is
   allowlisted, the worst-case estimate covers every case, and the plan respects max_concurrency.
   The subagent must only use read-only tools (get_job_policy, estimate_run, get_usage,
   get_price_catalog, propose_cheaper_plan).
4. RESERVE — Call reserve_budget with the EXACT worst-case amount from estimate_run (never round
   up "for safety"; the estimate already includes the safety margin). This pauses for human
   approval. If denied or expired, do NOT retry the same amount: call propose_cheaper_plan and
   offer a reduced plan (fewer cases, lower token ceilings, or a cheaper allowlisted model).
   A new plan requires a new estimate and a new reservation.
5. EXECUTE — For manifests with more than ~10 cases (including generated manifests), run the
   whole benchmark with ONE execute_all call: the gateway executes every case under the grant's
   concurrency with per-case atomic reservations and stops early at any cap. For small manifests
   you may use execute_case per case (request_id = case id; idempotent, safe to retry after a
   disconnect). If the result reports PROVIDER_UNAVAILABLE, the gateway already exhausted the
   bounded retry policy: STOP executing, report which cases completed, and tell the user their
   options (wait, reduce scope, or approve a specifically priced alternative). NEVER switch
   provider, model, or key on your own.
6. REPORT — Finish with get_usage: cases completed, actual spend vs. approved grant, remaining
   budget, failures, and the control-plane token spend. Be precise with dollar amounts.

Hard rules: no paid work before an approved grant; a CAP_REACHED or MAX_CALLS_REACHED error means
stop and ask for a new approval; if the gateway or ledger is unreachable, stop safely — silence
is never consent.`;

async function main() {
  console.log(`TrueForge: ${TRUEFORGE_URL}`);

  // 1) Register the MCP server (upsert).
  const mcpRes = await api("PUT", "/api/v1/settings/mcp-servers", {
    manifest: {
      type: "remote",
      name: MCP_NAME,
      url: GATEWAY_MCP_URL,
      description:
        "OnGuardForYourBill budget gateway: cost estimation, approval-gated budget reservation, and budget-enforced execution of paid model calls.",
    },
  });
  if (!mcpRes.ok) throw new Error(`MCP registration failed: ${mcpRes.status} ${await mcpRes.text()}`);
  console.log(`✓ MCP server '${MCP_NAME}' -> ${GATEWAY_MCP_URL}`);

  // 2) Optionally register the budget-policy skill (git-backed; needs the public repo).
  let skillAttached = false;
  if (SKILL_REPO_URL) {
    const skillRes = await api("PUT", "/api/v1/settings/skills", {
      manifest: {
        type: "git",
        name: "budget-policy",
        url: SKILL_REPO_URL,
        ref: SKILL_REF,
        path: "skills/budget-policy",
        description:
          "Budget and failure playbook for evaluation jobs: worst-case estimation, exact-amount reservation, bounded 500/503 retries, no provider fallback, fail-closed behavior.",
      },
    });
    if (skillRes.ok) {
      skillAttached = true;
      console.log(`✓ Skill 'budget-policy' from ${SKILL_REPO_URL} (${SKILL_REF})`);
    } else {
      console.warn(`! Skill registration failed (${skillRes.status}): ${await skillRes.text()} — continuing without it.`);
    }
  } else {
    console.log("- SKILL_REPO_URL not set; skipping the budget-policy skill (optional).");
  }

  // 3) Create or update the agent.
  const manifest = {
    model: { name: MODEL },
    instructions: INSTRUCTIONS,
    mcp_servers: [
      {
        name: MCP_NAME,
        enable_tools: ["@all"],
        require_approval_for_tools: ["reserve_budget"],
        preload: true,
      },
    ],
    skills: skillAttached && SANDBOX_ENABLED ? [{ name: "budget-policy" }] : [],
    config: {
      sandbox: { enabled: SANDBOX_ENABLED },
      generative_ui: { enabled: false },
      ask_user_questions: { enabled: false },
      dynamic_sub_agents: { enabled: true },
      iteration_limit: 80,
    },
  };

  // Fail early with a clear message when the model provider is not configured.
  const modelsRes = await api("GET", "/api/v1/models");
  const models = (await modelsRes.json()) as { data?: { fqn?: string; name?: string }[] };
  const fqns = (models.data ?? []).map((m) => m.fqn ?? m.name).filter(Boolean) as string[];
  if (fqns.length && !fqns.includes(MODEL)) {
    console.error(`
✗ Model '${MODEL}' is not configured in TrueForge.
  Open ${TRUEFORGE_URL} -> Settings -> Models, configure a provider (paste your API key),
  then either set TRUEFORGE_MODEL in .env to one of the available models or re-run setup.
  Currently available models: ${fqns.length ? fqns.join(", ") : "(none)"}`);
    process.exit(1);
  }

  const listRes = await api("GET", `/api/v1/agents?agent_name=${encodeURIComponent(AGENT_NAME)}`);
  const list = (await listRes.json()) as { data?: { id: string; name: string }[] };
  const existing = list.data?.find((a) => a.name === AGENT_NAME);

  if (existing) {
    const upd = await api("PUT", `/api/v1/agents/${existing.id}`, {
      description: "Runs one overnight model evaluation within a human-approved, provider-scoped budget grant.",
      manifest,
    });
    if (!upd.ok) throw new Error(`Agent update failed: ${upd.status} ${await upd.text()}`);
    console.log(`✓ Agent '${AGENT_NAME}' updated (id ${existing.id})`);
  } else {
    const crt = await api("POST", "/api/v1/agents", {
      name: AGENT_NAME,
      description: "Runs one overnight model evaluation within a human-approved, provider-scoped budget grant.",
      manifest,
    });
    if (!crt.ok) throw new Error(`Agent creation failed: ${crt.status} ${await crt.text()}`);
    const created = (await crt.json()) as { data?: { id: string } };
    console.log(`✓ Agent '${AGENT_NAME}' created (id ${created.data?.id})`);
  }

  console.log(`
Setup complete. Checklist:
  1. In TrueForge Settings -> Models, configure the provider for '${MODEL}'
     (or point a custom OpenAI-compatible provider at the gateway's control-plane
     proxy http://localhost:8788/v1 to meter the harness's own tokens).
  2. ${SANDBOX_ENABLED ? "Settings -> Sandbox providers: configure Daytona (needed for sandbox + skills)." : "Sandbox disabled (SANDBOX_ENABLED=false)."}
  3. Start the gateway (npm run gateway) and the relay (npm run relay).
  4. Subscribe to your NTFY_TOPIC in the ntfy phone app.
  5. Submit the demo job: npm run job
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
