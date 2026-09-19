/**
 * Transactional spend ledger.
 *
 * The ledger — not the model, not the prompt, not the skill — is the security
 * boundary. Every paid request must atomically reserve its worst-case cost
 * against a grant before the provider is called. better-sqlite3 transactions
 * are synchronous and serialized, so parallel requests cannot race past a cap.
 */
import Database from "better-sqlite3";
import { randomUUID, createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Grant {
  id: string;
  job_id: string;
  provider: string;
  model: string;
  max_usd: number;
  max_calls: number;
  max_concurrency: number;
  used_usd: number;
  reserved_usd: number;
  calls: number;
  status: "active" | "revoked" | "expired";
  signature: string;
  created_at: string;
  expires_at: string;
}

export interface UsageEvent {
  id: number;
  grant_id: string;
  request_id: string;
  case_id: string;
  reserved_usd: number;
  actual_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  status: "reserved" | "settled" | "failed";
  output: string | null;
  created_at: string;
}

export class LedgerError extends Error {
  constructor(
    public code:
      | "CAP_REACHED"
      | "MAX_CALLS_REACHED"
      | "GRANT_EXPIRED"
      | "GRANT_NOT_FOUND"
      | "GRANT_REVOKED"
      | "SCOPE_MISMATCH"
      | "HARD_CAP_EXCEEDED"
      | "INVALID_SIGNATURE",
    message: string,
  ) {
    super(message);
  }
}

const SIGNING_KEY = process.env.GRANT_SIGNING_KEY ?? "dev-only-signing-key-change-me";

export function signGrant(fields: {
  id: string;
  job_id: string;
  provider: string;
  model: string;
  max_usd: number;
  max_calls: number;
  expires_at: string;
}): string {
  const payload = [
    fields.id,
    fields.job_id,
    fields.provider,
    fields.model,
    fields.max_usd.toFixed(6),
    String(fields.max_calls),
    fields.expires_at,
  ].join("|");
  return createHmac("sha256", SIGNING_KEY).update(payload).digest("hex");
}

export class Ledger {
  db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? process.env.LEDGER_DB_PATH ?? resolve(process.cwd(), "data/ledger.sqlite");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        max_usd REAL NOT NULL,
        max_calls INTEGER NOT NULL,
        max_concurrency INTEGER NOT NULL,
        used_usd REAL NOT NULL DEFAULT 0,
        reserved_usd REAL NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        grant_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        reserved_usd REAL NOT NULL,
        actual_usd REAL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        status TEXT NOT NULL DEFAULT 'reserved',
        output TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(grant_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS control_plane (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cap_usd REAL NOT NULL,
        spent_usd REAL NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  // ---------- Grants ----------

  createGrant(input: {
    job_id: string;
    provider: string;
    model: string;
    max_usd: number;
    max_calls: number;
    max_concurrency: number;
    ttl_seconds: number;
    hard_cap_usd: number;
  }): Grant {
    const tx = this.db.transaction(() => {
      // Enforce the job-level hard cap across ALL grants for this job.
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(max_usd), 0) AS total FROM grants
           WHERE job_id = ? AND status = 'active'`,
        )
        .get(input.job_id) as { total: number };
      if (row.total + input.max_usd > input.hard_cap_usd + 1e-9) {
        throw new LedgerError(
          "HARD_CAP_EXCEEDED",
          `Requested $${input.max_usd.toFixed(2)} would bring total active grants for job '${input.job_id}' to $${(row.total + input.max_usd).toFixed(2)}, above the hard cap of $${input.hard_cap_usd.toFixed(2)}. Only a human can raise the hard cap by editing the job policy.`,
        );
      }
      const id = `grant_${randomUUID()}`;
      const created_at = new Date().toISOString();
      const expires_at = new Date(Date.now() + input.ttl_seconds * 1000).toISOString();
      const signature = signGrant({
        id,
        job_id: input.job_id,
        provider: input.provider,
        model: input.model,
        max_usd: input.max_usd,
        max_calls: input.max_calls,
        expires_at,
      });
      this.db
        .prepare(
          `INSERT INTO grants (id, job_id, provider, model, max_usd, max_calls, max_concurrency, status, signature, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          id,
          input.job_id,
          input.provider,
          input.model,
          input.max_usd,
          input.max_calls,
          input.max_concurrency,
          signature,
          created_at,
          expires_at,
        );
      return this.getGrant(id)!;
    });
    return tx();
  }

  getGrant(id: string): Grant | undefined {
    return this.db.prepare(`SELECT * FROM grants WHERE id = ?`).get(id) as Grant | undefined;
  }

  /** Validate a grant for execution against the requested scope. Throws LedgerError. */
  checkGrant(grantId: string, provider: string, model: string): Grant {
    const grant = this.getGrant(grantId);
    if (!grant) throw new LedgerError("GRANT_NOT_FOUND", `No grant '${grantId}'.`);
    const expectedSig = signGrant({
      id: grant.id,
      job_id: grant.job_id,
      provider: grant.provider,
      model: grant.model,
      max_usd: grant.max_usd,
      max_calls: grant.max_calls,
      expires_at: grant.expires_at,
    });
    if (grant.signature !== expectedSig)
      throw new LedgerError("INVALID_SIGNATURE", "Grant signature verification failed. Failing closed.");
    if (grant.status === "revoked") throw new LedgerError("GRANT_REVOKED", "Grant was revoked.");
    if (new Date(grant.expires_at).getTime() < Date.now())
      throw new LedgerError("GRANT_EXPIRED", `Grant expired at ${grant.expires_at}.`);
    if (grant.provider !== provider || grant.model !== model)
      throw new LedgerError(
        "SCOPE_MISMATCH",
        `Grant is scoped to ${grant.provider}/${grant.model}, not ${provider}/${model}. Provider fallback requires a NEW human approval.`,
      );
    return grant;
  }

  // ---------- Atomic reservation ----------

  /**
   * Atomically reserve worst-case cost for one request. Idempotent on
   * (grant_id, request_id): a duplicate returns the existing event so
   * reconnects and webhook replays cannot double-charge.
   */
  reserve(grantId: string, requestId: string, caseId: string, worstCaseUsd: number): {
    event: UsageEvent;
    duplicate: boolean;
  } {
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT * FROM usage_events WHERE grant_id = ? AND request_id = ?`)
        .get(grantId, requestId) as UsageEvent | undefined;
      if (existing) return { event: existing, duplicate: true };

      const grant = this.getGrant(grantId);
      if (!grant) throw new LedgerError("GRANT_NOT_FOUND", `No grant '${grantId}'.`);
      if (grant.calls >= grant.max_calls)
        throw new LedgerError(
          "MAX_CALLS_REACHED",
          `Grant allows ${grant.max_calls} calls; all have been used.`,
        );
      const committed = grant.used_usd + grant.reserved_usd;
      if (committed + worstCaseUsd > grant.max_usd + 1e-9)
        throw new LedgerError(
          "CAP_REACHED",
          `Reserving $${worstCaseUsd.toFixed(4)} would exceed the approved grant: $${committed.toFixed(4)} of $${grant.max_usd.toFixed(4)} already committed. Request a new approval for more budget.`,
        );

      this.db
        .prepare(
          `INSERT INTO usage_events (grant_id, request_id, case_id, reserved_usd, status, created_at)
           VALUES (?, ?, ?, ?, 'reserved', ?)`,
        )
        .run(grantId, requestId, caseId, worstCaseUsd, new Date().toISOString());
      this.db
        .prepare(`UPDATE grants SET reserved_usd = reserved_usd + ?, calls = calls + 1 WHERE id = ?`)
        .run(worstCaseUsd, grantId);
      const event = this.db
        .prepare(`SELECT * FROM usage_events WHERE grant_id = ? AND request_id = ?`)
        .get(grantId, requestId) as UsageEvent;
      return { event, duplicate: false };
    });
    return tx();
  }

  /**
   * Settle a reservation with actual usage. If actual usage is unknown
   * (missing/malformed provider response), charge the full reservation —
   * pricing uncertainty must never under-charge the cap.
   */
  settle(
    grantId: string,
    requestId: string,
    result: {
      status: "settled" | "failed";
      actual_usd?: number;
      input_tokens?: number;
      output_tokens?: number;
      output?: string;
    },
  ): UsageEvent {
    const tx = this.db.transaction(() => {
      const event = this.db
        .prepare(`SELECT * FROM usage_events WHERE grant_id = ? AND request_id = ?`)
        .get(grantId, requestId) as UsageEvent | undefined;
      if (!event) throw new LedgerError("GRANT_NOT_FOUND", `No reservation for request '${requestId}'.`);
      if (event.status !== "reserved") return event; // idempotent settle

      const charge =
        result.status === "failed"
          ? 0
          : result.actual_usd == null
            ? event.reserved_usd // fail closed on pricing uncertainty
            : Math.min(result.actual_usd, event.reserved_usd);

      this.db
        .prepare(
          `UPDATE usage_events SET status = ?, actual_usd = ?, input_tokens = ?, output_tokens = ?, output = ? WHERE id = ?`,
        )
        .run(
          result.status,
          charge,
          result.input_tokens ?? null,
          result.output_tokens ?? null,
          result.output ?? null,
          event.id,
        );
      this.db
        .prepare(`UPDATE grants SET reserved_usd = reserved_usd - ?, used_usd = used_usd + ? WHERE id = ?`)
        .run(event.reserved_usd, charge, grantId);
      return this.db.prepare(`SELECT * FROM usage_events WHERE id = ?`).get(event.id) as UsageEvent;
    });
    return tx();
  }

  // ---------- Reporting ----------

  usageForJob(jobId: string) {
    const grants = this.db
      .prepare(`SELECT * FROM grants WHERE job_id = ? ORDER BY created_at`)
      .all(jobId) as Grant[];
    const events = grants.length
      ? (this.db
          .prepare(
            `SELECT * FROM usage_events WHERE grant_id IN (${grants.map(() => "?").join(",")}) ORDER BY id`,
          )
          .all(...grants.map((g) => g.id)) as UsageEvent[])
      : [];
    const reserved = grants.reduce((s, g) => s + g.reserved_usd, 0);
    const spent = grants.reduce((s, g) => s + g.used_usd, 0);
    const maxTotal = grants.filter((g) => g.status === "active").reduce((s, g) => s + g.max_usd, 0);
    return {
      job_id: jobId,
      grants: grants.map((g) => ({
        grant_id: g.id,
        provider: g.provider,
        model: g.model,
        status: g.status,
        max_usd: g.max_usd,
        used_usd: g.used_usd,
        reserved_usd: g.reserved_usd,
        remaining_usd: Math.max(0, g.max_usd - g.used_usd - g.reserved_usd),
        calls: g.calls,
        max_calls: g.max_calls,
        expires_at: g.expires_at,
      })),
      totals: {
        reserved_usd: reserved,
        spent_usd: spent,
        granted_usd: maxTotal,
        remaining_usd: Math.max(0, maxTotal - reserved - spent),
        calls: events.length,
        failures: events.filter((e) => e.status === "failed").length,
      },
      control_plane: this.controlPlane(),
    };
  }

  // ---------- Control plane (the harness's own model tokens) ----------

  initControlPlane(capUsd: number) {
    this.db
      .prepare(
        `INSERT INTO control_plane (id, cap_usd, spent_usd, requests) VALUES (1, ?, 0, 0)
         ON CONFLICT(id) DO UPDATE SET cap_usd = excluded.cap_usd`,
      )
      .run(capUsd);
  }

  controlPlane(): { cap_usd: number; spent_usd: number; requests: number } {
    return (
      (this.db.prepare(`SELECT cap_usd, spent_usd, requests FROM control_plane WHERE id = 1`).get() as
        | { cap_usd: number; spent_usd: number; requests: number }
        | undefined) ?? { cap_usd: 0, spent_usd: 0, requests: 0 }
    );
  }

  /** Pre-check before forwarding a harness model call. Throws when exhausted. */
  controlPlaneCheck() {
    const cp = this.controlPlane();
    if (cp.cap_usd > 0 && cp.spent_usd >= cp.cap_usd) {
      throw new LedgerError(
        "CAP_REACHED",
        `Control-plane allowance exhausted: $${cp.spent_usd.toFixed(4)} of $${cp.cap_usd.toFixed(2)} spent. The session stops safely; a human must raise the allowance.`,
      );
    }
  }

  controlPlaneCharge(usd: number) {
    this.db
      .prepare(`UPDATE control_plane SET spent_usd = spent_usd + ?, requests = requests + 1 WHERE id = 1`)
      .run(usd);
  }
}
