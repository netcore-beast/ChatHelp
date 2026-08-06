export type DraftPipelineStage = "planning" | "drafting" | "reviewing" | "finalizing";
export type DraftStageStatus = "pending" | "in-progress" | "done" | "error";

export type DraftProgressUpdate =
  | { kind: "message"; message: string }
  | { kind: "stage"; stage: DraftPipelineStage; status: "in-progress" | "done" };

const MAX_DRAFT_STREAM_BYTES = 512_000;
const VALID_STAGES = new Set<DraftPipelineStage>(["planning", "drafting", "reviewing", "finalizing"]);
const VALID_STATUSES = new Set(["in-progress", "done"]);

function parseEventFrame(frame: string): { event: string; payload: unknown } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return { event, payload: JSON.parse(data.join("\n")) };
  } catch {
    throw new Error("Cloudflare AI returned an invalid progress stream.");
  }
}

export async function parseDraftProgressStream(
  response: Response,
  onProgress?: (update: DraftProgressUpdate) => void,
): Promise<unknown> {
  if (!response.body) throw new Error("Cloudflare AI returned an empty progress stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;
  let result: unknown;
  let hasResult = false;

  const processFrame = (rawFrame: string) => {
    const parsed = parseEventFrame(rawFrame);
    if (!parsed) return;
    if (parsed.event === "stage") {
      const stage = (parsed.payload as { stage?: unknown }).stage;
      const status = (parsed.payload as { status?: unknown }).status;
      if (typeof stage !== "string" || !VALID_STAGES.has(stage as DraftPipelineStage) || typeof status !== "string" || !VALID_STATUSES.has(status)) {
        throw new Error("Cloudflare AI returned an invalid progress event.");
      }
      onProgress?.({ kind: "stage", stage: stage as DraftPipelineStage, status: status as "in-progress" | "done" });
      return;
    }
    if (parsed.event === "result") {
      if (hasResult) throw new Error("Cloudflare AI returned more than one result.");
      result = parsed.payload;
      hasResult = true;
      return;
    }
    if (parsed.event === "error") {
      const error = (parsed.payload as { error?: unknown }).error;
      throw new Error(typeof error === "string" ? error : "Cloudflare AI is temporarily unavailable.");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      bytesRead += value.byteLength;
      if (bytesRead > MAX_DRAFT_STREAM_BYTES) throw new Error("Cloudflare AI returned an oversized progress stream.");
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      processFrame(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new Error("Cloudflare AI returned a truncated progress stream.");
  if (!hasResult) throw new Error("Cloudflare AI returned an incomplete response.");
  return result;
}
