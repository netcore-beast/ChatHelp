import { describe, expect, it, vi } from "vitest";
import { AccessAuthenticationError, authenticateAccessRequest, resolveAccessEnvironment } from "../cloudflare/worker/src/accessAuth.js";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const PRODUCTION_HOST = "chathelp-private-cloud.project-mission-ai.workers.dev";
const env = {
  ACCESS_TEAM_DOMAIN: "https://dialogmint.cloudflareaccess.com",
  ACCESS_AUD_TESTING: "testing-audience",
  ACCESS_AUD_PRODUCTION: "production-audience",
};

describe("Cloudflare Access identity boundary", () => {
  it("selects an audience only for exact trusted deployment hosts", () => {
    expect(resolveAccessEnvironment(TESTING_HOST, env)).toEqual({ environment: "testing", audience: "testing-audience" });
    expect(resolveAccessEnvironment(PRODUCTION_HOST, env)).toEqual({ environment: "production", audience: "production-audience" });
    expect(resolveAccessEnvironment("version-123.chathelp-private-cloud.workers.dev", env)).toBeNull();
    expect(resolveAccessEnvironment("dialogmint.com.attacker.example", env)).toBeNull();
  });

  it("rejects missing assertions and never trusts an email identity header", async () => {
    const request = new Request(`https://${TESTING_HOST}/api/drafts`, { headers: { "Cf-Access-Authenticated-User-Email": "person@example.com" } });
    const verifier = vi.fn();

    await expect(authenticateAccessRequest(request, env, TESTING_HOST, verifier)).rejects.toBeInstanceOf(AccessAuthenticationError);
    expect(verifier).not.toHaveBeenCalled();
  });

  it("verifies issuer and environment audience before deriving an opaque account ID", async () => {
    const request = new Request(`https://${TESTING_HOST}/api/drafts`, { headers: { "Cf-Access-Jwt-Assertion": "synthetic.assertion.value" } });
    const verifier = vi.fn().mockResolvedValue({ payload: {
      iss: "https://dialogmint.cloudflareaccess.com",
      aud: ["testing-audience"],
      sub: "synthetic-subject",
      email: "person@example.com",
      exp: 2_000_000_000,
    } });

    const identity = await authenticateAccessRequest(request, env, TESTING_HOST, verifier);
    expect(verifier).toHaveBeenCalledWith("synthetic.assertion.value", {
      issuer: "https://dialogmint.cloudflareaccess.com",
      audience: "testing-audience",
    });
    expect(identity).toEqual({ accountId: expect.stringMatching(/^[a-f0-9]{64}$/), environment: "testing" });
    expect(identity.accountId).not.toContain("synthetic-subject");
    expect(identity.accountId).not.toContain("person@example.com");
  });

  it("rejects incomplete verified claims without returning their values", async () => {
    const request = new Request(`https://${PRODUCTION_HOST}/api/drafts`, { headers: { "Cf-Access-Jwt-Assertion": "synthetic.assertion.value" } });
    const verifier = vi.fn().mockResolvedValue({ payload: { iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD_PRODUCTION] } });

    await expect(authenticateAccessRequest(request, env, PRODUCTION_HOST, verifier)).rejects.toMatchObject({ message: "DialogMint authentication is required." });
  });
});
