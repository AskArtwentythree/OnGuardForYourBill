/**
 * Failure-policy tests: the judged behavior of the budget boundary.
 * Cap enforcement, idempotent replay, hard-cap rejection, scope lock,
 * expiry, and bounded 503 retry with no fallback.
 */
import { describe, expect, it } from "vitest";
import { Ledger, LedgerError } from "../src/gateway/ledger.js";
import { callProvider, ProviderUnavailableError } from "../src/gateway/provider.js";

const grantInput = {
  job_id: "job-1",
  provider: "mock",
  model: "mock-small",
  max_usd: 1.0,
  max_calls: 10,
  max_concurrency: 2,
  ttl_seconds: 3600,
  hard_cap_usd: 5.0,
};

describe("ledger cap enforcement", () => {
  it("rejects a reservation that would exceed the grant", () => {
    const ledger = new Ledger(":memory:");
    const grant = ledger.createGrant(grantInput);
    ledger.reserve(grant.id, "r1", "case-1", 0.7);
    expect(() => ledger.reserve(grant.id, "r2", "case-2", 0.5)).toThrowError(
      expect.objectContaining({ code: "CAP_REACHED" }),
    );
  });

  it("releases unused reservation on settle, allowing later calls", () => {
    const ledger = new Ledger(":memory:");
    const grant = ledger.createGrant(grantInput);
    ledger.reserve(grant.id, "r1", "case-1", 0.7);
    ledger.settle(grant.id, "r1", { status: "settled", actual_usd: 0.1 });
    // 0.9 remaining now that only 0.1 was charged
    expect(() => ledger.reserve(grant.id, "r2", "case-2", 0.5)).not.toThrow();
  });

  it("enforces max_calls", () => {
    const ledger = new Ledger(":memory:");
    const grant = ledger.createGrant({ ...grantInput, max_calls: 1 });
    ledger.reserve(grant.id, "r1", "case-1", 0.01);
    expect(() => ledger.reserve(grant.id, "r2", "case-2", 0.01)).toThrowError(
      expect.objectContaining({ code: "MAX_CALLS_REACHED" }),
    );
  });

  it("charges the full reservation when actual usage is unknown (fail closed)", () => {
    const ledger = new Ledger(":memory:");
    const grant = ledger.createGrant(grantInput);
    ledger.reserve(grant.id, "r1", "case-1", 0.25);
    const settled = ledger.settle(grant.id, "r1", { status: "settled" }); // no actual_usd
    expect(settled.actual_usd).toBeCloseTo(0.25);
  });
});

describe("idempotency (duplicate webhooks / reconnects)", () => {
  it("returns the existing event on duplicate request_id without double-charging", () => {
    const ledger = new Ledger(":memory:");
    const grant = ledger.createGrant(grantInput);
    const first = ledger.reserve(grant.id, "r1", "case-1", 0.2);
    const dup = ledger.reserve(grant.id, "r1", "case-1", 0.2);
    expect(first.duplicate).toBe(false);
    expect(dup.duplicate).toBe(true);
    expect(ledger.getGrant(grant.id)!.reserved_usd).toBeCloseTo(0.2); // once, not twice
  });

  it("settle is idempotent", () => {
    const ledger = new Ledger(":memory:");
    const grant = ledger.createGrant(grantInput);
    ledger.reserve(grant.id, "r1", "case-1", 0.2);
    ledger.settle(grant.id, "r1", { status: "settled", actual_usd: 0.05 });
    ledger.settle(grant.id, "r1", { status: "settled", actual_usd: 0.05 }); // replay
    expect(ledger.getGrant(grant.id)!.used_usd).toBeCloseTo(0.05);
  });
});

describe("hard cap and scope lock", () => {
  it("rejects grant creation above the job hard cap — no approval can exist", () => {
    const ledger = new Ledger(":memory:");
    expect(() => ledger.createGrant({ ...grantInput, max_usd: 137.42 })).toThrowError(
      expect.objectContaining({ code: "HARD_CAP_EXCEEDED" }),
    );
  });

  it("hard cap counts across multiple grants for the same job", () => {
    const ledger = new Ledger(":memory:");
    ledger.createGrant({ ...grantInput, max_usd: 3.0 });
    expect(() => ledger.createGrant({ ...grantInput, max_usd: 3.0 })).toThrowError(
      expect.objectContaining({ code: "HARD_CAP_EXCEEDED" }),
    );
  });

  it("rejects execution with a different provider/model (no silent fallback)", () => {
    const ledger = new Ledger(":memory:");
    const grant = ledger.createGrant(grantInput);
    expect(() => ledger.checkGrant(grant.id, "gemini", "gemini-2.5-pro")).toThrowError(
      expect.objectContaining({ code: "SCOPE_MISMATCH" }),
    );
  });

  it("rejects an expired grant", () => {
    const ledger = new Ledger(":memory:");
    const grant = ledger.createGrant({ ...grantInput, ttl_seconds: -1 });
    expect(() => ledger.checkGrant(grant.id, "mock", "mock-small")).toThrowError(
      expect.objectContaining({ code: "GRANT_EXPIRED" }),
    );
  });

  it("rejects a tampered grant (signature mismatch)", () => {
    const ledger = new Ledger(":memory:");
    const grant = ledger.createGrant(grantInput);
    ledger.db.prepare(`UPDATE grants SET max_usd = 999 WHERE id = ?`).run(grant.id);
    expect(() => ledger.checkGrant(grant.id, "mock", "mock-small")).toThrowError(
      expect.objectContaining({ code: "INVALID_SIGNATURE" }),
    );
  });
});

describe("bounded 503 retry, no fallback", () => {
  it("retries a 503 the configured number of times, then fails closed", async () => {
    await expect(
      callProvider(
        { provider: "mock", model: "mock-small", prompt: "hi", max_output_tokens: 10, simulate_503: true },
        { max_attempts: 3, base_delay_ms: 1, max_total_wait_ms: 1000 },
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("succeeds normally on the mock provider without simulation", async () => {
    const res = await callProvider(
      { provider: "mock", model: "mock-small", prompt: "hi", max_output_tokens: 10 },
      { max_attempts: 3, base_delay_ms: 1, max_total_wait_ms: 1000 },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("mock");
  });
});

describe("control plane allowance", () => {
  it("stops the harness's own tokens at the cap", () => {
    const ledger = new Ledger(":memory:");
    ledger.initControlPlane(0.01);
    ledger.controlPlaneCheck(); // fine
    ledger.controlPlaneCharge(0.02);
    expect(() => ledger.controlPlaneCheck()).toThrowError(
      expect.objectContaining({ code: "CAP_REACHED" }),
    );
  });
});
