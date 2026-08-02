export interface NormalizedCropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelCropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizedCropToPixels(region: NormalizedCropRegion, imageWidth: number, imageHeight: number): PixelCropRegion {
  const x = clamp(Math.round(region.x * imageWidth), 0, Math.max(0, imageWidth - 1));
  const y = clamp(Math.round(region.y * imageHeight), 0, Math.max(0, imageHeight - 1));
  const width = clamp(Math.round(region.width * imageWidth), 1, imageWidth - x);
  const height = clamp(Math.round(region.height * imageHeight), 1, imageHeight - y);
  return { x, y, width, height };
}

export async function cropImageToRegion(image: Blob, region: NormalizedCropRegion): Promise<Blob> {
  const imageUrl = URL.createObjectURL(image);
  const source = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      source.onload = () => resolve();
      source.onerror = () => reject(new Error("Unable to preview the selected screen."));
      source.src = imageUrl;
    });
    const crop = normalizedCropToPixels(region, source.naturalWidth, source.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Unable to prepare the selected capture area.");
    context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Unable to encode the selected capture area.")), "image/png"));
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

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
