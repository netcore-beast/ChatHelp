import { describe, expect, it } from "vitest";
import { buildTrainingExportBundle, validateCloudflareLoraManifest } from "../src/lib/trainingExport";
import * as trainingExport from "../src/lib/trainingExport";
import { createEmptyWorkspace } from "../src/lib/workspaceTypes";

describe("safe training export and offline LoRA validation", () => {
  it("builds cloud exports from only allowed classifier features and sanitized independent targets", () => {
    const records = [{
      recordId: "classifier-1",
      recordKind: "classifier",
      roleId: "network_marketing",
      relationshipStage: "learn_interests",
      goalCategory: "discover_interests",
      classifierFeatures: {
        messageCountBucket: "medium",
        hasIncomingQuestion: true,
        hasNeedSignal: true,
        hasPermissionSignal: false,
        hasValueDiscussionSignal: false,
        hasNextStepSignal: false,
      },
      enabled: true,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
      accountId: "FORBIDDEN-ACCOUNT",
      semanticTokens: ["FORBIDDEN-TOKEN"],
      provider: "FORBIDDEN-PROVIDER",
      rawGoal: "FORBIDDEN-GOAL",
    }, {
      recordId: "generative-1",
      recordKind: "generative",
      roleId: "network_marketing",
      relationshipStage: "learn_interests",
      goalCategory: "discover_interests",
      target: "Thanks [contact], what area interests you?",
      enabled: true,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
      modelId: "FORBIDDEN-MODEL",
      originalDraft: "FORBIDDEN-DRAFT",
      reason: "FORBIDDEN-REASON",
      outcome: "FORBIDDEN-OUTCOME",
    }, {
      recordId: "evaluation-1",
      recordKind: "evaluation",
      roleId: "network_marketing",
      relationshipStage: "learn_interests",
      goalCategory: "discover_interests",
      evaluationAction: "useful",
      enabled: true,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
    }];
    const buildCloudTrainingExports = (trainingExport as unknown as Record<string, unknown>).buildCloudTrainingExports;

    expect(typeof buildCloudTrainingExports).toBe("function");
    if (typeof buildCloudTrainingExports !== "function") return;
    const result = buildCloudTrainingExports(records);

    expect(result).toEqual({
      classifier: [{
        roleId: "network_marketing",
        relationshipStage: "learn_interests",
        goalCategory: "discover_interests",
        classifierFeatures: {
          messageCountBucket: "medium",
          hasIncomingQuestion: true,
          hasNeedSignal: true,
          hasPermissionSignal: false,
          hasValueDiscussionSignal: false,
          hasNextStepSignal: false,
        },
      }],
      generative: [{
        roleId: "network_marketing",
        relationshipStage: "learn_interests",
        goalCategory: "discover_interests",
        target: "Thanks [contact], what area interests you?",
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/FORBIDDEN|accountId|semanticTokens|provider|modelId|rawGoal|originalDraft|reason|outcome/u);
  });

  it("exports deterministic approved data without identifiers, raw conversations, secrets, or provider-assisted targets", () => {
    const workspace = createEmptyWorkspace();
    workspace.contacts = [{
      id: "private-contact-id",
      name: "PRIVATE CONTACT NAME",
      headline: "PRIVATE HEADLINE",
      profileNotes: "SECRET recovery-key-value",
      profileUrl: "https://linkedin.example/private-profile",
      platform: "linkedin",
      platformUrl: "https://linkedin.example/messages/private",
      chat: [{ id: "private-message", role: "them", body: "RAW PRIVATE MESSAGE", createdAt: "2026-08-01T00:00:00.000Z" }],
      documents: [],
      outcomes: [],
      retentionDays: 90,
    }];
    workspace.stageTrainingRecords = [{
      id: "private-confirmation-id",
      featureSchemaVersion: 1,
      role: "Network Marketing",
      messageCountBucket: "medium",
      hasIncomingQuestion: true,
      hasNeedSignal: true,
      hasPermissionSignal: false,
      hasValueDiscussionSignal: false,
      hasNextStepSignal: false,
      semanticTokens: ["career", "priorities"],
      confirmedStage: "learn_interests",
      humanConfirmed: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    }, {
      id: "unconfirmed",
      featureSchemaVersion: 1,
      role: "Network Marketing",
      messageCountBucket: "low",
      hasIncomingQuestion: false,
      hasNeedSignal: false,
      hasPermissionSignal: false,
      hasValueDiscussionSignal: false,
      hasNextStepSignal: false,
      semanticTokens: ["ignore"],
      confirmedStage: "introduce_value",
      humanConfirmed: false,
      createdAt: "2026-08-02T00:00:00.000Z",
    }];
    const baseFeedback = {
      contactId: "private-contact-id",
      role: "Network Marketing" as const,
      relationshipStage: "learn_interests" as const,
      conversationGoal: "Learn general priorities",
      provider: "local" as const,
      modelId: "local",
      action: "edited" as const,
      draft: "CLAUDE OR PROVIDER DRAFT MUST NOT EXPORT",
      outcome: "UNRELATED PRIVATE OUTCOME",
      reason: "API_KEY=SECRET-VALUE",
      origin: "independently_user_authored" as const,
      independentlyAuthoredAttested: true,
      eligibleForRetrieval: true,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    workspace.feedback = [{ ...baseFeedback, id: "approved", preferredResponse: "USER-OWNED RESPONSE" }, {
      ...baseFeedback,
      id: "provider-assisted",
      preferredResponse: "PROVIDER-ASSISTED RESPONSE",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      origin: "provider_assisted",
      independentlyAuthoredAttested: false,
    }, { ...baseFeedback, id: "unapproved", preferredResponse: "UNAPPROVED RESPONSE", eligibleForRetrieval: false }, {
      ...baseFeedback,
      id: "disabled",
      preferredResponse: "DISABLED RESPONSE",
      enabled: false,
    }];

    const first = buildTrainingExportBundle(workspace, "2026-08-08T12:00:00.000Z");
    const second = buildTrainingExportBundle({ ...workspace, feedback: [...workspace.feedback].reverse(), stageTrainingRecords: [...workspace.stageTrainingRecords].reverse() }, "2026-08-08T12:00:00.000Z");
    expect(first).toEqual(second);
    expect(first.classifierJsonl.trim().split("\n")).toHaveLength(1);
    expect(first.userAuthoredGenerativeJsonl.trim().split("\n")).toHaveLength(1);
    expect(first.userAuthoredGenerativeJsonl).toContain("USER-OWNED RESPONSE");
    expect(first.manifest.counts).toMatchObject({ classifierRecords: 1, userAuthoredGenerativeRecords: 1 });
    expect(first.manifest.byStage.learn_interests).toEqual({ classifier: 1, generative: 1 });
    expect(first.manifest.byOrigin.independently_user_authored).toBe(1);
    expect(first.manifest.uploadAllowed).toBe(false);

    const serialized = JSON.stringify(first);
    for (const forbidden of [
      "private-contact-id", "private-confirmation-id", "PRIVATE CONTACT NAME", "PRIVATE HEADLINE",
      "RAW PRIVATE MESSAGE", "linkedin.example", "recovery-key-value", "SECRET-VALUE",
      "CLAUDE OR PROVIDER DRAFT", "PROVIDER-ASSISTED RESPONSE", "UNAPPROVED RESPONSE", "DISABLED RESPONSE",
      "UNRELATED PRIVATE OUTCOME",
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("validates documented adapter constraints offline and never enables upload", () => {
    const compatible = validateCloudflareLoraManifest({
      baseModelId: "meta-llama/Llama-3.2-3B",
      reviewedSupportedBaseModels: ["meta-llama/Llama-3.2-3B"],
      modelType: "llama",
      quantized: false,
      rank: 16,
      task: "causal-lm",
      files: [
        { name: "adapter_config.json", sizeBytes: 2_000 },
        { name: "adapter_model.safetensors", sizeBytes: 100_000_000 },
      ],
      provenance: "Independently user-authored examples",
      license: "User-owned and approved for this experiment",
      approvals: { dataset: true, baseModel: true, license: true, cost: true, account: true },
    });
    expect(compatible).toEqual({ compatible: true, uploadAllowed: false, issues: [] });

    const invalid = validateCloudflareLoraManifest({
      baseModelId: "@cf/openai/gpt-oss-120b",
      reviewedSupportedBaseModels: ["meta-llama/Llama-3.2-3B"],
      modelType: "gpt",
      quantized: true,
      rank: 64,
      task: "classification",
      files: [
        { name: "wrong-name.bin", sizeBytes: 300 * 1024 * 1024 },
      ],
      provenance: "",
      license: "",
      approvals: { dataset: false, baseModel: false, license: false, cost: false, account: false },
    });
    expect(invalid.compatible).toBe(false);
    expect(invalid.uploadAllowed).toBe(false);
    expect(invalid.issues.join(" ")).toMatch(/reviewed supported base|model_type|non-quantized|rank|300 MB|adapter_config\.json|adapter_model\.safetensors|causal-LM|provenance|license|approval/i);
  });
});
