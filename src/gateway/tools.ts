/**
 * The OnGuardForYourBill MCP tool surface — deliberately small.
 *
 * - Read-only tools (policy, estimate, usage, alternatives) run autonomously.
 * - `reserve_budget` is annotated destructive, so TrueForge pauses for human
 *   approval before it runs. Approval on the phone resumes the same session.
 * - `execute_case` is the ONLY path to a paid provider, and every call must
 *   atomically reserve worst-case cost against an approved, signed grant.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Ledger, LedgerError } from "./ledger.js";
import {
  PRICE_CATALOG,
  PRICE_CATALOG_VERSION,
  estimateInputTokens,
  findPrice,
  isAllowlisted,
  loadPolicy,
  round6,
  worstCaseUsdForCase,
} from "./policy.js";
import { ProviderUnavailableError, callProvider } from "./provider.js";

const CaseSchema = z.object({
  id: z.string().describe("Stable case id, e.g. 'case-001'"),
  prompt: z.string().describe("The prompt sent to the provider for this case"),
  max_output_tokens: z.number().int().positive().describe("Hard output-token ceiling for this case"),
  simulate_503: z.boolean().optional().describe("Demo/test hook: this case returns 503 from the provider"),
});

const GenerateSchema = z.object({
  count: z.number().int().positive().max(10000).describe("Number of cases to generate"),
  prompt_template: z.string().describe("Case prompt template; '{i}' is replaced with the case number"),
  max_output_tokens: z.number().int().positive().describe("Output-token ceiling applied to every generated case"),
});

const ManifestSchema = z.object({
  benchmark: z.string().describe("Benchmark name"),
  description: z.string().optional(),
  defaults: z
    .object({ provider: z.string(), model: z.string() })
    .optional()
    .describe("Provider/model this benchmark is intended for (still subject to the allowlist)"),
  cases: z.array(CaseSchema).min(1).optional().describe("Explicit case list"),
  generate: GenerateSchema.optional().describe("Alternative to 'cases': generate N templated cases (for large overnight runs)"),
});

type Manifest = z.infer<typeof ManifestSchema>;
type Case = z.infer<typeof CaseSchema>;

/** Expand a manifest into concrete cases (explicit list or generator spec). */
function expandManifest(manifest: Manifest): Case[] {
  if (manifest.cases?.length) return manifest.cases;
  if (manifest.generate) {
    const g = manifest.generate;
    return Array.from({ length: g.count }, (_, idx) => ({
      id: `case-${String(idx + 1).padStart(4, "0")}`,
      prompt: g.prompt_template.replaceAll("{i}", String(idx + 1)),
      max_output_tokens: g.max_output_tokens,
    }));
  }
  throw new Error("Manifest must contain either 'cases' or 'generate'.");
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }, null, 2) }],
    isError: true,
  };
}

/** Benchmark library: manifest JSON files served read-only from BENCHMARKS_DIR. */
function loadBenchmarks(): Manifest[] {
  const dir = process.env.BENCHMARKS_DIR ?? resolve(process.cwd(), "demo");
  const manifests: Manifest[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith("-manifest.json")) continue;
    try {
      manifests.push(JSON.parse(readFileSync(resolve(dir, file), "utf8")) as Manifest);
    } catch {
      /* skip malformed files */
    }
  }
  return manifests;
}

