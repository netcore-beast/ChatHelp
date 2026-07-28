export type PrivateModelOption = {
  id: string;
  name: string;
  description: string;
  approximateDownload: string;
};

export type PrivateAiContext = {
  contact: {
    name: string;
    headline: string;
    company: string;
    location: string;
    relationship: string;
    notes: string;
    capturedContext: string;
  };
  recentMessages: Array<{ sender: "me" | "them"; text: string; date: string }>;
  guidance: {
    role: string;
    goal: string;
    tone: string;
    boundaries: string;
    callToAction: string;
    background: string;
  };
  agenda: string;
  feedbackSummary: string;
};

export type PrivateDraft = {
  id: string;
  label: string;
  text: string;
  rationale: string;
};

export type ModelProgress = {
  progress: number;
  text: string;
};

export const PRIVATE_MODELS: PrivateModelOption[] = [
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 3B · Recommended",
    description: "Best balance for nuanced professional conversation on a capable laptop.",
    approximateDownload: "about 2.3 GB",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 1B · Lightweight",
    description: "Faster and smaller for lower-memory devices, with less nuanced writing.",
    approximateDownload: "about 0.9 GB",
  },
];

type CompletionInput = {
  messages: Array<{ role: "system" | "user"; content: string }>;
  temperature: number;
  max_tokens: number;
};

type LocalEngine = {
  chat: {
    completions: {
      create(input: CompletionInput): Promise<{
        choices: Array<{ message: { content?: string | null } }>;
      }>;
    };
  };
  unload?: () => Promise<void> | void;
};

let engine: LocalEngine | null = null;
let loadedModelId = "";

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Date.now() + "-" + Math.random().toString(36).slice(2, 9);
}

function readDrafts(raw: string): PrivateDraft[] {
  const fence = String.fromCharCode(96).repeat(3);
  const withoutFences = raw.replaceAll(fence + "json", "").replaceAll(fence, "").trim();
  const arrayStart = withoutFences.indexOf("[");
  const arrayEnd = withoutFences.lastIndexOf("]");
  const objectStart = withoutFences.indexOf("{");
  const objectEnd = withoutFences.lastIndexOf("}");

  let parsed: unknown;
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    parsed = JSON.parse(withoutFences.slice(arrayStart, arrayEnd + 1));
  } else if (objectStart >= 0 && objectEnd > objectStart) {
    parsed = JSON.parse(withoutFences.slice(objectStart, objectEnd + 1));
  } else {
    throw new Error("The local model did not return structured drafts. Please generate again.");
  }

  const candidates = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "drafts" in parsed
      ? (parsed as { drafts: unknown }).drafts
      : [];

  if (!Array.isArray(candidates)) throw new Error("The local model response could not be read.");

  const drafts = candidates.slice(0, 3).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const value = item as Record<string, unknown>;
    const text = String(value.text ?? "").trim();
    if (!text) return [];
    return [{
      id: makeId(),
      label: String(value.label ?? "Thoughtful option").trim(),
      text,
      rationale: String(value.rationale ?? "Uses the context you supplied.").trim(),
    }];
  });

  if (drafts.length < 2) throw new Error("The local model returned too few usable drafts. Please generate again.");
  return drafts;
}

export function getLoadedPrivateModel() {
  return loadedModelId;
}

export async function loadPrivateModel(
  modelId: string,
  onProgress: (progress: ModelProgress) => void,
) {
  if (!("gpu" in navigator)) {
    throw new Error("This browser does not expose WebGPU. Use a current Chrome or Edge browser, or choose local templates.");
  }

  if (engine && loadedModelId === modelId) return;
  if (engine?.unload) await engine.unload();
  engine = null;
  loadedModelId = "";

  const webllm = await import("@mlc-ai/web-llm");
  const nextEngine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
      onProgress({
        progress: Math.max(0, Math.min(1, report.progress ?? 0)),
        text: report.text || "Preparing the private model…",
      });
    },
  });

  engine = nextEngine as unknown as LocalEngine;
  loadedModelId = modelId;
}

export async function generatePrivateDrafts(context: PrivateAiContext) {
  if (!engine) throw new Error("Load a private model before generating messages.");

  const system = [
    "You are ChatHelp, a private professional communication coach running entirely on the user's device.",
    "Create exactly three distinct response messages for a conversation with a known professional contact.",
    "Use only the supplied context. Never invent achievements, personal facts, shared history, urgency, or promises.",
    "Respect the user's boundaries. Keep each message natural, specific, and under 600 characters.",
    "Do not manipulate, pressure, impersonate, or claim that a message was written by the contact.",
    "Return only a JSON array. Each item must have string keys: label, text, rationale.",
    "The approaches should be warm and contextual; direct and concise; curious and low-pressure.",
  ].join("\n");

  const user = "Prepare message options from this device-local context:\n" + JSON.stringify(context, null, 2);
  const completion = await engine.chat.completions.create({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.65,
    max_tokens: 720,
  });

  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error("The local model returned an empty response.");
  return readDrafts(content);
}
