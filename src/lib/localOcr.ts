export type OcrProgress = {
  progress: number;
  status: string;
};

export async function recognizeImageLocally(
  image: string,
  onProgress: (progress: OcrProgress) => void,
) {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", undefined, {
    logger: (message) => {
      onProgress({
        progress: typeof message.progress === "number" ? message.progress : 0,
        status: message.status || "Reading the image locally…",
      });
    },
  });

  try {
    const result = await worker.recognize(image);
    return result.data.text.replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    await worker.terminate();
  }
}
