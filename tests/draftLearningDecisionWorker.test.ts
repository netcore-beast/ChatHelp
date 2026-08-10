import { describe, expect, it, vi } from "vitest";
import {
  DraftDecisionConflictError,
  DraftDecisionRequestError,
  draftDecisionContentDigest,
  putDraftLearningDecision,
  validateDraftLearningDecision,
} from "../cloudflare/worker/src/draftLearningDecision.js";

const ACCOUNT_ID = "a".repeat(64);
const RECORD_ID = "learning-decision-draft-0001";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const KNOWN = { contactName: "Alex Rivera", company: "Northwind", profileUrl: "", profileHandle: "" };

function evaluationBody(action: "useful" | "not_useful") {
  return {
    decision: {
      action,
      goalCategory: "discover_interests",
      kind: "evaluation",
      relationshipStage: "learn_interests",
      roleId: "human_resource",
    },
  };
}

function authoredBody(target = "My independently written reply") {
  return {
    decision: {
      goalCategory: "discover_interests",
      kind: "generative",
      privacyAttested: true,
      provenance: "independently_user_authored",
      relationshipStage: "learn_interests",
      rightsAttested: true,
      roleId: "human_resource",
      target,
    },
    knownIdentifiers: KNOWN,
  };
}

function preference(enabled = true) {
  return { rows: [{ enabled }], rowCount: 1 };
}

function evaluationRow(action: "useful" | "not_useful") {
  return {
    rows: [{
      record_id: RECORD_ID,
      record_kind: "evaluation",
      evaluation_action: action,
      content_digest: "1".repeat(64),
      updated_at: NOW_ISO,
    }],
    rowCount: 1,
  };
}

function authoredRow(digest = "2".repeat(64), target = "My independently written reply") {
  return {
    rows: [{
      record_id: RECORD_ID,
      record_kind: "generative",
      evaluation_action: null,
      content_digest: digest,
      updated_at: NOW_ISO,
      target_text: target,
    }],
    rowCount: 1,
  };
}

function writeRow(kind: "evaluation" | "generative", action: "useful" | "not_useful" | null, digest = "3".repeat(64)) {
  return { rows: [{ record_id: RECORD_ID, record_kind: kind, evaluation_action: action, content_digest: digest, updated_at: NOW_ISO }], rowCount: 1 };
}

function transactionClient(rows: Array<{ rows: unknown[]; rowCount?: number }>, fail?: "connect" | "begin" | "query" | "commit") {
  const commands: string[] = [];
  let rowIndex = 0;
  const client = {
    connect: vi.fn(async () => {
      commands.push("CONNECT");
      if (fail === "connect") throw new Error("synthetic connection failure");
    }),
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN") {
        commands.push("BEGIN");
        if (fail === "begin") throw new Error("synthetic begin failure");
        return { rows: [], rowCount: 0 };
      }
      if (sql === "COMMIT") {
        commands.push("COMMIT");
        if (fail === "commit") throw new Error("synthetic commit failure");
        return { rows: [], rowCount: 0 };
      }
      if (sql === "ROLLBACK") {
        commands.push("ROLLBACK");
        return { rows: [], rowCount: 0 };
      }
      if (/FROM dialogmint_learning_preferences[\s\S]+FOR UPDATE/iu.test(sql)
          || /INSERT INTO dialogmint_learning_preferences[\s\S]+ON CONFLICT[\s\S]+DO UPDATE/iu.test(sql)) commands.push("PREFERENCE_LOCK");
      else if (/FROM dialogmint_learning_records[\s\S]+FOR UPDATE/iu.test(sql)) commands.push("RECORD_LOCK");
      else if (/^\s*INSERT INTO dialogmint_learning_records/iu.test(sql) || /^\s*UPDATE dialogmint_learning_records/iu.test(sql)) {
        commands.push(/^\s*INSERT INTO dialogmint_learning_records/iu.test(sql) ? "INSERT" : "UPDATE");
        if (fail === "query") throw new Error("synthetic query failure");
        return {
          rows: [{
            record_id: values[1], record_kind: values[2], evaluation_action: values[7], content_digest: values[12], updated_at: values[13],
          }],
          rowCount: 1,
        };
      }
      else commands.push("QUERY");
      if (fail === "query") throw new Error("synthetic query failure");
      return rows[rowIndex++] ?? { rows: [], rowCount: 0 };
    }),
    end: vi.fn(async () => { commands.push("END"); }),
    commands: () => commands,
  };
  return client;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((currentResolve) => { resolve = currentResolve; });
  return { promise, resolve };
}

