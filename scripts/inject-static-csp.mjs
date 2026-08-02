import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONNECT_SOURCES = [
  "'self'",
  "https://huggingface.co",
  "https://*.huggingface.co",
  "https://*.hf.co",
  "https://*.xethub.hf.co",
  "https://raw.githubusercontent.com",
];

export function buildStaticPolicy(hashes) {
  const scripts = ["'self'", "'wasm-unsafe-eval'", ...hashes.map((hash) => `'sha256-${hash}'`)];
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
     "form-action 'self'",
    `script-src ${scripts.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.licdn.com https://*.linkedin.com",
    "font-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src ${CONNECT_SOURCES.join(" ")}`,
    "manifest-src 'self'",
  ].join("; ");
}

export function injectCspIntoHtml(html) {
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) {
    throw new Error("Static HTML already contains a Content-Security-Policy meta tag.");
  }

  const hashes = new Set();
  const inlineScript = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(inlineScript)) {
    const source = match[1];
    if (!source.trim()) continue;
    hashes.add(createHash("sha256").update(source, "utf8").digest("base64"));
  }

  const policy = buildStaticPolicy([...hashes]);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error("Static HTML is missing a head element.");
  return html.replace(/<head(\s[^>]*)?>/i, (head) => head + meta);
}

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

export async function injectStaticCsp(directory = "out") {
  const files = await htmlFiles(resolve(directory));
  if (!files.length) throw new Error("No static HTML files were found for CSP injection.");
  for (const file of files) {
    const html = await readFile(file, "utf8");
    await writeFile(file, injectCspIntoHtml(html), "utf8");
  }
  return files.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const count = await injectStaticCsp(process.argv[2] ?? "out");
  console.log(`Injected hash-based CSP into ${count} static HTML file(s).`);
}
