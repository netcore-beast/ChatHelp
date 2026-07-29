import { cp, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, "public", "tesseract"), { recursive: true });
await mkdir(join(root, "public", "tesseract-core"), { recursive: true });
await mkdir(join(root, "public", "tessdata"), { recursive: true });
await copyFile(join(root, "node_modules", "tesseract.js", "dist", "worker.min.js"), join(root, "public", "tesseract", "worker.min.js"));
await cp(join(root, "node_modules", "tesseract.js-core"), join(root, "public", "tesseract-core"), { recursive: true, filter: (source) => /(?:tesseract-core.*\.(?:js|wasm)|tesseract.js-core)$/.test(source) });
await copyFile(join(root, "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"), join(root, "public", "tessdata", "eng.traineddata.gz"));
console.log("Prepared self-hosted OCR worker, engine, and English language data.");
