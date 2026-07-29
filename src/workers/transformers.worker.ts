import { env, pipeline } from "@huggingface/transformers";

const MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";
const MODEL_LABEL = "Qwen 2.5 0.5B private CPU model";

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface TextGenerator {
  (messages: ChatMessage[], options: {
    max_new_tokens: number;
    do_sample: boolean;
    temperature: number;
    top_p: number;
    repetition_penalty: number;
  }): Promise<unknown>;
}

interface GeneratedItem {
  generated_text?: string | Array<{ role?: string; content?: string }>;
}

let generatorPromise: Promise<TextGenerator> | null = null;

function progressText(progress: unknown): string {
  if (!progress || typeof progress !== "object") return "Downloading the private CPU model…";
  const item = progress as { status?: unknown; file?: unknown; progress?: unknown };
  const file = typeof item.file === "string" ? item.file.split("/").at(-1) : "model data";
  const percent = typeof item.progress === "number" ? " " + Math.round(item.progress) + "%" : "";
  if (item.status === "progress") return "Downloading " + file + percent + " for private on-device use…";
  if (item.status === "ready") return MODEL_LABEL + " is ready.";
  return "Preparing " + MODEL_LABEL + "…";
}

function extractOutput(result: unknown): string {
  if (!Array.isArray(result)) return "";
  const item = result[0] as GeneratedItem | undefined;
  const generated = item?.generated_text;
  if (typeof generated === "string") return generated;
  if (Array.isArray(generated)) {
    for (let index = generated.length - 1; index >= 0; index -= 1) {
      const message = generated[index];
      if (message?.role === "assistant" && typeof message.content === "string") return message.content;
    }
    return generated.at(-1)?.content ?? "";
  }
  return "";
}

function getGenerator(requestId: number): Promise<TextGenerator> {
  if (!generatorPromise) {
    generatorPromise = pipeline("text-generation", MODEL_ID, {
      device: "wasm",
      dtype: "q4",
      progress_callback: (progress: unknown) => {
        self.postMessage({ requestId, type: "progress", message: progressText(progress) });
      },
    }) as unknown as Promise<TextGenerator>;
  }
  return generatorPromise;
}

self.addEventListener("message", (event: MessageEvent<{ requestId: number; prompt: string }>) => {
  const { requestId, prompt } = event.data;
  void (async () => {
    try {
      self.postMessage({ requestId, type: "progress", message: "Preparing " + MODEL_LABEL + "…" });
      const generator = await getGenerator(requestId);
      self.postMessage({ requestId, type: "progress", message: "Generating three private drafts with CPU/WASM…" });
      const result = await generator([
        { role: "system", content: "Follow all privacy and safety rules in the user context. Write exactly three polished professional replies. Output exactly three single-line entries labeled DRAFT 1:, DRAFT 2:, and DRAFT 3:. Do not add an introduction or explanation." },
        { role: "user", content: prompt + "\n\nOUTPUT FORMAT\nWrite all three complete messages now. Each message must be 15 to 35 words and ready to send after human review. DRAFT 1: warm and concise, acknowledging the contact and suggesting a low-pressure next step. DRAFT 2: curious and relationship-first, with one thoughtful question. DRAFT 3: direct but friendly, focused on mutual value and an optional brief call." },
      ], {
        max_new_tokens: 144,
        do_sample: false,
        temperature: 0.2,
        top_p: 0.9,
        repetition_penalty: 1.08,
      });
      const output = extractOutput(result).trim();
      if (!output) throw new Error("The private CPU model returned no text.");
      self.postMessage({ requestId, type: "complete", output });
    } catch (error) {
      generatorPromise = null;
      const message = error instanceof Error ? error.message : "The private CPU model could not start.";
      self.postMessage({ requestId, type: "error", message });
    }
  })();
});
