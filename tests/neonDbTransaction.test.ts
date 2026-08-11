import { describe, expect, it, vi } from "vitest";
import * as neonDb from "../cloudflare/worker/src/neonDb.js";

const binding = { connectionString: "synthetic-transaction-binding" };

function transactionExport() {
  const candidate = Reflect.get(neonDb, "withNeonTransaction");
  expect(candidate).toBeTypeOf("function");
  return candidate as (
    target: typeof binding,
    operation: (query: (sql: string, values?: unknown[]) => Promise<unknown>) => Promise<unknown>,
    options: { createClient: (config: { connectionString: string }) => unknown },
  ) => Promise<unknown>;
}

describe("Neon transaction boundary", () => {
  it("runs lock and admission commands on one connected client before commit", async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        commands.push({ sql, values });
        return { rows: [] };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const createClient = vi.fn(() => client);
    const withNeonTransaction = transactionExport();

    const result = await withNeonTransaction(binding, async (query) => {
      await query("SELECT pg_advisory_xact_lock($1)", ["scope"]);
      await query("SELECT admission", ["fresh-snapshot"]);
      return "admitted";
    }, { createClient });

    expect(result).toBe("admitted");
    expect(createClient).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(commands).toEqual([
      { sql: "BEGIN ISOLATION LEVEL READ COMMITTED", values: [] },
      { sql: "SELECT pg_advisory_xact_lock($1)", values: ["scope"] },
      { sql: "SELECT admission", values: ["fresh-snapshot"] },
      { sql: "COMMIT", values: [] },
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rolls back and closes that same client when the stale-reap admission statement fails", async () => {
    const commands: string[] = [];
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string) => {
        commands.push(sql);
        if (sql === "UPDATE stale and INSERT admission") throw new Error("synthetic admission failure");
        return { rows: [] };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const withNeonTransaction = transactionExport();

    await expect(withNeonTransaction(binding, async (query) => {
      await query("SELECT pg_advisory_xact_lock($1)", ["scope"]);
      await query("UPDATE stale and INSERT admission");
    }, { createClient: () => client })).rejects.toThrow("synthetic admission failure");

    expect(commands).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "SELECT pg_advisory_xact_lock($1)",
      "UPDATE stale and INSERT admission",
      "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });
});