function interleavedFreshAccountClients() {
  const firstReadyToCommit = deferred<void>();
  const secondPreferenceStarted = deferred<void>();
  const allowFirstCommit = deferred<void>();
  const firstCommitted = deferred<void>();
  let preference: "missing" | "uncommitted" | "enabled" = "missing";
  let clientCount = 0;
  const createClient = vi.fn(() => {
    const isFirst = clientCount++ === 0;
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql === "COMMIT") {
          if (isFirst) {
            firstReadyToCommit.resolve();
            await allowFirstCommit.promise;
            preference = "enabled";
            firstCommitted.resolve();
          }
          return { rows: [], rowCount: 0 };
        }
        if (/WITH created[\s\S]+INSERT INTO dialogmint_learning_preferences/iu.test(sql)) {
          if (isFirst) {
            preference = "uncommitted";
            return { rows: [{ enabled: true }], rowCount: 1 };
          }
          secondPreferenceStarted.resolve();
          await firstCommitted.promise;
          // PostgreSQL uses the pre-conflict statement snapshot here: the
          // concurrent row now exists, but this CTE's SELECT cannot see it.
          return { rows: [], rowCount: 0 };
        }
        if (/^\s*INSERT INTO dialogmint_learning_preferences/iu.test(sql)) {
          if (isFirst) {
            preference = "uncommitted";
            return /ON CONFLICT[\s\S]+DO UPDATE/iu.test(sql)
              ? { rows: [{ enabled: true }], rowCount: 1 }
              : { rows: [], rowCount: 1 };
          }
          secondPreferenceStarted.resolve();
          await firstCommitted.promise;
          return /ON CONFLICT[\s\S]+DO UPDATE/iu.test(sql)
            ? { rows: [{ enabled: true }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (/FROM dialogmint_learning_preferences[\s\S]+FOR UPDATE/iu.test(sql)) {
          return preference === "missing" ? { rows: [], rowCount: 0 } : { rows: [{ enabled: preference === "enabled" || isFirst }], rowCount: 1 };
        }
        if (/FROM dialogmint_learning_records[\s\S]+FOR UPDATE/iu.test(sql)) return { rows: [], rowCount: 0 };
        if (/^\s*INSERT INTO dialogmint_learning_records/iu.test(sql)) {
          return { rows: [{ record_id: values[1], record_kind: values[2], evaluation_action: values[7], content_digest: values[12], updated_at: values[13] }], rowCount: 1 };
        }
        throw new Error("Unexpected query");
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
  });
  return { createClient, firstReadyToCommit, secondPreferenceStarted, allowFirstCommit };
}

async function decisionCall(recordId: string, payload: unknown, client: ReturnType<typeof transactionClient>) {
  return putDraftLearningDecision({ connectionString: "synthetic" }, ACCOUNT_ID, recordId, payload, {
    createClient: () => client,
    now: NOW,
  });
}

describe("draft learning decision transaction", () => {
  it("accepts only exact evaluation and authored decision bodies", () => {
    expect(validateDraftLearningDecision(evaluationBody("useful"), NOW)).toMatchObject({
      recordKind: "evaluation", evaluationAction: "useful", provenance: "human_confirmed",
    });
    expect(validateDraftLearningDecision(authoredBody("Alex Rivera at Northwind"), NOW)).toMatchObject({
      recordKind: "generative", target: "[contact] at [company]",
    });
    for (const body of [
      { ...evaluationBody("useful"), accountId: ACCOUNT_ID },
      { decision: { ...evaluationBody("useful").decision, action: "accepted" } },
      { decision: { ...authoredBody().decision, rightsAttested: false }, knownIdentifiers: KNOWN },
      { ...authoredBody(), knownIdentifiers: { ...KNOWN, email: "" } },
    ]) expect(() => validateDraftLearningDecision(body, NOW)).toThrow(DraftDecisionRequestError);
  });

  it("inserts a missing evaluation with one account-scoped row", async () => {
    const client = transactionClient([preference(), { rows: [], rowCount: 0 }, writeRow("evaluation", "useful")]);
    await expect(decisionCall(RECORD_ID, evaluationBody("useful"), client)).resolves.toEqual({
      recordId: RECORD_ID, decision: "useful", recordKind: "evaluation", contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), changed: true, updatedAt: NOW_ISO,
    });
    expect(client.commands()).toEqual(["CONNECT", "BEGIN", "PREFERENCE_LOCK", "RECORD_LOCK", "INSERT", "COMMIT", "END"]);
  });

  it("atomically transforms one not-useful row into one authored row", async () => {
    const client = transactionClient([preference(), evaluationRow("not_useful"), writeRow("generative", null)]);
    await expect(decisionCall(RECORD_ID, authoredBody(), client)).resolves.toEqual({
      recordId: RECORD_ID, decision: "authored", recordKind: "generative", contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), changed: true, updatedAt: NOW_ISO,
    });
    expect(client.commands()).toEqual(["CONNECT", "BEGIN", "PREFERENCE_LOCK", "RECORD_LOCK", "UPDATE", "COMMIT", "END"]);
    const updateSql = client.query.mock.calls.find(([sql]) => /^\s*UPDATE dialogmint_learning_records/iu.test(sql))?.[0] as string;
    expect(updateSql).toMatch(/classifier_features = NULL,[\s\S]+evaluation_action = \$8,[\s\S]+target_text = \$9,[\s\S]+rights_attested_at = \$11/iu);
  });

  it("implements every approved transition without duplicate writes", async () => {
    const cases: Array<{
      name: string;
      current: { rows: unknown[]; rowCount?: number };
      body: ReturnType<typeof evaluationBody> | ReturnType<typeof authoredBody>;
      expected: "useful" | "not_useful" | "authored";
      changed: boolean;
      command?: "INSERT" | "UPDATE";
    }> = [
      { name: "missing authored", current: { rows: [], rowCount: 0 }, body: authoredBody(), expected: "authored", changed: true, command: "INSERT" },
      { name: "useful retry", current: evaluationRow("useful"), body: evaluationBody("useful"), expected: "useful", changed: false },
      { name: "useful becomes not useful", current: evaluationRow("useful"), body: evaluationBody("not_useful"), expected: "not_useful", changed: true, command: "UPDATE" },
      { name: "not useful retry", current: evaluationRow("not_useful"), body: evaluationBody("not_useful"), expected: "not_useful", changed: false },
      { name: "not useful becomes useful", current: evaluationRow("not_useful"), body: evaluationBody("useful"), expected: "useful", changed: true, command: "UPDATE" },
      { name: "authored accepts useful acknowledgement", current: authoredRow(), body: evaluationBody("useful"), expected: "authored", changed: false },
    ];
    for (const item of cases) {
      const kind = item.expected === "authored" ? "generative" : "evaluation";
      const action = item.expected === "authored" ? null : item.expected;
      const client = transactionClient([preference(), item.current, ...(item.command ? [writeRow(kind, action)] : [])]);
      const result = await decisionCall(RECORD_ID, item.body, client);
      expect(result).toMatchObject({ recordId: RECORD_ID, decision: item.expected, changed: item.changed });
      expect(client.commands().filter((command) => command === "INSERT" || command === "UPDATE")).toEqual(item.command ? [item.command] : []);
    }
  });

  it("rejects every incompatible stale transition without a write", async () => {
    for (const [current, body] of [
      [evaluationRow("useful"), authoredBody()],
      [authoredRow(), evaluationBody("not_useful")],
      [authoredRow("f".repeat(64), "Prior authored reply"), authoredBody("A different authored reply")],
    ] as const) {
      const client = transactionClient([preference(), current]);
      await expect(decisionCall(RECORD_ID, body, client)).rejects.toBeInstanceOf(DraftDecisionConflictError);
      expect(client.commands()).toEqual(["CONNECT", "BEGIN", "PREFERENCE_LOCK", "RECORD_LOCK", "ROLLBACK", "END"]);
    }
  });

  it("acknowledges an authored retry with the identical decision digest without a write", async () => {
    const payload = authoredBody();
    const record = validateDraftLearningDecision(payload, NOW);
    const digest = await draftDecisionContentDigest(ACCOUNT_ID, RECORD_ID, record);
    const client = transactionClient([preference(), authoredRow(digest)]);
    await expect(decisionCall(RECORD_ID, payload, client)).resolves.toMatchObject({
      decision: "authored", recordKind: "generative", contentDigest: digest, changed: false,
    });
    expect(client.commands()).toEqual(["CONNECT", "BEGIN", "PREFERENCE_LOCK", "RECORD_LOCK", "COMMIT", "END"]);
  });

  it("does not mutate when cloud learning is disabled", async () => {
    const client = transactionClient([preference(false)]);
    await expect(decisionCall(RECORD_ID, evaluationBody("useful"), client)).rejects.toMatchObject({ status: 409 });
    expect(client.commands()).toEqual(["CONNECT", "BEGIN", "PREFERENCE_LOCK", "ROLLBACK", "END"]);
  });

  it("serializes two first-use decisions without falsely treating the second preference as disabled", async () => {
    const interleaved = interleavedFreshAccountClients();
    const first = putDraftLearningDecision({ connectionString: "synthetic" }, ACCOUNT_ID, "learning-decision-first", evaluationBody("useful"), {
      createClient: interleaved.createClient,
      now: NOW,
    });
    await interleaved.firstReadyToCommit.promise;
    const second = putDraftLearningDecision({ connectionString: "synthetic" }, ACCOUNT_ID, "learning-decision-second", evaluationBody("useful"), {
      createClient: interleaved.createClient,
      now: NOW,
    });
    await interleaved.secondPreferenceStarted.promise;
    interleaved.allowFirstCommit.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ recordId: "learning-decision-first", decision: "useful", changed: true }),
      expect.objectContaining({ recordId: "learning-decision-second", decision: "useful", changed: true }),
    ]);
  });

  it("uses a record-specific digest even for identical useful evaluations", async () => {
    const first = transactionClient([preference(), { rows: [], rowCount: 0 }, writeRow("evaluation", "useful")]);
    const second = transactionClient([preference(), { rows: [], rowCount: 0 }, writeRow("evaluation", "useful")]);
    const firstResponse = await decisionCall("learning-decision-a", evaluationBody("useful"), first);
    const secondResponse = await decisionCall("learning-decision-b", evaluationBody("useful"), second);
    expect(firstResponse.contentDigest).not.toBe(secondResponse.contentDigest);
  });

  it("never returns or logs transient identifiers or authored target text", async () => {
    const client = transactionClient([preference(), { rows: [], rowCount: 0 }, writeRow("generative", null)]);
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await decisionCall(RECORD_ID, authoredBody("Alex Rivera at Northwind wrote this private reply"), client);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("Alex Rivera");
    expect(serialized).not.toContain("Northwind");
    expect(serialized).not.toContain("private reply");
    expect(logError).not.toHaveBeenCalled();
    logError.mockRestore();
  });

  it("rolls back post-BEGIN failures and always closes one client", async () => {
    for (const failure of ["begin", "query", "commit"] as const) {
      const client = transactionClient([], failure);
      await expect(decisionCall(RECORD_ID, evaluationBody("useful"), client)).rejects.toThrow();
      expect(client.commands().at(-1)).toBe("END");
      if (failure === "begin") expect(client.commands()).not.toContain("ROLLBACK");
      else expect(client.commands()).toContain("ROLLBACK");
    }
    const client = transactionClient([], "connect");
    await expect(decisionCall(RECORD_ID, evaluationBody("useful"), client)).rejects.toThrow();
    expect(client.commands()).toEqual(["CONNECT", "END"]);
  });
});
