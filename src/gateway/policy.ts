/**
 * Job policy + price catalog.
 *
 * This is the immutable policy layer of the OnGuardForYourBill gateway.
 * The TrueForge agent can READ the policy but can never change it —
 * only a human editing `demo/job-policy.json` (or env) can.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RetryPolicy {
  max_attempts: number;
  base_delay_ms: number;
  max_total_wait_ms: number;
}

export interface JobPolicy {
  policy_version: string;
  /** Reservations at or below this are auto-approved by the relay (still logged). */
  auto_approve_usd: number;
  /** Absolute ceiling. reserve_budget above this is rejected outright — no approval button. */
  hard_cap_usd: number;
  /** Providers/models the job may use. Nothing else can ever be executed. */
  allowlist: { provider: string; model: string }[];
  max_concurrency: number;
  /** Seconds a pending phone approval stays valid. Timeout = deny. */
  approval_timeout_seconds: number;
  /** Seconds a signed grant stays valid after approval. */
  grant_ttl_seconds: number;
  /** Safety margin multiplied into worst-case estimates. */
  estimate_safety_margin: number;
  retry: RetryPolicy;
  /** Hard cap for the harness's own model tokens via the control-plane proxy. */
  control_plane_cap_usd: number;
}

export interface ModelPrice {
  provider: string;
  model: string;
  /** USD per 1M input tokens */
  input_per_mtok: number;
  /** USD per 1M output tokens */
  output_per_mtok: number;
}

/** Price catalog, versioned so estimates are reproducible. */
export const PRICE_CATALOG_VERSION = "2026-09-19";

export const PRICE_CATALOG: ModelPrice[] = [
  { provider: "openai", model: "gpt-4o-mini", input_per_mtok: 0.15, output_per_mtok: 0.6 },
  { provider: "openai", model: "gpt-4.1-mini", input_per_mtok: 0.4, output_per_mtok: 1.6 },
  { provider: "openai", model: "gpt-4.1", input_per_mtok: 2.0, output_per_mtok: 8.0 },
  { provider: "gemini", model: "gemini-2.5-flash", input_per_mtok: 0.3, output_per_mtok: 2.5 },
  { provider: "gemini", model: "gemini-2.5-pro", input_per_mtok: 1.25, output_per_mtok: 10.0 },
  // Deterministic mock provider for keyless demos and tests.
  { provider: "mock", model: "mock-small", input_per_mtok: 0.15, output_per_mtok: 0.6 },
];

export function findPrice(provider: string, model: string): ModelPrice | undefined {
  return PRICE_CATALOG.find((p) => p.provider === provider && p.model === model);
}

const DEFAULT_POLICY: JobPolicy = {
  policy_version: "demo-1",
  auto_approve_usd: 0.05,
  hard_cap_usd: 5.0,
  allowlist: [
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "mock", model: "mock-small" },
  ],
  max_concurrency: 2,
  approval_timeout_seconds: 600,
  grant_ttl_seconds: 3600,
  estimate_safety_margin: 1.1,
  retry: { max_attempts: 3, base_delay_ms: 400, max_total_wait_ms: 15_000 },
  control_plane_cap_usd: 1.0,
};

let cached: JobPolicy | undefined;

export function loadPolicy(): JobPolicy {
  if (cached) return cached;
  const path = process.env.JOB_POLICY_PATH ?? resolve(process.cwd(), "demo/job-policy.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    cached = { ...DEFAULT_POLICY, ...raw };
  } catch {
    cached = DEFAULT_POLICY;
  }
  return cached!;
}

export function isAllowlisted(provider: string, model: string): boolean {
  return loadPolicy().allowlist.some((a) => a.provider === provider && a.model === model);
}

/** Worst-case USD for one case: full input + the case's max_output_tokens ceiling. */
export function worstCaseUsdForCase(
  price: ModelPrice,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  return (inputTokens * price.input_per_mtok + maxOutputTokens * price.output_per_mtok) / 1_000_000;
}

/** Crude but conservative token estimate: 1 token ≈ 3.5 chars, +10 for message framing. */
export function estimateInputTokens(prompt: string): number {
  return Math.ceil(prompt.length / 3.5) + 10;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
