import { createRemoteJWKSet, jwtVerify } from "jose";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const PRODUCTION_HOST = "chathelp-private-cloud.project-mission-ai.workers.dev";
const MAX_ASSERTION_CHARACTERS = 16_000;

export class AccessAuthenticationError extends Error {
  constructor() {
    super("DialogMint authentication is required.");
    this.name = "AccessAuthenticationError";
  }
}

function configuredIssuer(env) {
  const raw = String(env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/+$/g, "");
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function resolveAccessEnvironment(hostname, env) {
  const issuer = configuredIssuer(env);
  if (!issuer) return null;
  if (hostname === TESTING_HOST) {
    const audience = String(env.ACCESS_AUD_TESTING ?? "").trim();
    return audience ? { environment: "testing", audience } : null;
  }
  if (hostname === PRODUCTION_HOST) {
    const audience = String(env.ACCESS_AUD_PRODUCTION ?? "").trim();
    return audience ? { environment: "production", audience } : null;
  }
  return null;
}

async function verifyAccessJwt(assertion, { issuer, audience }) {
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return jwtVerify(assertion, keys, { issuer, audience, algorithms: ["RS256"] });
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function payloadHasAudience(payload, audience) {
  return payload.aud === audience || (Array.isArray(payload.aud) && payload.aud.includes(audience));
}

export async function authenticateAccessRequest(request, env, hostname, verifier = verifyAccessJwt) {
  const target = resolveAccessEnvironment(hostname, env);
  const issuer = configuredIssuer(env);
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ?? "";
  if (!target || !assertion || assertion.length > MAX_ASSERTION_CHARACTERS) throw new AccessAuthenticationError();
  try {
    const result = await verifier(assertion, { issuer, audience: target.audience });
    const payload = result?.payload;
    const subject = typeof payload?.sub === "string" ? payload.sub.trim() : "";
    const expiresAt = typeof payload?.exp === "number" ? payload.exp : 0;
    if (payload?.iss !== issuer || !payloadHasAudience(payload, target.audience) || !subject || expiresAt <= Math.floor(Date.now() / 1_000)) {
      throw new AccessAuthenticationError();
    }
    return {
      accountId: await sha256Hex(`${issuer}\n${target.audience}\n${subject}`),
      environment: target.environment,
    };
  } catch {
    throw new AccessAuthenticationError();
  }
}
