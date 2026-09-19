# OnGuardForYourBill

**Remote, amount-bound approval for unattended AI spend — built on [TrueForge](https://trueforge.dev).**

A TrueForge agent finishes an overnight model-evaluation job, but **no paid request can exceed a
human-approved, provider-scoped budget grant** — even if the agent ignores its prompt, a provider
cold-start 503 tempts it to "route around" the problem, or your laptop is asleep. The approval
arrives as a **real push notification on your phone** with `Approve exactly $X` / `Deny` buttons,
and your tap resumes the **same durable TrueForge session**.

> The phone notification is the demo. The **externally enforced spend boundary** is the product:
> a transactional ledger the model cannot talk its way past.

## The one job

You give the **Overnight Evaluation Operator** a benchmark manifest and a target provider/model. It:

1. reads the immutable job policy (allowlist, auto-approve threshold, hard cap, retry policy);
2. writes and runs **estimator code in the TrueForge sandbox**, cross-checked against the gateway's authoritative `estimate_run`;
3. has a **read-only subagent** audit the plan;
4. calls `reserve_budget` — TrueForge **pauses on its native approval gate** (`tool.approval_required`);
5. the relay pushes the exact amount and scope to **your phone**; timeout = deny, silence is never consent;
6. your tap resumes the original session; the gateway issues a **signed, expiring grant**;
7. every case runs through `execute_case`, which **atomically reserves worst-case cost** before each provider call;
8. it finishes with a spend report: cases, actual spend vs. grant, remaining budget, failures.

## Architecture

```text
User / phone (ntfy app)                TrueForge harness (localhost:8790)
      ▲    │ tap Approve/Deny            - overnight-eval-operator agent
      │    ▼                             - native tool approval gate
 ntfy.sh push                            - sandbox (estimator code)
      ▲    │                             - read-only audit subagent
      │    ▼                             - durable session
Approval Relay (localhost:8789) ◄──SDK──►     │
  - streams turn events                       │ MCP (Streamable HTTP)
  - routes approvals: auto / phone / deny     ▼
  - resumes session w/ user.tool_approval   OnGuardForYourBill Gateway (localhost:8788)
  - presence (Away mode) + dashboard        - immutable job policy + price catalog
                                            - signed budget grants
                                            - transactional SQLite spend ledger
                                            - bounded 500/503 retry, NO fallback
                                            - provider credentials (only here)
                                                  │
                                                  ▼
                                            Approved provider endpoint only
```

**Security boundary, not vibes:** the agent and sandbox never see provider keys. `execute_case`
is the only path to a paid provider, and a database transaction reserves each request's
worst-case cost before the call — parallel requests cannot race past the cap. Grants are
HMAC-signed and scoped to one provider, model, dollar ceiling, call count, concurrency, and
expiry. Anything else — timeout, invalid webhook, tampered grant, ledger down — **fails closed**.

## How TrueForge is used (the judged bits)

| Capability | Where |
|---|---|
| **MCP tools** | The gateway is a real MCP server: `estimate_run`, `reserve_budget`, `execute_case`, `get_usage`, `propose_cheaper_plan`, `get_price_catalog` |
| **Human approval** | `reserve_budget` is destructive-annotated **and** listed in `require_approval_for_tools` — TrueForge pauses before money is reserved |
| **Sandbox** | The agent writes and runs its own cost-estimator code (local sandbox fallback or Daytona) |
| **Subagents** | A read-only plan auditor verifies allowlist, coverage, and concurrency before any reservation |
| **Durable sessions** | The phone decision arrives minutes later, over the SDK, into the *same* session (`user.tool_approval`); the relay can even restart while an approval is pending |
| **Skill** | `skills/budget-policy/SKILL.md` — the failure-and-budget playbook, loaded on demand |
| **Custom model endpoint** (optional) | Point TrueForge at the gateway's OpenAI-compatible proxy so even the harness's own planning tokens draw from a capped control-plane allowance |

## Quickstart

Prerequisites: **Node.js ≥ 22.14**, a model API key (any provider TrueForge supports),
and the free **[ntfy](https://ntfy.sh) app** on your phone (iOS/Android, no account needed).

```bash
git clone <this repo> && cd <repo>
npm install
cp .env.example .env
```

Edit `.env`: set `NTFY_TOPIC` to a long random string (it acts as a password), and change
`GRANT_SIGNING_KEY` / `WEBHOOK_TOKEN`.

**1. Start TrueForge** (separate terminal):

```bash
npx @truefoundry/trueforge@latest
```

Open http://localhost:8790 → **Settings → Models** → configure a provider with your API key
(e.g. OpenAI). Make sure the model in `.env` (`TRUEFORGE_MODEL`, default `openai/gpt-4o-mini`)
exists there.

**2. Start the gateway and the relay** (two terminals):

```bash
npm run gateway   # MCP server + ledger + provider proxy on :8788
npm run relay     # approval relay + dashboard on :8789
```

**3. Register the MCP server and the agent in TrueForge:**

```bash
npm run setup
```

**4. Phone:** install the ntfy app, subscribe to your `NTFY_TOPIC`. Phone and laptop must be able
to reach each other — same Wi-Fi works out of the box (the relay prints its LAN URL). Different
networks: run `ngrok http 8789` and set `PUBLIC_RELAY_URL` in `.env`.

**5. Run the job:**

```bash
npm run job                        # keyless demo: deterministic 'mock' provider
npm run job -- openai gpt-4o-mini  # real spend through the gateway (key stays in the gateway)
```

Watch the dashboard at http://localhost:8789 (also shows the live ledger), and the run in the
TrueForge Sessions UI. When the agent reserves budget above the auto-approve threshold, your
phone buzzes with the exact amount. Tap **Approve** — the same session resumes and executes.

### Or run it from the TrueForge chat UI

The relay also watches chat-UI sessions: every 5 seconds it polls for turns paused on
`tool.approval_required`, routes them through the same phone flow, and resumes the session over
the SDK. The gateway serves a benchmark library (`list_benchmarks` / `get_benchmark`, from
`demo/*-manifest.json`), so the agent finds the job by itself. Open http://localhost:8790 →
**Agents → overnight-eval-operator → Try**, and type exactly this:

> I'm heading to bed — run the overnight benchmark evaluation job without me.

The agent looks up `overnight-reasoning-suite-v2` (190 cases, Gemini 2.5 Pro), estimates it,
audits it, and pauses on `reserve_budget` for **~$137** — a few seconds later your phone buzzes
with the exact amount and scope. Gemini is simulated by default (`FAKE_PROVIDERS=gemini`), so
approving costs nothing while the estimate/approval/grant/ledger flow stays fully real. Decide
in ONE place (phone/dashboard *or* the chat's own Allow/Deny buttons); whichever answers first
wins.

More one-liners:

> Run the small demo benchmark. — 8 cases on the keyless `mock` provider, sub-cent amounts.

> For job overcap-demo, call reserve_budget for provider gemini, model gemini-2.5-pro with
> max_usd 900, max_calls 500, max_concurrency 2. I explicitly authorize $900. — instant deny
> (over the $500 hard cap): an informational push with **no** approval button.

And for the timeout branch: run the overnight prompt again and simply don't touch the phone —
after 10 minutes the approval expires, the run resumes as **denied**, and the agent proposes a
cheaper plan instead of spending.

> No `PROVIDER_API_KEY` in `.env`? The `mock` provider still exercises the entire pipeline —
> estimate, approval pause, phone push, grant, ledger, retries — with real ledger math and
> zero spend. Set the key to run real paid calls via `openai/gpt-4o-mini`.

## Film the pause: 3-minute demo script

| Time | Beat |
|---|---|
| 0:00–0:25 | The problem: an unattended agent hits a cold-start 503 and "helpfully" switches to an expensive provider. Nobody was there to say no. |
| 0:25–0:55 | `npm run job`. The agent reads the policy, runs estimator code in the sandbox, and a read-only subagent audits the plan (all visible in the TrueForge session). |
| 0:55–1:25 | `reserve_budget` fires → TrueForge emits `tool.approval_required` → the dashboard shows **AWAY** → the run pauses. **Film this.** |
| 1:25–1:55 | The phone buzzes: *"mock requests up to $0.02 · 8 calls · concurrency 2 · expires in 10 min — no answer means DENY."* Tap **Approve**. |
| 1:55–2:25 | The same session resumes. Cases execute through the proxy; the ledger ticks up on the dashboard: reserved → settled, remaining grant shrinking. |
| 2:25–2:50 | Enforcement proof (pick one below): 503 bounded retry with no fallback, or hard-cap rejection with no approval button. |
| 2:50–3:00 | Final report: cases completed, actual spend vs. approved grant, remaining budget, session audit trail in TrueForge. |

### Enforcement demos

**Bounded 503, no fallback:** in `demo/benchmark-manifest.json`, set `"simulate_503": true` on
`case-007`, resubmit. The gateway retries 3 times with exponential backoff, then returns
`PROVIDER_UNAVAILABLE`; the agent stops and reports — it *cannot* switch providers because the
grant is scoped and no other key exists anywhere it can reach.

**Hard cap — no approval button exists:** set `"hard_cap_usd": 0.002` in `demo/job-policy.json`,
restart the gateway, resubmit. The relay denies instantly (your phone gets an informational
"blocked over hard cap" push, not an approval), and even a manually approved call would be
rejected by the ledger. Only a human editing the policy file can raise it.

**Timeout = deny:** just don't touch the phone. When the approval expires the relay resumes the
session with a deny; the agent proposes a cheaper plan instead of spending.

## Tests

```bash
npm test
```

14 tests cover the judged failure policy: cap enforcement, released reservations, max-calls,
charge-full-on-unknown-usage, idempotent duplicate webhooks/reconnects, hard-cap rejection across
grants, provider/model scope lock, expiry, grant tampering (HMAC), bounded 503 retry, and the
control-plane allowance.

## Repo layout

```
src/gateway/    MCP server, immutable policy, price catalog, signed grants,
                transactional ledger, the ONLY provider call path, control-plane proxy
src/relay/      TrueForge SDK turn runner, approval router (auto/phone/deny),
                ntfy notifier, decision webhook, presence + dashboard
src/setup/      registers the MCP server + agent (with approval gating) in TrueForge
skills/         budget-policy SKILL.md (git-backed TrueForge skill)
demo/           benchmark manifest + job policy (edit these to stage failure demos)
test/           failure-policy tests (vitest)
```

## Threat model (short version)

- **Prompt injection / disobedient model:** irrelevant to spend. The ledger enforces caps in a
  transaction; the skill is a playbook, not the boundary.
- **Credential exfiltration:** the agent, prompt, sandbox, and repo contain no provider keys;
  they exist only in the gateway process env.
- **Replayed / forged webhooks:** timing-safe token check, one terminal decision per approval id,
  idempotent grant + reservation keyed by `(grant_id, request_id)`.
- **Race past the cap:** reservations are serialized SQLite transactions; worst case is reserved
  *before* the provider call and released after settle.
- **Pricing uncertainty:** missing/malformed provider usage charges the full reservation.
- **Silence:** timeouts, unreachable phones, and dead ledgers always resolve to deny/pause.

## Notification transport

ntfy.sh is the MVP transport behind a small `NotificationAdapter` (`src/relay/notify.ts`):
`sendApprovalPush` / `sendInfoPush`. Swap in Pushover, Telegram, or SMS without touching budget
enforcement — the notifier delivers a human decision; it is not the security boundary.

## Optional: meter the harness itself

Point a **custom OpenAI-compatible model provider** in TrueForge at
`http://localhost:8788/v1` (set `CONTROL_PLANE_API_KEY` in the gateway env). The agent's own
planning tokens then draw from a small control-plane allowance (`control_plane_cap_usd`) that is
tracked in the same ledger and reported in `get_usage` — no unmetered blind spot.

## License

MIT. No keys, phone numbers, or personal data live in this repo — configuration is `.env` only.
# OnGuardForYourBill
