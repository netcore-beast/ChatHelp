import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const parseJson = (path: string) => JSON.parse(read(path));

const TESTING_VARS = {
  DEPLOYMENT_ENVIRONMENT: "testing",
  LEARNING_RETENTION_DAYS: "365",
  USAGE_RETENTION_DAYS: "365",
  ANTHROPIC_ALLOWANCE_MICRO_USD: "10000000",
  WORKERS_AI_ALLOWANCE_MICRO_USD: "2000000",
  AI_PRICING_VERSION: "2026-08-09-v1",
  AI_ESTIMATOR_VERSION: "characters-over-four-v1",
};

const REQUIRED_SECRET_NAMES = [
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD_TESTING",
  "ACCESS_AUD_PRODUCTION",
  "ANTHROPIC_API_KEY",
];

describe("Cloudflare release configuration", () => {
  it("defines the schema, keep-vars policy, and identical safe release vars in testing and production", () => {
    const config = parseJson("wrangler.jsonc");

    expect(config.$schema).toBe("./node_modules/wrangler/config-schema.json");
    expect(config.keep_vars).toBe(true);
    expect(config.env.testing.vars).toEqual(TESTING_VARS);
    expect(config.env.production.vars).toEqual({
      ...TESTING_VARS,
      DEPLOYMENT_ENVIRONMENT: "production",
    });
  });

  it("preserves isolated database bindings and shared AI, secret-name, and rate-limit contracts", () => {
    const config = parseJson("wrangler.jsonc");
    const rateLimiter = [{
      name: "DRAFT_RATE_LIMITER",
      namespace_id: "7493101",
      simple: { limit: 10, period: 60 },
    }];

    expect(config.ai).toEqual({ binding: "AI" });
    expect(config.secrets).toEqual({ required: REQUIRED_SECRET_NAMES });
    expect(config.ratelimits).toEqual(rateLimiter);
    expect(config.env.testing).toMatchObject({
      name: "testing-chathelp-private-cloud",
      ai: { binding: "AI" },
      secrets: { required: REQUIRED_SECRET_NAMES },
      hyperdrive: [{ binding: "NEON_TESTING", id: "69eb149ad82d40cba7e729279294d521" }],
      ratelimits: rateLimiter,
    });
    expect(config.env.production).toMatchObject({
      name: "chathelp-private-cloud",
      ai: { binding: "AI" },
      secrets: { required: REQUIRED_SECRET_NAMES },
      hyperdrive: [{ binding: "NEON_PRODUCTION", id: "0df56a4e086547eb9e15d1d964556676" }],
      ratelimits: rateLimiter,
    });
    expect(config.hyperdrive).toBeUndefined();
  });

  it("pins the local Wrangler package and uses it for every Cloudflare script", () => {
    const packageJson = parseJson("package.json");
    const packageLock = parseJson("package-lock.json");
    const scripts = packageJson.scripts as Record<string, string>;

    expect(packageJson.devDependencies.wrangler).toBe("4.114.0");
    expect(packageLock.packages[""].devDependencies.wrangler).toBe("4.114.0");
    expect(packageLock.packages["node_modules/wrangler"].version).toBe("4.114.0");
    expect(scripts["verify:cloudflare"]).toBe("wrangler deploy --env testing --dry-run --outdir .wrangler-dry-run");
    expect(scripts["verify:cloudflare:production"]).toBe("wrangler deploy --env production --dry-run --outdir .wrangler-production-dry-run");
    expect(scripts["deploy:cloudflare:testing"]).toBe("wrangler deploy --env testing --keep-vars");
    expect(scripts["deploy:cloudflare"]).toBe("wrangler deploy --env production");
    for (const script of Object.values(scripts)) {
      expect(script).not.toMatch(/\bnpx\s+(?:--yes\s+)?wrangler(?:@|\b)/u);
    }
  });

  it("uses a CI Node runtime compatible with the pinned Wrangler engine", () => {
    const ci = read(".github/workflows/ci.yml");
    const wranglerPackage = parseJson("node_modules/wrangler/package.json");
    const configuredMajor = Number(ci.match(/node-version:\s*(\d+)/u)?.[1]);
    const requiredMajor = Number(String(wranglerPackage.engines.node).match(/\d+/u)?.[0]);

    expect(configuredMajor).toBeGreaterThanOrEqual(requiredMajor);
  });

  it("keeps one Next server alive for both browser checks before both dry-runs and the production audit", () => {
    const ci = read(".github/workflows/ci.yml");
    const serverStepStart = ci.indexOf("- name: Verify live CSP, hydration bootstrap, and browser smoke");
    const nativeBuildStart = ci.indexOf("- run: npm run build:native");
    const serverStep = ci.slice(serverStepStart, nativeBuildStart);

    expect(serverStepStart).toBeGreaterThan(-1);
    expect(nativeBuildStart).toBeGreaterThan(serverStepStart);
    expect(serverStep).toContain("npm start > /tmp/chathelp-server.log 2>&1 &");
    expect(serverStep).toContain("SERVER_PID=$!");
    expect(serverStep).toContain("trap 'kill $SERVER_PID' EXIT");
    expect(serverStep).toContain("npm run verify:live-csp");
    expect(serverStep).toContain("npm run verify:browser");
    expect(ci.match(/npm start/gu)).toHaveLength(1);

    const orderedCommands = [
      "- run: npm run build",
      "npm start > /tmp/chathelp-server.log 2>&1 &",
      "npm run verify:live-csp",
      "npm run verify:browser",
      "- run: npm run build:native",
      "- run: npm run verify:static-csp",
      "npm run verify:cloudflare",
      "npm run verify:cloudflare:production",
      "npm audit --omit=dev --audit-level=high",
    ];
    let previousIndex = -1;
    for (const command of orderedCommands) {
      const index = ci.indexOf(command, previousIndex + 1);
      expect(index, `${command} must appear in release-check order`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(ci).not.toMatch(/\bwrangler\s+(?:deploy|versions\s+upload)\b/u);
  });
});
