import newman from "newman";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { loadCollections, mergeCollections } from "./utils/collection.js";
import { fetchEnvironment, persistEnvironment } from "./utils/postman.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- ARGUMENT PARSING ---
const args = process.argv.slice(2);
let target = null;
let postmanApiKey = process.env.POSTMAN_API_KEY ?? "";
let postmanEnvId = null;

if (!postmanApiKey) {
  throw new Error("POSTMAN_API_KEY environment variable not set");
}

import { parseArgs } from "node:util";

// Normalize key=value → --key=value before parsing
const rawArgs = process.argv
  .slice(2)
  .map((arg) => (/^\w+=/.test(arg) ? `--${arg}` : arg));

const { values, positionals } = parseArgs({
  args: rawArgs,
  options: {
    target: { type: "string" },
    postmanEnvId: { type: "string" },
    verbose: { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

target = values.target ?? positionals[0] ?? null;
// CLI arg takes precedence over the .env value
postmanEnvId = values.postmanEnvId ?? process.env.POSTMAN_ENV_ID ?? null;

// Verbose req/res body logging is disabled by default; enable with verbose=true
const verbose = /^(true|1|yes)$/i.test(values.verbose ?? "");

if (!postmanEnvId) {
  throw new Error(
    "Missing postmanEnvId: set POSTMAN_ENV_ID in .env or pass it as an argument\n" +
      'Usage: npm test -- [postmanEnvId="<id>"] [target="<name>"]',
  );
}

// --- CONFIGURATION ---
const CONFIG = {
  mode: "merged", // Options: 'merged' (all-in-one), 'individual' (separate reports)
  parallel: false, // Only applies if mode is 'individual'. Set to true for parallel runs.
  target: target || null, // Specific collection name/filter (e.g. "Id - Create")
  collectionsDir: path.join(__dirname, "collections"),
  postmanApiKey,
  postmanEnvId,
  environmentPath: path.join(
    __dirname,
    "environments",
    "Dev.postman_environment.json",
  ),
  outputDir: path.join(__dirname, "output"),
  verbose,
};

console.log(`--- EXECUTION CONFIGURATION ---`);
console.log(`Mode:    ${CONFIG.mode}`);
console.log(`Target:  ${CONFIG.target || "All"}`);
console.log(`Env:     ${CONFIG.environmentPath}`);
console.log(`Verbose: ${CONFIG.verbose}`);
console.log(`-------------------------------`);

/**
 * Runs a collection using newman.
 * @param {object} collection - Postman collection JSON
 * @param {string} name - Name for the report file
 * @returns {Promise<void>}
 */
async function runNewman(collection, name, environment) {
  await fs.mkdir(CONFIG.outputDir, { recursive: true });
  const safeName = name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const exportPath = path.join(CONFIG.outputDir, `report-${safeName}.html`);
  // Machine-readable report for CI / AI agents (ships with newman core):
  //  - json:  full structured run summary (requests, assertions, failures)
  const jsonPath = path.join(CONFIG.outputDir, `report-${safeName}.json`);

  // TEMP: pretty-print JSON payloads for console capture (response-verifier sessions)
  const prettyJson = (raw) => {
    if (!raw) return "(empty)";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  };

  return new Promise((resolve, reject) => {
    const run = newman.run(
      {
        collection,
        environment: environment,
        exportEnvironment: CONFIG.environmentPath,
        bail: false,
        reporters: ["htmlextra", "cli", "json"],
        iterationCount: 1,
        reporter: {
          htmlextra: {
            export: exportPath,
            browserTitle: `FR-ONE ${name} Report`,
            title: `FR-ONE ${name} Execution Report`,
          },
          json: {
            export: jsonPath,
          },
        },
      },
      function (err, summary) {
        if (err) {
          console.error(`Newman run error [${name}]:`, err);
          return reject(err);
        }
        console.log(`Run complete [${name}]! Reports exported:`);
        console.log(`  HTML:  ${exportPath}`);
        console.log(`  JSON:  ${jsonPath}`);
        resolve(summary);
      },
    );

    // TEMP: log resolved request/response bodies per request (remove after
    // response-verifier sessions are done). Gated behind verbose=true since
    // it's noisy and only needed for response-verifier workflows.
    if (CONFIG.verbose) {
      run.on("request", (err, args) => {
        if (err) {
          console.error(`[req-log] request error [${args?.item?.name}]:`, err);
          return;
        }
        const { item, request, response } = args;
        console.log(`\n========== ${item.name} ==========`);
        console.log(`${request.method} ${request.url.toString()}`);
        console.log(`--- request body (resolved) ---`);
        console.log(prettyJson(request.body?.raw));
        if (response) {
          console.log(`--- response [${response.code} ${response.status}] ---`);
          console.log(prettyJson(response.stream?.toString()));
        } else {
          console.log(`--- no response received ---`);
        }
        console.log(`========================================\n`);
      });
    }
  });
}

/**
 * Updates a specific key's value in the Postman environment JSON file.
 * @param {string} filePath
 * @param {string} key
 * @param {string} value
 */
async function updateEnvironmentValue(filePath, key, value) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const env = JSON.parse(content);
    const entry = env.values.find((v) => v.key === key);
    if (entry) {
      entry.value = value;
      await fs.writeFile(filePath, JSON.stringify(env, null, 2), "utf8");
      console.log(`Updated ${key} in environment.`);
    } else {
      console.warn(`Key ${key} not found in environment file.`);
    }
  } catch (err) {
    console.error(`Failed to update environment: ${err.message}`);
  }
}

/**
 * Clears a specific key's value in the Postman environment JSON file.
 * @param {string} filePath
 * @param {string} key
 */
async function clearEnvironmentValue(filePath, key) {
  console.log(`Safely clearing ${key} from environment...`);
  await updateEnvironmentValue(filePath, key, "");
}

// Main execution block
(async () => {
  try {
    console.log("Loading collections from:", CONFIG.collectionsDir);
    let collections = await loadCollections(CONFIG.collectionsDir);
    let environment = await fetchEnvironment(
      CONFIG.postmanApiKey,
      CONFIG.postmanEnvId,
    );

    // Apply target filter if provided
    if (CONFIG.target) {
      console.log(`Filtering for target: "${CONFIG.target}"`);
      const normalize = (value) => value.toLowerCase().replace(/\\/g, "/");
      const targetLower = normalize(CONFIG.target);
      collections = collections.filter((c) =>
        [c.name, c.sourcePath, path.dirname(c.sourcePath || "")].some(
          (value) => value && normalize(value).includes(targetLower),
        ),
      );

      if (collections.length === 0) {
        console.error(
          `No collections found matching target: "${CONFIG.target}"`,
        );
        process.exit(1);
      }
      // If running a specific target, we usually want individual mode
      if (collections.length === 1) CONFIG.mode = "individual";
    }

    try {
      if (CONFIG.mode === "merged") {
        console.log(`Merging ${collections.length} collections...`);
        const mergedCollection = mergeCollections(collections);
        await runNewman(mergedCollection.toJSON(), "merged-suite", environment);
      } else {
        console.log(
          `Running ${collections.length} collections individually (Parallel: ${CONFIG.parallel})...`,
        );
        if (CONFIG.parallel) {
          await Promise.all(
            collections.map((col) =>
              runNewman(col.toJSON(), col.name, environment),
            ),
          );
        } else {
          for (const col of collections) {
            await runNewman(col.toJSON(), col.name, environment);
          }
        }
      }
    } finally {
      await persistEnvironment(
        CONFIG.postmanApiKey,
        CONFIG.postmanEnvId,
        CONFIG.environmentPath,
      );
    }

    console.log("Successfully completed the execution!");
  } catch (err) {
    console.error("Execution failed:", err);
    process.exit(1);
  }
})();
