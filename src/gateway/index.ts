/**
 * OnGuardForYourBill gateway process.
 *
 * Hosts:
 *  - POST /mcp                  — the MCP server TrueForge connects to (Streamable HTTP, stateless)
 *  - GET  /api/status           — ledger snapshot for the relay status page
 *  - POST /v1/chat/completions  — optional OpenAI-compatible control-plane proxy, so even the
 *  - GET  /v1/models              harness's own planning tokens are metered and capped
 *
 * This process is the security boundary: it holds provider credentials and the
 * transactional ledger. The TrueForge agent and sandbox never see the keys.
 */
import "dotenv/config";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Ledger, LedgerError } from "./ledger.js";
import { loadPolicy } from "./policy.js";
import { buildMcpServer } from "./tools.js";

const PORT = Number(process.env.GATEWAY_PORT ?? 8788);
const policy = loadPolicy();
const ledger = new Ledger();
ledger.initControlPlane(policy.control_plane_cap_usd);

const app = express();
app.use(express.json({ limit: "4mb" }));

// ---------------- MCP endpoint (stateless streamable HTTP) ----------------

app.post("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer(ledger);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless MCP server)" },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// ---------------- Status API for the relay UI ----------------

app.get("/api/status", (req, res) => {
  const jobId = String(req.query.job_id ?? "demo-eval");
  res.json({ policy, usage: ledger.usageForJob(jobId) });
});

// ---------------- Control-plane proxy (optional) ----------------
// Point TrueForge's "custom OpenAI-compatible" model provider at this endpoint
// and the harness's own tokens draw from a small, pre-authorized allowance —
// they can never touch the workload grant.

const upstreamBase = process.env.CONTROL_PLANE_UPSTREAM ?? "https://api.openai.com/v1";
const upstreamKey = process.env.CONTROL_PLANE_API_KEY ?? process.env.PROVIDER_API_KEY;

app.get("/v1/models", async (_req, res) => {
  if (!upstreamKey) return res.status(401).json({ error: "control-plane upstream key not configured" });
  const r = await fetch(`${upstreamBase}/models`, { headers: { authorization: `Bearer ${upstreamKey}` } });
  res.status(r.status).json(await r.json());
});

app.post("/v1/chat/completions", async (req, res) => {
  if (!upstreamKey) return res.status(401).json({ error: "control-plane upstream key not configured" });
  try {
    ledger.controlPlaneCheck();
  } catch (err) {
    if (err instanceof LedgerError) {
      return res.status(429).json({
        error: { message: err.message, type: "control_plane_allowance_exhausted" },
      });
    }
    throw err;
  }

  const body = { ...req.body };
  const streaming = body.stream === true;
  if (streaming) body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };

  const upstream = await fetch(`${upstreamBase}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${upstreamKey}` },
    body: JSON.stringify(body),
  });

  // Rough control-plane pricing: use gpt-4o-mini rates as a conservative default
  // unless the model is in the catalog.
  const charge = (inTok: number, outTok: number) =>
    ledger.controlPlaneCharge((inTok * 0.15 + outTok * 0.6) / 1_000_000);

  if (!streaming) {
    const json = (await upstream.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (json.usage) charge(json.usage.prompt_tokens ?? 0, json.usage.completion_tokens ?? 0);
    return res.status(upstream.status).json(json);
  }

  // Stream passthrough; tee-parse SSE for the final usage chunk.
  res.status(upstream.status);
  res.setHeader("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try {
          const chunk = JSON.parse(line.slice(6));
          if (chunk.usage) charge(chunk.usage.prompt_tokens ?? 0, chunk.usage.completion_tokens ?? 0);
        } catch {
          /* partial or non-JSON line */
        }
      }
    }
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`[onguard-gateway] listening on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:     http://localhost:${PORT}/mcp`);
  console.log(`  Status API:       http://localhost:${PORT}/api/status`);
  console.log(`  Control-plane:    http://localhost:${PORT}/v1/chat/completions (${upstreamKey ? "enabled" : "no upstream key"})`);
  console.log(`  Policy: auto<=$${policy.auto_approve_usd}, hard cap $${policy.hard_cap_usd}, allowlist: ${policy.allowlist.map((a) => `${a.provider}/${a.model}`).join(", ")}`);
});
