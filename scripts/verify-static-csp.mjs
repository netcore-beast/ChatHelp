import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function htmlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

const files = await htmlFiles(resolve(process.argv[2] ?? "out"));
if (!files.length) throw new Error("No exported HTML files were found.");
for (const file of files) {
  const html = await readFile(file, "utf8");
  const policies = [...html.matchAll(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+content="([^"]+)"[^>]*>/gi)];
  if (policies.length !== 1) throw new Error(`${file} contains ${policies.length} CSP meta tags.`);
  const policy = policies[0][1];
  const scriptDirective = policy.split(";").find((item) => item.trim().startsWith("script-src")) ?? "";
  if (scriptDirective.includes("'unsafe-inline'")) throw new Error(`${file} allows unsafe-inline scripts.`);
  const inlineScript = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(inlineScript)) {
    const source = match[1];
    if (!source.trim()) continue;
    const hash = createHash("sha256").update(source, "utf8").digest("base64");
    if (!scriptDirective.includes(`'sha256-${hash}'`)) throw new Error(`${file} contains an unauthorized inline script.`);
  }
}
console.log(`Static CSP verified across ${files.length} exported HTML file(s).`);
