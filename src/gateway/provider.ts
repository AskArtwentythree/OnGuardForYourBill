/**
 * The only code path that talks to a paid model provider.
 *
 * Provider credentials live HERE, in the gateway process — never in the
 * TrueForge agent, its prompt, the sandbox, or the repo. The gateway retries
 * 500/503 with bounded exponential backoff per policy and NEVER falls back to
 * a different provider, model, or key.
 */
import type { RetryPolicy } from "./policy.js";

export interface ProviderResult {
  ok: true;
  output: string;
  input_tokens: number;
  output_tokens: number;
  provider_request_id?: string;
}

export interface ProviderFailure {
  ok: false;
  status: number;
  attempts: number;
  message: string;
}

export class ProviderUnavailableError extends Error {
  constructor(
    public attempts: number,
    public lastStatus: number,
  ) {
    super(
      `Provider unavailable after ${attempts} bounded attempts (last status ${lastStatus}). ` +
        `Per policy: no provider/model/key fallback. Wait, reduce scope, or request an approved alternative.`,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CaseRequest {
  provider: string;
  model: string;
  prompt: string;
  max_output_tokens: number;
  /** Demo/test hook: force N simulated 503s before success (or Infinity). */
  simulate_503?: boolean;
}

/**
 * Execute one benchmark case with bounded retry. Throws ProviderUnavailableError
 * after the retry budget is exhausted.
 */
export async function callProvider(req: CaseRequest, retry: RetryPolicy): Promise<ProviderResult> {
  const started = Date.now();
  let lastStatus = 0;

  for (let attempt = 1; attempt <= retry.max_attempts; attempt++) {
    if (attempt > 1) {
      const backoff = retry.base_delay_ms * 2 ** (attempt - 2) * (1 + Math.random() * 0.3);
      if (Date.now() + backoff - started > retry.max_total_wait_ms) break;
      await sleep(backoff);
    }
    const result = await attemptOnce(req);
    if (result.ok) return result;
    lastStatus = result.status;
    // Only 500/503-class errors are retryable; anything else fails immediately.
    if (result.status !== 500 && result.status !== 502 && result.status !== 503) {
      throw new Error(`Provider error ${result.status}: ${result.message}`);
    }
  }
  throw new ProviderUnavailableError(retry.max_attempts, lastStatus);
}

/** Per-provider credentials and endpoints — all resolved inside the gateway. */
function providerConfig(provider: string): { key?: string; base: string; envHint: string } {
  if (provider === "gemini") {
    return {
      key: process.env.GEMINI_API_KEY,
      base: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
      envHint: "GEMINI_API_KEY",
    };
  }
  return {
    key: process.env.PROVIDER_API_KEY,
    base: process.env.PROVIDER_BASE_URL ?? "https://api.openai.com/v1",
    envHint: "PROVIDER_API_KEY",
  };
}

/**
 * Providers listed in FAKE_PROVIDERS (comma-separated) are simulated with the
 * deterministic mock backend: full budget/approval/ledger flow, zero spend.
 * Lets the demo film "approve $137 for Gemini" without a Gemini bill.
 */
function isSimulated(provider: string): boolean {
  if (provider === "mock") return true;
  return (process.env.FAKE_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(provider);
}

async function attemptOnce(req: CaseRequest): Promise<ProviderResult | { ok: false; status: number; message: string }> {
  // Deterministic failure injection for the demo/tests ("cold-start 503").
  if (req.simulate_503 || process.env.SIMULATE_PROVIDER_503 === "true") {
    return { ok: false, status: 503, message: "simulated cold-start: model instance is scaling from zero" };
  }

  if (isSimulated(req.provider)) {
    // Keyless deterministic simulation so anyone can clone the repo and run the demo.
    const outputTokens = Math.min(64, req.max_output_tokens);
    return {
      ok: true,
      output: `[simulated ${req.provider}/${req.model}] answer for: ${req.prompt.slice(0, 80)}`,
      input_tokens: Math.ceil(req.prompt.length / 3.5),
      output_tokens: outputTokens,
    };
  }

  const { key: apiKey, base: baseUrl, envHint } = providerConfig(req.provider);
  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      message: `Gateway has no ${envHint} configured for provider '${req.provider}'. Set it in the gateway's environment (never in the agent), or add the provider to FAKE_PROVIDERS to simulate it.`,
    };
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        max_tokens: req.max_output_tokens,
      }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, message: (await res.text()).slice(0, 300) };
    }
    const body = (await res.json()) as {
      id?: string;
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      ok: true,
      output: body.choices?.[0]?.message?.content ?? "",
      // Missing usage is treated upstream as "charge the full reservation".
      input_tokens: body.usage?.prompt_tokens ?? -1,
      output_tokens: body.usage?.completion_tokens ?? -1,
      provider_request_id: body.id,
    };
  } catch (err) {
    return { ok: false, status: 503, message: `network error: ${(err as Error).message}` };
  }
}
