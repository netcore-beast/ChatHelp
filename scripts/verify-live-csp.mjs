const target = process.env.CHATHELP_VERIFY_URL ?? "http://127.0.0.1:3000/";

async function load() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(target, { redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { response, html: await response.text() };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`ChatHelp did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function inspect({ response, html }) {
  const policy = response.headers.get("content-security-policy") ?? "";
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  if (!nonce) throw new Error("The live CSP is missing its per-request nonce.");
  if (!policy.includes("'strict-dynamic'")) throw new Error("The live CSP is missing strict-dynamic.");
  if (policy.match(/default-src/g)?.length !== 1) throw new Error("The response contains a duplicate CSP.");
  const scriptDirective = policy.split(";").find((directive) => directive.trim().startsWith("script-src")) ?? "";
  if (scriptDirective.includes("'unsafe-inline'")) throw new Error("The live script policy allows unsafe-inline.");
  if (/http-equiv=["']Content-Security-Policy["']/i.test(html)) throw new Error("The document contains a duplicate CSP meta tag.");

  const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
  if (!scripts.length) throw new Error("The rendered page contains no framework scripts.");
  const unauthorized = scripts.filter((script) => !new RegExp(`nonce=["']${nonce}["']`).test(script));
  if (unauthorized.length) throw new Error(`${unauthorized.length} framework script(s) are missing the response nonce.`);
  if (response.headers.get("referrer-policy") !== "no-referrer") throw new Error("Referrer-Policy is missing.");
  if (response.headers.get("x-content-type-options") !== "nosniff") throw new Error("X-Content-Type-Options is missing.");
  return nonce;
}

const first = inspect(await load());
const second = inspect(await load());
if (first === second) throw new Error("The CSP nonce was reused across requests.");
console.log("Live CSP verified: unique nonces authorize every rendered framework script.");
