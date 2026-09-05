import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openTestDatabase, type Database } from "@/db/client";

let db: Database;

const NOW = "2026-08-30T10:00:00.000Z";

function seedCustomerAndPayment(paymentId = "pay_1"): void {
  db.prepare(
    `INSERT INTO customers (id, name, email, created_at) VALUES (?, ?, ?, ?)`,
  ).run("cust_1", "Test Customer", "test@example.com", NOW);
  db.prepare(
    `INSERT INTO payments (id, customer_id, amount_paise, status, method, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(paymentId, "cust_1", 249900, "FAILED", "CARD", "simulated", NOW, NOW);
}

function insertCase(id: string, paymentId: string, state = "DETECTED"): void {
  db.prepare(
    `INSERT INTO recovery_cases (id, payment_id, customer_id, amount_paise, state, opened_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, paymentId, "cust_1", 249900, state, NOW, NOW);
}

beforeEach(() => {
  db = openTestDatabase();
});
afterEach(() => {
  db.close();
});

describe("idempotency is enforced by the database", () => {
  it("refuses a second recovery case for the same payment", () => {
    seedCustomerAndPayment();
    insertCase("case_1", "pay_1");
    expect(() => insertCase("case_2", "pay_1")).toThrow();
    const count = db.prepare("SELECT COUNT(*) AS n FROM recovery_cases").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("refuses a duplicate inbound event", () => {
    const insert = db.prepare(
      `INSERT INTO payment_events (id, idempotency_key, type, payload_json, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("evt_1", "razorpay:pay_1:failed", "PAYMENT_FAILED", "{}", NOW);
    expect(() => insert.run("evt_2", "razorpay:pay_1:failed", "PAYMENT_FAILED", "{}", NOW)).toThrow();
  });

  it("refuses to execute the same action twice", () => {
    seedCustomerAndPayment();
    insertCase("case_1", "pay_1");
    const insert = db.prepare(
      `INSERT INTO recovery_actions (id, case_id, cycle, action, idempotency_key, status, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("act_1", "case_1", 1, "RETRY_PAYMENT", "case_1:RETRY_PAYMENT:1", "PENDING", "simulated", NOW);
    expect(() =>
      insert.run("act_2", "case_1", 1, "RETRY_PAYMENT", "case_1:RETRY_PAYMENT:1", "PENDING", "simulated", NOW),
    ).toThrow();
  });
});

describe("recovered revenue cannot be fabricated", () => {
  it("refuses a recovered amount on a case that is not RECOVERED", () => {
    seedCustomerAndPayment();
    expect(() =>
      db
        .prepare(
          `INSERT INTO recovery_cases
             (id, payment_id, customer_id, amount_paise, state, opened_at, updated_at, recovered_amount_paise, recovered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("case_1", "pay_1", "cust_1", 249900, "WAITING_FOR_OUTCOME", NOW, NOW, 249900, NOW),
    ).toThrow();
  });

  it("refuses a RECOVERED case that records no recovered amount", () => {
    seedCustomerAndPayment();
    expect(() => insertCase("case_1", "pay_1", "RECOVERED")).toThrow();
  });

  it("accepts a RECOVERED case that records the amount and the time", () => {
    seedCustomerAndPayment();
    expect(() =>
      db
        .prepare(
          `INSERT INTO recovery_cases
             (id, payment_id, customer_id, amount_paise, state, opened_at, updated_at, recovered_amount_paise, recovered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("case_1", "pay_1", "cust_1", 249900, "RECOVERED", NOW, NOW, 249900, NOW),
    ).not.toThrow();
  });

  it("counts nothing as recovered when no case has been recovered", () => {
    seedCustomerAndPayment();
    insertCase("case_1", "pay_1", "WAITING_FOR_OUTCOME");
    db.prepare(
      `INSERT INTO recovery_actions (id, case_id, cycle, action, idempotency_key, status, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("act_1", "case_1", 1, "CREATE_PAYMENT_LINK", "k1", "SUCCEEDED", "razorpay_test", NOW);

    const recovered = db
      .prepare(
        `SELECT COALESCE(SUM(recovered_amount_paise), 0) AS total
         FROM recovery_cases WHERE state = 'RECOVERED'`,
      )
      .get() as { total: number };

    // A successfully created payment link is an attempt, not revenue.
    expect(recovered.total).toBe(0);
  });
});

describe("history is immutable", () => {
  beforeEach(() => {
    seedCustomerAndPayment();
    insertCase("case_1", "pay_1");
  });

  it("forbids updating the audit log", () => {
    db.prepare(
      `INSERT INTO audit_log (id, at, case_id, event, actor, detail_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("aud_1", NOW, "case_1", "CASE_CREATED", "system", "{}");
    expect(() => db.prepare(`UPDATE audit_log SET event = 'TAMPERED' WHERE id = 'aud_1'`).run()).toThrow(
      /append-only/,
    );
  });

  it("forbids deleting from the audit log", () => {
    db.prepare(
      `INSERT INTO audit_log (id, at, case_id, event, actor, detail_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("aud_1", NOW, "case_1", "CASE_CREATED", "system", "{}");
    expect(() => db.prepare(`DELETE FROM audit_log WHERE id = 'aud_1'`).run()).toThrow(/append-only/);
  });

  it("forbids rewriting a state transition", () => {
    db.prepare(
      `INSERT INTO case_state_transitions (id, case_id, from_state, to_state, trigger, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("tr_1", "case_1", "DETECTED", "ANALYZING", "evaluation_started", NOW);
    expect(() =>
      db.prepare(`UPDATE case_state_transitions SET to_state = 'RECOVERED' WHERE id = 'tr_1'`).run(),
    ).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM case_state_transitions`).run()).toThrow(/append-only/);
  });

  it("forbids rewriting an agent decision", () => {
    db.prepare(
      `INSERT INTO recovery_decisions
         (id, case_id, cycle, diagnosis, recoverability, confidence, recommended_action,
          reasoning_summary, decision_source, context_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("dec_1", "case_1", 1, "TEMPORARY_FAILURE", "HIGH", 0.86, "RETRY_PAYMENT", "why", "llm", "{}", NOW);
    expect(() =>
      db.prepare(`UPDATE recovery_decisions SET confidence = 0.99 WHERE id = 'dec_1'`).run(),
    ).toThrow(/append-only/);
  });

  it("records one decision per cycle and rejects a second", () => {
    const insert = db.prepare(
      `INSERT INTO recovery_decisions
         (id, case_id, cycle, diagnosis, recoverability, confidence, recommended_action,
          reasoning_summary, decision_source, context_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("dec_1", "case_1", 1, "TEMPORARY_FAILURE", "HIGH", 0.86, "RETRY_PAYMENT", "why", "llm", "{}", NOW);
    expect(() =>
      insert.run("dec_2", "case_1", 1, "UNKNOWN", "LOW", 0.5, "WAIT", "why", "llm", "{}", NOW),
    ).toThrow();
  });
});

describe("money columns", () => {
  it("rejects a non-positive payment amount", () => {
    db.prepare(`INSERT INTO customers (id, name, email, created_at) VALUES (?, ?, ?, ?)`).run(
      "cust_1", "T", "t@example.com", NOW,
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO payments (id, customer_id, amount_paise, status, method, provider, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("pay_x", "cust_1", 0, "FAILED", "CARD", "simulated", NOW, NOW),
    ).toThrow();
  });

  it("rejects a confidence outside 0..1", () => {
    seedCustomerAndPayment();
    expect(() =>
      db
        .prepare(
          `INSERT INTO recovery_cases (id, payment_id, customer_id, amount_paise, state, confidence, opened_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("case_1", "pay_1", "cust_1", 249900, "ANALYZING", 1.5, NOW, NOW),
    ).toThrow();
  });
});

describe("the embedded schema", () => {
  it("matches src/db/schema.sql exactly", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { SCHEMA_SQL } = await import("@/db/schema.generated");

    const onDisk = readFileSync(join(process.cwd(), "src", "db", "schema.sql"), "utf8");
    // Drift here means a schema change was made without regenerating, and the
    // running server would quietly use the old shape.
    expect(SCHEMA_SQL).toBe(onDisk);
  });
});
