import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveNeonContext } from "../cloudflare/worker/src/neonDb.js";

const env = {
  DEPLOYMENT_ENVIRONMENT: "testing",
  NEON_TESTING: { connectionString: "synthetic-testing-binding" },
  NEON_PRODUCTION: { connectionString: "synthetic-production-binding" },
};

describe("DialogMint cloud learning and usage Neon schema", () => {
  it("defines separate constrained learning usage and allowance products", () => {
    const sql = readFileSync("cloudflare/neon/0002_dialogmint_cloud_learning_usage.sql", "utf8");
    for (const table of [
      "dialogmint_learning_preferences",
      "dialogmint_learning_records",
      "dialogmint_ai_usage_attempts",
      "dialogmint_ai_allowances",
    ]) expect(sql).toContain("CREATE TABLE IF NOT EXISTS " + table);
    expect(sql).not.toContain("ALTER TABLE dialogmint_vault_snapshots");
    expect(sql).toContain("PRIMARY KEY (account_id, request_id, attempt_id)");
    expect(sql).toContain("UNIQUE (account_id, content_digest)");
  });

  it("selects only the exact environment Hyperdrive binding", () => {
    expect(resolveNeonContext(env, "testing-chathelp-private-cloud.project-mission-ai.workers.dev"))
      .toEqual({ binding: env.NEON_TESTING, environment: "testing" });
    expect(() => resolveNeonContext(env, "attacker.example")).toThrow("unsupported_host");
  });
});
