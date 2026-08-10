import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupExpiredLearningRecords,
  handleLearningRequest,
  retrieveLearningExamples,
} from "../cloudflare/worker/src/neonLearning.js";
import worker, { cleanupScheduledData, handleRequest } from "../cloudflare/worker/src/index.js";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const TESTING_ORIGIN = `https://${TESTING_HOST}`;
const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const NOW = new Date("2026-08-09T12:00:00.000Z");
const KNOWN = { contactName: "Alex Rivera", company: "Northwind", profileUrl: "", profileHandle: "" };

function env() {
  return {
    DEPLOYMENT_ENVIRONMENT: "testing",
    NEON_TESTING: { connectionString: "synthetic-testing-binding" },
    NEON_PRODUCTION: { connectionString: "synthetic-production-binding" },
    DRAFT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  };
}

function request(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const method = options.method ?? "GET";
  return new Request(`${TESTING_ORIGIN}${path}`, {
    method,
    headers: options.body === undefined
      ? options.headers
      : { "Content-Type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function classifier(recordId = "classifier-1") {
  return {
    recordId,
    record: {
      recordKind: "classifier",
      roleId: "human_resource",
      relationshipStage: "learn_interests",
      goalCategory: "discover_interests",
      provenance: "human_confirmed",
      classifierFeatures: {
        messageCountBucket: "low",
        hasIncomingQuestion: true,
        hasNeedSignal: false,
        hasPermissionSignal: false,
        hasValueDiscussionSignal: false,
        hasNextStepSignal: false,
      },
    },
  };
}

function generative(recordId = "generative-1") {
  return {
    recordId,
    knownIdentifiers: KNOWN,
    record: {
      recordKind: "generative",
      roleId: "human_resource",
      relationshipStage: "learn_interests",
      goalCategory: "discover_interests",
      provenance: "independently_user_authored",
      target: "I would like to understand the Northwind role before deciding, Alex Rivera",
      rightsAttested: true,
      privacyAttested: true,
    },
  };
}

async function directCall(path: string, options: { method?: string; body?: unknown; query?: ReturnType<typeof vi.fn>; createClient?: ReturnType<typeof vi.fn>; environment?: ReturnType<typeof env> } = {}) {
  const bindings = options.environment ?? env();
  const req = request(path, options);
  const query = options.query ?? vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const response = await handleLearningRequest(req, bindings, new URL(req.url), { accountId: ACCOUNT_A, environment: "testing" }, { query, createClient: options.createClient, now: NOW });
  if (!response) throw new Error("Expected learning response");
  return { bindings, query, response };
}

describe("current-account Neon learning boundary", () => {
  it("reports absence as enabled without creating a preference row", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ enabled: null, classifier_count: "0", evaluation_count: "0", generative_count: "0" }] });
    const { response } = await directCall("/api/learning/status", { query });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      noticeVersion: "2026-08-09-v1",
      retentionDays: 365,
      counts: { classifier: 0, evaluation: 0, generative: 0 },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toMatch(/^\s*SELECT/u);
    expect(query.mock.calls[0][1]).not.toMatch(/INSERT|UPDATE|DELETE/iu);
    expect(query.mock.calls[0][2]).toEqual([ACCOUNT_A, NOW.toISOString()]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects browser account identifiers, unknown keys, and malformed write framing before querying", async () => {
    const cases = [
      request("/api/learning/records", { method: "PUT", body: { accountId: ACCOUNT_B, records: [] } }),
      request("/api/learning/preference", { method: "PUT", body: { enabled: true, extra: true } }),
      new Request(`${TESTING_ORIGIN}/api/learning/records`, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "{}" }),
      new Request(`${TESTING_ORIGIN}/api/learning/records`, { method: "PUT", headers: { "Content-Type": "application/json", "Content-Length": "131073" }, body: "{}" }),
    ];

    for (const req of cases) {
      const query = vi.fn();
      const response = await handleLearningRequest(req, env(), new URL(req.url), { accountId: ACCOUNT_A, environment: "testing" }, { query, now: NOW });
      expect([400, 413, 415]).toContain(response?.status);
      expect(query).not.toHaveBeenCalled();
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("rate limits a recognized learning route with the server-derived opaque account", async () => {
    const bindings = env();
    await directCall("/api/learning/records", { method: "PUT", body: { records: [] }, environment: bindings });
    expect(bindings.DRAFT_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: `learning:${ACCOUNT_A}` });
  });

  it("handles strict decision routes only after rate limiting and account-header rejection, before reading their body", async () => {
    const body = {
      decision: {
        action: "useful",
        goalCategory: "discover_interests",
        kind: "evaluation",
        relationshipStage: "learn_interests",
        roleId: "human_resource",
      },
    };
    const deniedByRate = request("/api/learning/decisions/learning-decision-1", { method: "PUT", body });
    const rateText = vi.spyOn(deniedByRate, "text");
    const rateEnv = env();
    rateEnv.DRAFT_RATE_LIMITER.limit.mockResolvedValue({ success: false });
    const rateResponse = await handleLearningRequest(deniedByRate, rateEnv, new URL(deniedByRate.url), { accountId: ACCOUNT_A, environment: "testing" }, { now: NOW });
    expect(rateResponse?.status).toBe(429);
    expect(rateText).not.toHaveBeenCalled();

    const deniedByHeader = request("/api/learning/decisions/learning-decision-1", {
      method: "PUT", body, headers: { "X-Account-Id": ACCOUNT_B },
    });
    const headerText = vi.spyOn(deniedByHeader, "text");
    const headerResponse = await handleLearningRequest(deniedByHeader, env(), new URL(deniedByHeader.url), { accountId: ACCOUNT_A, environment: "testing" }, { now: NOW });
    expect(headerResponse?.status).toBe(400);
    expect(headerText).not.toHaveBeenCalled();

    const query = vi.fn();
    const queried = await directCall("/api/learning/decisions/learning-decision-1?accountId=forbidden", { method: "PUT", body, query });
    expect(queried.response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(queried.response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("routes a valid decision through the authenticated account binding and returns only its acknowledgement", async () => {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
        if (/dialogmint_learning_preferences/iu.test(sql)) return { rows: [{ enabled: true }], rowCount: 1 };
        if (/FROM dialogmint_learning_records[\s\S]+FOR UPDATE/iu.test(sql)) return { rows: [], rowCount: 0 };
        if (/INSERT INTO dialogmint_learning_records/iu.test(sql)) {
          return { rows: [{ record_id: values[1], record_kind: values[2], evaluation_action: values[7], content_digest: values[12], updated_at: values[13] }], rowCount: 1 };
        }
        throw new Error("Unexpected query");
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const { response } = await directCall("/api/learning/decisions/learning-decision-1", {
      method: "PUT",
      body: { decision: { action: "useful", goalCategory: "discover_interests", kind: "evaluation", relationshipStage: "learn_interests", roleId: "human_resource" } },
      createClient: vi.fn(() => client),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      recordId: "learning-decision-1", decision: "useful", recordKind: "evaluation", contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), changed: true, updatedAt: NOW.toISOString(),
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(client.query.mock.calls)).not.toContain(ACCOUNT_B);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("updates the current account preference and propagates its enabled state", async () => {
    for (const enabled of [false, true]) {
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
        end: vi.fn().mockResolvedValue(undefined),
      };
      const createClient = vi.fn(() => client);
      const { response } = await directCall("/api/learning/preference", { method: "PUT", body: { enabled }, createClient });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ enabled });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(createClient).toHaveBeenCalledWith(env().NEON_TESTING);
      expect(client.query.mock.calls.map((call) => call[0])).toEqual([
        "BEGIN",
        expect.stringMatching(/INSERT INTO dialogmint_learning_preferences/iu),
        expect.stringMatching(/UPDATE dialogmint_learning_records[\s\S]+WHERE account_id = \$1/iu),
        "COMMIT",
      ]);
      expect(client.query.mock.calls[1][1]).toEqual([ACCOUNT_A, enabled, NOW.toISOString()]);
      expect(client.query.mock.calls[2][1]).toEqual([ACCOUNT_A, enabled, NOW.toISOString()]);
      expect(client.end).toHaveBeenCalledTimes(1);
    }
  });

  it("validates generative uploads with transient known identifiers and stores only sanitized text", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ enabled: true }], rowCount: 1 })
      .mockImplementation(async (_binding, sql: string, values: unknown[]) => ({
        rows: [{ record_id: values[1], content_digest: values[13], inserted: true }],
        rowCount: 1,
      }));
    const { response } = await directCall("/api/learning/records", { method: "PUT", body: { records: [generative()] }, query });

    expect(response.status).toBe(200);
    const payload = await response.json() as { accepted: Array<{ recordId: string; contentDigest: string }>; duplicates: unknown[] };
    expect(payload.accepted).toEqual([{ recordId: "generative-1", contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) }]);
    expect(payload.duplicates).toEqual([]);
    const allBoundValues = query.mock.calls.flatMap((call) => call[2] ?? []);
    expect(allBoundValues).toContain("I would like to understand the [company] role before deciding, [contact]");
    expect(JSON.stringify(allBoundValues)).not.toContain("Alex Rivera");
    expect(JSON.stringify(allBoundValues)).not.toContain("Northwind");
    expect(JSON.stringify(allBoundValues)).not.toContain("knownIdentifiers");
  });

  it("requires the exact known-identifier object for generative uploads", async () => {
    const missing = generative();
    delete (missing as { knownIdentifiers?: typeof KNOWN }).knownIdentifiers;
    const extra = { ...generative(), knownIdentifiers: { ...KNOWN, email: "" } };
    for (const item of [missing, extra]) {
      const query = vi.fn();
      const { response } = await directCall("/api/learning/records", { method: "PUT", body: { records: [item] }, query });
      expect(response.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it("uses an account-bound digest and reports idempotent conflicts without returning content", async () => {
    const results: unknown[] = [];
    for (const accountId of [ACCOUNT_A, ACCOUNT_B]) {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ enabled: true }], rowCount: 1 })
        .mockImplementation(async (_binding, _sql: string, values: unknown[]) => ({ rows: [{ record_id: values[1], content_digest: values[13], inserted: false }], rowCount: 1 }));
      const req = request("/api/learning/records", { method: "PUT", body: { records: [classifier()] } });
      const response = await handleLearningRequest(req, env(), new URL(req.url), { accountId, environment: "testing" }, { query, now: NOW });
      results.push(await response?.json());
    }
    const first = results[0] as { duplicates: Array<{ contentDigest: string }> };
    const second = results[1] as { duplicates: Array<{ contentDigest: string }> };
    expect(first.duplicates).toHaveLength(1);
    expect(first.duplicates[0].contentDigest).not.toBe(second.duplicates[0].contentDigest);
    expect(JSON.stringify(first)).not.toContain("classifierFeatures");
  });

  it("computes the same semantic digest regardless of classifier key insertion order", async () => {
    const original = classifier("classifier-original");
    const reordered = classifier("classifier-reordered");
    reordered.record.classifierFeatures = {
      hasNextStepSignal: false,
      hasValueDiscussionSignal: false,
      hasPermissionSignal: false,
      hasNeedSignal: false,
      hasIncomingQuestion: true,
      messageCountBucket: "low",
    };
    const digests = [];
    for (const item of [original, reordered]) {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ enabled: true }], rowCount: 1 })
        .mockImplementationOnce(async (_binding, _sql: string, values: unknown[]) => ({
          rows: [{ record_id: values[1], content_digest: values[13], inserted: true, preference_enabled: true }],
          rowCount: 1,
        }));
      const { response } = await directCall("/api/learning/records", { method: "PUT", body: { records: [item] }, query });
      const payload = await response.json() as { accepted: Array<{ contentDigest: string }> };
      digests.push(payload.accepted[0].contentDigest);
    }
    expect(digests[0]).toBe(digests[1]);
  });

  it("locks and rechecks the preference in the insert statement so disable wins the race", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ enabled: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ record_id: null, content_digest: null, inserted: false, preference_enabled: false }], rowCount: 1 });
    const { response } = await directCall("/api/learning/records", { method: "PUT", body: { records: [classifier()] }, query });

    expect(response.status).toBe(409);
    expect(query.mock.calls[1][1]).toMatch(/SELECT enabled[\s\S]+FOR UPDATE[\s\S]+WHERE EXISTS \(SELECT 1 FROM preference WHERE enabled = true\)/iu);
  });

  it("prioritizes a record-ID collision over a separate same-content duplicate", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ enabled: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ record_id: "classifier-1", content_digest: "f".repeat(64), inserted: false }], rowCount: 1 });
    const { response } = await directCall("/api/learning/records", { method: "PUT", body: { records: [classifier()] }, query });

    expect(response.status).toBe(409);
    expect(query.mock.calls[1][1]).toMatch(/\(record_id = \$2\) AS id_match[\s\S]+ORDER BY preference_enabled DESC, inserted DESC, id_match DESC/iu);
  });

  it("lists a bounded account-scoped cursor page with only sanitized target text and strict classifier metadata", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      {
        record_id: "generative-1", record_kind: "generative", role_id: "human_resource",
        relationship_stage: "learn_interests", goal_category: "discover_interests", evaluation_action: null,
        classifier_features: null, target_text: "A sanitized response", enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        expires_at: "2027-08-09T12:00:00.000Z",
      },
      {
        record_id: "evaluation-1", record_kind: "evaluation", role_id: "human_resource",
        relationship_stage: "learn_interests", goal_category: "discover_interests", evaluation_action: "useful",
        classifier_features: null, target_text: null, enabled: true, created_at: NOW.toISOString(), updated_at: "2026-08-09T11:00:00.000Z",
        expires_at: "2027-08-09T11:00:00.000Z",
      },
      {
        record_id: "classifier-1", record_kind: "classifier", role_id: "human_resource",
        relationship_stage: "learn_interests", goal_category: "discover_interests", evaluation_action: null,
        classifier_features: classifier().record.classifierFeatures, target_text: null, enabled: true,
        created_at: NOW.toISOString(), updated_at: "2026-08-09T10:00:00.000Z", expires_at: "2027-08-09T10:00:00.000Z",
      },
    ], rowCount: 3 });
    const { response } = await directCall("/api/learning/records", { query });

    expect(response.status).toBe(200);
    const payload = await response.json() as { records: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(payload.records[0]).toMatchObject({ recordId: "generative-1", recordKind: "generative", target: "A sanitized response" });
    expect(payload.records[1]).toMatchObject({ recordId: "evaluation-1", recordKind: "evaluation", evaluationAction: "useful" });
    expect(payload.records[1]).not.toHaveProperty("target");
    expect(payload.records[2]).toMatchObject({
      recordId: "classifier-1",
      recordKind: "classifier",
      classifierFeatures: classifier().record.classifierFeatures,
    });
    expect(Object.keys(payload.records[2]).sort()).toEqual([
      "classifierFeatures", "createdAt", "enabled", "expiresAt", "goalCategory", "recordId", "recordKind",
      "relationshipStage", "roleId", "updatedAt",
    ].sort());
    expect(Object.keys(payload.records[2].classifierFeatures as Record<string, unknown>).sort()).toEqual([
      "messageCountBucket", "hasIncomingQuestion", "hasNeedSignal", "hasPermissionSignal",
      "hasValueDiscussionSignal", "hasNextStepSignal",
    ].sort());
    expect(payload.nextCursor).toBeNull();
    expect(query.mock.calls[0][1]).toMatch(/classifier_features/iu);
    expect(query.mock.calls[0][1]).toMatch(/WHERE account_id = \$1[\s\S]+LIMIT \$4/iu);
    expect(query.mock.calls[0][2]).toEqual([ACCOUNT_A, null, null, 26, NOW.toISOString()]);
  });

  it("fails closed when stored classifier metadata contains any field beyond the strict six", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      record_id: "classifier-1", record_kind: "classifier", role_id: "human_resource",
      relationship_stage: "learn_interests", goal_category: "discover_interests", evaluation_action: null,
      classifier_features: { ...classifier().record.classifierFeatures, semanticTokens: ["private"] },
      target_text: null, enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      expires_at: "2027-08-09T12:00:00.000Z",
    }], rowCount: 1 });

    const { response } = await directCall("/api/learning/records", { query });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Cloud learning is temporarily unavailable." });
  });

  it("returns a non-null cursor for 26 rows and uses it for the next account-scoped page", async () => {
    const rows = Array.from({ length: 26 }, (_value, index) => ({
      record_id: `evaluation-${String(index).padStart(2, "0")}`,
      record_kind: "evaluation",
      role_id: "human_resource",
      relationship_stage: "learn_interests",
      goal_category: "discover_interests",
      evaluation_action: "useful",
      target_text: null,
      enabled: true,
      created_at: new Date(NOW.getTime() - index * 1_000).toISOString(),
      updated_at: new Date(NOW.getTime() - index * 1_000).toISOString(),
      expires_at: "2027-08-09T12:00:00.000Z",
    }));
    const firstQuery = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
    const first = await directCall("/api/learning/records", { query: firstQuery });
    const firstPayload = await first.response.json() as { records: unknown[]; nextCursor: string };
    expect(firstPayload.records).toHaveLength(25);
    expect(firstPayload.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);

    const secondQuery = vi.fn().mockResolvedValue({ rows: [rows[25]], rowCount: 1 });
    const second = await directCall(`/api/learning/records?cursor=${firstPayload.nextCursor}`, { query: secondQuery });
    const secondPayload = await second.response.json() as { records: Array<{ recordId: string }>; nextCursor: null };
    expect(secondPayload).toEqual({ records: [expect.objectContaining({ recordId: "evaluation-25" })], nextCursor: null });
    expect(secondQuery.mock.calls[0][2].slice(0, 4)).toEqual([
      ACCOUNT_A,
      rows[24].updated_at,
      rows[24].record_id,
      26,
    ]);
  });

  it("rejects invalid cursor and cross-account query parameters before database access", async () => {
    const malformedTypedCursors = [null, 0, "2026-08-09T12:00:00Z"].map((updatedAt) =>
      Buffer.from(JSON.stringify({ updatedAt, recordId: "record-1" })).toString("base64url"));
    for (const [path, method] of [
      ["/api/learning/records?cursor=not-a-cursor", "GET"],
      ...malformedTypedCursors.map((cursor) => [`/api/learning/records?cursor=${cursor}`, "GET"]),
      [`/api/learning/records?accountId=${ACCOUNT_B}`, "GET"],
      [`/api/learning?accountId=${ACCOUNT_B}`, "DELETE"],
    ]) {
      const query = vi.fn();
      const { response } = await directCall(path, { method, query });
      expect(response.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it("deletes an individual record with both account and record ID parameters", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const { response } = await directCall("/api/learning/records/record-1", { method: "DELETE", query });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true, recordId: "record-1" });
    expect(query.mock.calls[0][1]).toMatch(/DELETE FROM dialogmint_learning_records\s+WHERE account_id = \$1 AND record_id = \$2/iu);
    expect(query.mock.calls[0][2]).toEqual([ACCOUNT_A, "record-1"]);
  });

  it("disables and deletes only the authenticated account atomically", async () => {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string) => sql.match(/DELETE FROM dialogmint_learning_records/iu)
        ? { rows: [], rowCount: 2 }
        : { rows: [], rowCount: 1 }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const createClient = vi.fn(() => client);
    const { response } = await directCall("/api/learning", { method: "DELETE", createClient });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false, deleted: 2 });
    expect(createClient).toHaveBeenCalledWith(env().NEON_TESTING);
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      expect.stringMatching(/INSERT INTO dialogmint_learning_preferences/iu),
      expect.stringMatching(/DELETE FROM dialogmint_learning_records WHERE account_id = \$1/iu),
      "COMMIT",
    ]);
    expect(client.query.mock.calls[1][0]).not.toContain(ACCOUNT_A);
    expect(client.query.mock.calls[1][1]).toEqual([ACCOUNT_A, NOW.toISOString()]);
    expect(client.query.mock.calls[2][1]).toEqual([ACCOUNT_A]);
    expect(client.query.mock.calls.flatMap((call) => call[1] ?? [])).not.toContain(ACCOUNT_B);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("rolls back disable-and-delete when the second transaction statement fails", async () => {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.match(/DELETE FROM dialogmint_learning_records/iu)) throw new Error("synthetic database failure");
        return { rows: [], rowCount: 1 };
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const { response } = await directCall("/api/learning", { method: "DELETE", createClient: vi.fn(() => client) });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Cloud learning is temporarily unavailable." });
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      expect.stringMatching(/INSERT INTO dialogmint_learning_preferences/iu),
      expect.stringMatching(/DELETE FROM dialogmint_learning_records/iu),
      "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("closes the transaction client when database connection fails", async () => {
    const client = {
      connect: vi.fn().mockRejectedValue(new Error("synthetic connection failure")),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const { response } = await directCall("/api/learning", { method: "DELETE", createClient: vi.fn(() => client) });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Cloud learning is temporarily unavailable." });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("retrieves only enabled, unexpired current-account generative examples in deterministic order", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })
      .mockResolvedValueOnce({ rows: [{ role_id: "human_resource", relationship_stage: "learn_interests", goal_category: "discover_interests", target_text: "Approved example" }] });
    const result = await retrieveLearningExamples(env().NEON_TESTING, ACCOUNT_A, {
      roleId: "human_resource", relationshipStage: "learn_interests", goalCategory: "discover_interests",
    }, { query, now: NOW });

    expect(result).toEqual([{ roleId: "human_resource", relationshipStage: "learn_interests", goalCategory: "discover_interests", target: "Approved example" }]);
    const [, sql, values] = query.mock.calls[1];
    expect(sql).toMatch(/WHERE account_id = \$1[\s\S]+enabled = true[\s\S]+record_kind = 'generative'[\s\S]+expires_at > \$2/iu);
    expect(sql).toMatch(/ORDER BY \(relationship_stage = \$3\) DESC,[\s\S]+\(role_id = \$4\) DESC,[\s\S]+\(goal_category = \$5\) DESC,[\s\S]+updated_at DESC,[\s\S]+record_id ASC[\s\S]+LIMIT 3/iu);
    expect(values).toEqual([ACCOUNT_A, NOW.toISOString(), "learn_interests", "human_resource", "discover_interests"]);
  });

  it("does not query records when learning is disabled", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ enabled: false }] });
    await expect(retrieveLearningExamples(env().NEON_TESTING, ACCOUNT_A, {
      roleId: "human_resource", relationshipStage: "learn_interests", goalCategory: "discover_interests",
    }, { query, now: NOW })).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("cleans expired records only from the active deployment environment", async () => {
    const bindings = env();
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 4 });
    await expect(cleanupExpiredLearningRecords(bindings, { query, now: NOW })).resolves.toBe(4);
    expect(query).toHaveBeenCalledWith(
      bindings.NEON_TESTING,
      expect.stringMatching(/DELETE FROM dialogmint_learning_records WHERE expires_at <= \$1/iu),
      [NOW.toISOString()],
    );
    query.mockClear();
    await expect(cleanupExpiredLearningRecords({ ...bindings, DEPLOYMENT_ENVIRONMENT: "preview" }, { query, now: NOW })).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();

    const productionQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 3 });
    await expect(cleanupExpiredLearningRecords({ ...bindings, DEPLOYMENT_ENVIRONMENT: "production" }, { query: productionQuery, now: NOW })).resolves.toBe(3);
    expect(productionQuery.mock.calls[0][0]).toBe(bindings.NEON_PRODUCTION);
    expect(productionQuery.mock.calls[0][0]).not.toBe(bindings.NEON_TESTING);
  });

  it("passes both vault and learning cleanup jobs to scheduled waitUntil", async () => {
    const bindings = env();
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 });
    await expect(cleanupScheduledData(bindings, { query, now: NOW })).resolves.toEqual([
      { testing: 2, production: 0 },
      2,
    ]);
    expect(query.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      expect.stringMatching(/DELETE FROM dialogmint_vault_snapshots WHERE expires_at <= now\(\)/iu),
      expect.stringMatching(/DELETE FROM dialogmint_learning_records WHERE expires_at <= \$1/iu),
    ]));

    const waitUntil = vi.fn();
    worker.scheduled(null, { DEPLOYMENT_ENVIRONMENT: "testing" }, { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.toEqual([{ testing: 0, production: 0 }, 0]);
  });

  it("dispatches learning after Access authentication and before any body or database work", async () => {
    const issuer = "https://dialogmint.cloudflareaccess.com";
    const audience = "testing-audience";
    const subject = "account-a";
    const opaqueAccount = createHash("sha256").update(`${issuer}\n${audience}\n${subject}`).digest("hex");
    const bindings = {
      ...env(),
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUD_TESTING: audience,
      ACCESS_AUD_PRODUCTION: "production-audience",
    };
    const verifyAccess = vi.fn(async () => ({ payload: { iss: issuer, aud: [audience], sub: subject, exp: 2_000_000_000 } }));
    const query = vi.fn().mockResolvedValue({ rows: [{ enabled: null, classifier_count: "0", evaluation_count: "0", generative_count: "0" }] });
    const authenticated = request("/api/learning/status", { headers: { "Cf-Access-Jwt-Assertion": "synthetic.assertion" } });
    const response = await handleRequest(authenticated, bindings, { verifyAccess, query, now: NOW });
    expect(response.status).toBe(200);
    expect(bindings.DRAFT_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: `learning:${opaqueAccount}` });
    expect(query.mock.calls[0][2][0]).toBe(opaqueAccount);

    for (const req of [
      request("/api/learning/records", { method: "PUT", headers: { "Content-Type": "application/json" } }),
      request("/api/learning/status", { headers: { Origin: "https://attacker.example", "Cf-Access-Jwt-Assertion": "synthetic.assertion" } }),
    ]) {
      bindings.DRAFT_RATE_LIMITER.limit.mockClear();
      query.mockClear();
      const denied = await handleRequest(req, bindings, { verifyAccess, query, now: NOW });
      expect([401, 403]).toContain(denied.status);
      expect(bindings.DRAFT_RATE_LIMITER.limit).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    }
  });
});
