---
name: budget-policy
description: Budget and failure playbook for evaluation jobs - worst-case estimation, exact-amount reservation, bounded 500/503 retries, no provider fallback, fail-closed behavior. Load when running any job that spends money through the OnGuardForYourBill gateway.
---

# Budget policy playbook

This playbook governs any job that spends money through the OnGuardForYourBill
gateway. The gateway enforces these rules even if you do not follow them —
but following them makes the run faster, cheaper, and auditable.

## Before any paid work

1. Read the job policy with `get_job_policy`. Identify:
   - the provider/model **allowlist** — never plan around anything else;
   - `auto_approve_usd` — reservations at or below this proceed without waking a human;
   - `hard_cap_usd` — reservations above this are rejected outright, no approval exists;
   - the retry policy and `max_concurrency`.
2. Compute the worst-case cost **before** reserving:
   - worst case per case = full estimated input tokens + the case's `max_output_tokens`
     ceiling, priced from `get_price_catalog`;
   - if a sandbox is available, write a small script to compute this yourself, then
     cross-check with `estimate_run` (the authoritative number, includes the safety margin).
3. Have a read-only subagent audit the plan: allowlist compliance, coverage of every
   case, concurrency within policy.

## Reserving budget

- Call `reserve_budget` with the **exact** worst-case amount from `estimate_run`.
  Do not round up; the safety margin is already included.
- The call pauses for human approval. Approval may arrive from the user's phone;
  this can take minutes. The session survives the wait.
- **Denied or expired** means the human said no to *that* plan, not to all work:
  call `propose_cheaper_plan` and offer a smaller plan (fewer cases, lower token
  ceilings, or a cheaper allowlisted model). Every new paid plan needs a new
  estimate and a new reservation. Never resubmit the same amount hoping for a
  different answer.

## Executing

- One `execute_case` per case, `request_id` = case id (idempotent — safe to
  retry the same request after a disconnect without double-charging).
- Respect `max_concurrency` from the approved grant.
- The plan is fixed by the grant: expanding scope mid-run (more cases, more
  tokens, different model) requires a **new** reservation and approval.

## Failure behavior (non-negotiable)

- **HTTP 500/503 from the provider:** the gateway already retries with capped
  exponential backoff per policy. When a case returns `PROVIDER_UNAVAILABLE`,
  the retry budget is exhausted: stop the run, report which cases completed,
  and present the human's three options — wait, reduce scope, or approve a
  specifically priced alternative. Never switch provider, model, project, or
  key on your own.
- **CAP_REACHED / MAX_CALLS_REACHED:** the approved grant is exhausted. Stop
  and request a new approval; do not shrink outputs mid-case to squeeze under
  the cap without telling the user.
- **Gateway or ledger unreachable:** stop safely and say so. Silence is never
  consent, and an unaccounted request is worse than an unfinished job.

## Reporting

Finish every run with `get_usage` and report: cases completed vs. planned,
actual spend vs. approved grant, remaining budget, failure count, and the
control-plane (harness) token spend. Use exact dollar amounts.
