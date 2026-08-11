import { Client } from "pg";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const PRODUCTION_HOST = "chathelp-private-cloud.project-mission-ai.workers.dev";

export function resolveNeonContext(env, hostname) {
  if (hostname === TESTING_HOST
      && env.DEPLOYMENT_ENVIRONMENT === "testing" && env.NEON_TESTING) {
    return { binding: env.NEON_TESTING, environment: "testing" };
  }
  if (hostname === PRODUCTION_HOST
      && env.DEPLOYMENT_ENVIRONMENT === "production" && env.NEON_PRODUCTION) {
    return { binding: env.NEON_PRODUCTION, environment: "production" };
  }
  throw new Error("unsupported_host");
}

export async function queryNeon(binding, text, values = []) {
  const client = new Client({ connectionString: binding.connectionString });
  try {
    await client.connect();
    return await client.query(text, values);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function withNeonTransaction(binding, operation, options = {}) {
  const createClient = typeof options.createClient === "function"
    ? options.createClient
    : (config) => new Client(config);
  const client = createClient({ connectionString: binding.connectionString });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      const result = await operation((text, values = []) => client.query(text, values));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
