export async function extractTextFromImage(image: Blob, onProgress?: (message: string) => void): Promise<string> {
  const { createWorker, OEM } = await import("tesseract.js");
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract-core",
    langPath: "/tessdata",
    logger: (entry) => onProgress?.(entry.status + (typeof entry.progress === "number" ? " " + Math.round(entry.progress * 100) + "%" : "")),
  });
  try {
    const result = await worker.recognize(image);
    return result.data.text.trim();
  } finally {
    await worker.terminate();
  }
}

export async function captureVisibleScreen(): Promise<Blob> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen capture is not supported in this browser.");
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const track = stream.getVideoTracks()[0];
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Unable to prepare the captured image.");
    context.drawImage(video, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Unable to encode the captured image.")), "image/png"));
  } finally {
    track.stop();
    stream.getTracks().forEach((item) => item.stop());
  }
}
