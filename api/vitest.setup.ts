import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Unit tests import chain.ts, which validates required env vars at module
// load time even for pure functions like generateKeypair(). Load the same
// .env the dev/start scripts use so `npm test` works standalone.
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