export function buildMcpServer(ledger: Ledger): McpServer {
  const server = new McpServer({ name: "onguard-for-your-bill", version: "1.0.0" });
  const policy = loadPolicy();

  server.registerTool(
    "list_benchmarks",
    {
      title: "List available benchmarks",
      description:
        "The registered benchmark library. When the user names a job loosely ('the overnight job', 'the small demo'), find it here instead of asking for a manifest. Returns each benchmark's name, description, intended provider/model, and case count.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      json(
        loadBenchmarks().map((m) => ({
          benchmark: m.benchmark,
          description: m.description,
          defaults: m.defaults,
          cases: m.cases?.length ?? m.generate?.count ?? 0,
          max_output_tokens: m.generate?.max_output_tokens ?? Math.max(...(m.cases ?? []).map((c) => c.max_output_tokens), 0),
        })),
      ),
  );

  server.registerTool(
    "get_benchmark",
    {
      title: "Get a benchmark manifest",
      description:
        "Fetch the full manifest of a registered benchmark by name. Pass the result unchanged to estimate_run and execute_all.",
      inputSchema: { benchmark: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ benchmark }) => {
      const m = loadBenchmarks().find((b) => b.benchmark === benchmark);
      if (!m) {
        return toolError(
          "UNKNOWN_BENCHMARK",
          `No benchmark named '${benchmark}'. Call list_benchmarks for the available names.`,
        );
      }
      return json(m);
    },
  );

  server.registerTool(
    "get_job_policy",
    {
      title: "Get job policy",
      description:
        "Read the immutable job policy: auto-approval threshold, hard cap, provider/model allowlist, retry policy, and concurrency limit. The agent can read this but can never change it.",
      inputSchema: { job_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) => json({ job_id, ...policy, price_catalog_version: PRICE_CATALOG_VERSION }),
  );

  server.registerTool(
    "estimate_run",
    {
      title: "Estimate run cost",
      description:
        "Authoritative worst-case and expected cost for a benchmark manifest on one provider/model, using the gateway's versioned price catalog plus a safety margin. Call this BEFORE reserving budget.",
      inputSchema: {
        job_id: z.string(),
        provider: z.string(),
        model: z.string(),
        manifest: ManifestSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id, provider, model, manifest }) => {
      if (!isAllowlisted(provider, model)) {
        return toolError(
          "NOT_ALLOWLISTED",
          `${provider}/${model} is not in the job policy allowlist: ${policy.allowlist.map((a) => `${a.provider}/${a.model}`).join(", ")}.`,
        );
      }
      const price = findPrice(provider, model);
      if (!price) return toolError("UNKNOWN_MODEL", `No price catalog entry for ${provider}/${model}.`);

      const cases = expandManifest(manifest);
      let worst = 0;
      let expected = 0;
      const perCase = cases.map((c) => {
        const inputTokens = estimateInputTokens(c.prompt);
        const w = worstCaseUsdForCase(price, inputTokens, c.max_output_tokens);
        const e = worstCaseUsdForCase(price, inputTokens, Math.ceil(c.max_output_tokens * 0.4));
        worst += w;
        expected += e;
        return { case_id: c.id, input_tokens_est: inputTokens, worst_case_usd: round6(w) };
      });
      worst *= policy.estimate_safety_margin;

      return json({
        job_id,
        provider,
        model,
        cases: cases.length,
        expected_usd: round6(expected),
        worst_case_usd: round6(worst),
        auto_approve_threshold_usd: policy.auto_approve_usd,
        needs_human_approval: worst > policy.auto_approve_usd,
        hard_cap_usd: policy.hard_cap_usd,
        assumptions: {
          price_catalog_version: PRICE_CATALOG_VERSION,
          input_per_mtok: price.input_per_mtok,
          output_per_mtok: price.output_per_mtok,
          safety_margin: policy.estimate_safety_margin,
          expected_assumes_output_fraction: 0.4,
        },
        per_case: perCase.length > 8 ? perCase.slice(0, 8) : perCase,
        per_case_note:
          perCase.length > 8 ? `showing 8 of ${perCase.length} cases; all are included in the totals` : undefined,
      });
    },
  );

  server.registerTool(
    "reserve_budget",
    {
      title: "Reserve budget (requires human approval)",
      description:
        "Reserve a spending grant for this job: exact max USD, provider, model, call count, concurrency, and expiry. THIS SPENDS REAL MONEY once executed against, so TrueForge pauses for human approval before running it. On approval it returns a signed grant; execute_case only works with a valid grant.",
      inputSchema: {
        job_id: z.string(),
        provider: z.string(),
        model: z.string(),
        max_usd: z.number().positive().describe("Exact worst-case USD from estimate_run"),
        max_calls: z.number().int().positive(),
        max_concurrency: z.number().int().positive(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ job_id, provider, model, max_usd, max_calls, max_concurrency }) => {
      if (!isAllowlisted(provider, model)) {
        return toolError(
          "NOT_ALLOWLISTED",
          `${provider}/${model} is not allowlisted. The grant cannot be created.`,
        );
      }
      if (max_concurrency > policy.max_concurrency) {
        return toolError(
          "CONCURRENCY_LIMIT",
          `Requested concurrency ${max_concurrency} exceeds policy limit ${policy.max_concurrency}.`,
        );
      }
      try {
        const grant = ledger.createGrant({
          job_id,
          provider,
          model,
          max_usd,
          max_calls,
          max_concurrency,
          ttl_seconds: policy.grant_ttl_seconds,
          hard_cap_usd: policy.hard_cap_usd,
        });
        return json({
          grant_id: grant.id,
          approved_scope: {
            provider: grant.provider,
            model: grant.model,
            max_usd: grant.max_usd,
            max_calls: grant.max_calls,
            max_concurrency: grant.max_concurrency,
            expires_at: grant.expires_at,
          },
          signature: grant.signature,
          note: "Grant is scoped and signed. Exceeding it, switching provider/model, or outliving expiry requires a NEW human approval.",
        });
      } catch (err) {
        if (err instanceof LedgerError) return toolError(err.code, err.message);
        throw err;
      }
    },
  );

  /** Shared per-case execution: atomic reserve -> provider call -> settle. */
  type CaseOutcome =
    | { kind: "completed"; case_id: string; charged_usd: number | null; output: string }
    | { kind: "duplicate"; case_id: string; charged_usd: number | null; output: string | null }
    | { kind: "error"; case_id: string; code: string; message: string };

  async function executeOne(
    grantId: string,
    provider: string,
    model: string,
    c: z.infer<typeof CaseSchema>,
    requestId: string,
  ): Promise<CaseOutcome> {
    let reserved = false;
    try {
      ledger.checkGrant(grantId, provider, model);
      const price = findPrice(provider, model)!;
      const inputTokens = estimateInputTokens(c.prompt);
      const worst = round6(worstCaseUsdForCase(price, inputTokens, c.max_output_tokens));

      const { event, duplicate } = ledger.reserve(grantId, requestId, c.id, worst);
      if (duplicate && event.status !== "reserved") {
        return { kind: "duplicate", case_id: c.id, charged_usd: event.actual_usd, output: event.output };
      }
      reserved = true;

      const result = await callProvider(
        { provider, model, prompt: c.prompt, max_output_tokens: c.max_output_tokens, simulate_503: c.simulate_503 },
        policy.retry,
      );

      const usageKnown = result.input_tokens >= 0 && result.output_tokens >= 0;
      const actual = usageKnown
        ? round6(worstCaseUsdForCase(price, result.input_tokens, result.output_tokens))
        : undefined; // undefined => ledger charges the full reservation (fail closed)

      const settled = ledger.settle(grantId, requestId, {
        status: "settled",
        actual_usd: actual,
        input_tokens: usageKnown ? result.input_tokens : undefined,
        output_tokens: usageKnown ? result.output_tokens : undefined,
        output: result.output,
      });
      return { kind: "completed", case_id: c.id, charged_usd: settled.actual_usd, output: result.output };
    } catch (err) {
      if (reserved) {
        try {
          ledger.settle(grantId, requestId, { status: "failed" }); // release; failed calls charge $0
        } catch {
          /* already settled */
        }
      }
      if (err instanceof ProviderUnavailableError) {
        return {
          kind: "error",
          case_id: c.id,
          code: "PROVIDER_UNAVAILABLE",
          message: `${err.message} Retry budget: ${policy.retry.max_attempts} attempts with bounded exponential backoff (policy-enforced). The gateway will NOT switch providers, models, projects, or keys.`,
        };
      }
      if (err instanceof LedgerError) return { kind: "error", case_id: c.id, code: err.code, message: err.message };
      return { kind: "error", case_id: c.id, code: "EXECUTION_FAILED", message: (err as Error).message };
    }
  }

  server.registerTool(
    "execute_case",
    {
      title: "Execute one benchmark case",
      description:
        "Run ONE benchmark case through the budget-enforcing proxy. Requires a valid grant_id from an approved reserve_budget. The gateway atomically reserves the case's worst-case cost before calling the provider, settles actual usage after, and rejects the call when the remaining grant is insufficient. Use the case id as request_id — retries with the same request_id are idempotent and never double-charge. For manifests with many cases, prefer execute_all.",
      inputSchema: {
        grant_id: z.string(),
        request_id: z.string().describe("Idempotency key; use the case id"),
        case: CaseSchema,
        provider: z.string(),
        model: z.string(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ grant_id, request_id, case: c, provider, model }) => {
      const outcome = await executeOne(grant_id, provider, model, c, request_id);
      if (outcome.kind === "error") return toolError(outcome.code, outcome.message);
      const after = ledger.getGrant(grant_id)!;
      return json({
        request_id,
        case_id: c.id,
        status: outcome.kind === "duplicate" ? "duplicate (idempotent replay, no new charge)" : "completed",
        output: outcome.output,
        charged_usd: outcome.charged_usd,
        grant_remaining_usd: round6(after.max_usd - after.used_usd - after.reserved_usd),
        calls_used: `${after.calls}/${after.max_calls}`,
      });
    },
  );

  server.registerTool(
    "execute_all",
    {
      title: "Execute the whole benchmark under the grant",
      description:
        "Run EVERY case of the manifest through the budget-enforcing proxy under an approved grant, honoring the grant's max_concurrency. Each case still gets its own atomic worst-case reservation and settlement — the run stops early the moment the grant cap, call limit, or provider retry budget is hit, and reports exactly where it stopped. Idempotent per case; safe to call again after an interruption to finish the remainder. Use this for overnight-scale manifests instead of hundreds of execute_case calls.",
      inputSchema: {
        grant_id: z.string(),
        provider: z.string(),
        model: z.string(),
        manifest: ManifestSchema,
      },
      annotations: { readOnlyHint: false },
    },
    async ({ grant_id, provider, model, manifest }) => {
      let grant;
      try {
        grant = ledger.checkGrant(grant_id, provider, model);
      } catch (err) {
        if (err instanceof LedgerError) return toolError(err.code, err.message);
        throw err;
      }
      const cases = expandManifest(manifest);
      const concurrency = Math.max(1, Math.min(grant.max_concurrency, policy.max_concurrency));

      const outcomes: CaseOutcome[] = [];
      let stopReason: { code: string; message: string; at_case: string } | undefined;
      let cursor = 0;

      const worker = async () => {
        while (!stopReason) {
          const idx = cursor++;
          if (idx >= cases.length) return;
          const c = cases[idx];
          const outcome = await executeOne(grant_id, provider, model, c, c.id);
          outcomes.push(outcome);
          if (
            outcome.kind === "error" &&
            ["PROVIDER_UNAVAILABLE", "CAP_REACHED", "MAX_CALLS_REACHED", "GRANT_EXPIRED", "GRANT_REVOKED"].includes(
              outcome.code,
            )
          ) {
            stopReason ??= { code: outcome.code, message: outcome.message, at_case: c.id };
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));

      const completed = outcomes.filter((o) => o.kind !== "error");
      const failed = outcomes.filter((o) => o.kind === "error");
      const after = ledger.getGrant(grant_id)!;
      return json({
        status: stopReason ? "stopped_early" : "completed",
        stop_reason: stopReason,
        cases_planned: cases.length,
        cases_completed: completed.length,
        cases_failed: failed.length,
        spent_usd: round6(after.used_usd),
        grant_max_usd: after.max_usd,
        grant_remaining_usd: round6(after.max_usd - after.used_usd - after.reserved_usd),
        calls_used: `${after.calls}/${after.max_calls}`,
        concurrency_used: concurrency,
        sample_outputs: completed.slice(0, 3).map((o) => ({ case_id: o.case_id, output: (o.output ?? "").slice(0, 160) })),
        failed_cases: failed.slice(0, 5).map((o) => ({ case_id: o.case_id, code: o.code })),
      });
    },
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get spend and usage",
      description:
        "Live audit view for a job: every grant with reserved/spent/remaining USD, call counts, failures, and the harness's own control-plane token spend.",
      inputSchema: { job_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) => json(ledger.usageForJob(job_id)),
  );

  server.registerTool(
    "propose_cheaper_plan",
    {
      title: "Propose cheaper alternatives",
      description:
        "Read-only alternatives after a denial: allowlisted provider/model options ranked by worst-case cost for the same manifest. Creating a new plan still requires a fresh estimate and a fresh human approval.",
      inputSchema: { job_id: z.string(), manifest: ManifestSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id, manifest }) => {
      const cases = expandManifest(manifest);
      const options = policy.allowlist
        .map((a) => {
          const price = findPrice(a.provider, a.model);
          if (!price) return undefined;
          let worst = 0;
          for (const c of cases) {
            worst += worstCaseUsdForCase(price, estimateInputTokens(c.prompt), c.max_output_tokens);
          }
          worst *= policy.estimate_safety_margin;
          return { provider: a.provider, model: a.model, worst_case_usd: round6(worst) };
        })
        .filter((x): x is NonNullable<typeof x> => x != null)
        .sort((a, b) => a.worst_case_usd - b.worst_case_usd);
      return json({
        job_id,
        note: "Other levers: fewer cases, lower max_output_tokens. Any new paid plan needs a new estimate + new approval.",
        options,
      });
    },
  );

  // Expose the price catalog for the sandbox estimator to cross-check against.
  server.registerTool(
    "get_price_catalog",
    {
      title: "Get price catalog",
      description:
        "The versioned price catalog (USD per 1M input/output tokens) the gateway uses for estimates. Use it in sandbox estimator code so your numbers match the authoritative estimate_run.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json({ version: PRICE_CATALOG_VERSION, prices: PRICE_CATALOG }),
  );

  return server;
}
