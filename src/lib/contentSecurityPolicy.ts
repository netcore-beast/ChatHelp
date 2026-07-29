export interface ContentSecurityPolicyOptions {
  nonce?: string;
  development?: boolean;
  scriptHashes?: string[];
}

const CONNECT_SOURCES = [
  "'self'",
  "https://huggingface.co",
  "https://*.huggingface.co",
  "https://*.hf.co",
  "https://*.xethub.hf.co",
  "https://raw.githubusercontent.com",
];

export function buildContentSecurityPolicy({ nonce, development = false, scriptHashes = [] }: ContentSecurityPolicyOptions = {}): string {
  const scriptSources = ["'self'", "'wasm-unsafe-eval'"];
  if (nonce) scriptSources.push(`'nonce-${nonce}'`, "'strict-dynamic'");
  if (development) scriptSources.push("'unsafe-eval'");
  scriptSources.push(...scriptHashes.map((hash) => `'sha256-${hash}'`));

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src ${CONNECT_SOURCES.join(" ")}`,
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}
