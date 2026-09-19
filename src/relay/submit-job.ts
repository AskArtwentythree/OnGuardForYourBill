/**
 * CLI: submit the demo evaluation job to the relay.
 *
 *   npm run job                                                      # mock provider (keyless, safe)
 *   npm run job -- openai gpt-4o-mini                                # real provider (gateway holds the key)
 *   npm run job -- gemini gemini-2.5-pro demo/overnight-manifest.json # the "$137 overnight" demo
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RELAY_URL = process.env.RELAY_URL ?? `http://localhost:${process.env.RELAY_PORT ?? 8789}`;
const [provider = "mock", model = "mock-small", manifestArg] = process.argv.slice(2);

const manifestPath = manifestArg
  ? resolve(process.cwd(), manifestArg)
  : (process.env.MANIFEST_PATH ?? resolve(process.cwd(), "demo/benchmark-manifest.json"));
const manifest = readFileSync(manifestPath, "utf8");
const jobId = process.env.JOB_ID ?? "demo-eval";

const prompt = [
  `Run benchmark evaluation job '${jobId}'.`,
  ``,
  `Target provider/model: ${provider}/${model}`,
  ``,
  `Benchmark manifest (JSON):`,
  "```json",
  manifest.trim(),
  "```",
  ``,
  `Follow your standard operating procedure: read the job policy, estimate the`,
  `worst-case cost (verify with your own estimator code in the sandbox if one is`,
  `available), have the plan audited, reserve the exact budget, execute every`,
  `case, and finish with a spend report from get_usage.`,
].join("\n");

const res = await fetch(`${RELAY_URL}/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt, job_id: jobId }),
});
const body = await res.json();
if (!res.ok) {
  console.error("Failed to submit job:", body);
  process.exit(1);
}
console.log(`Job '${jobId}' submitted.`);
console.log(`  TrueForge session: ${body.session_id}`);
console.log(`  Watch it live:     ${RELAY_URL}/  (and in the TrueForge Sessions UI)`);
