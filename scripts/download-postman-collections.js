#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import "dotenv/config";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function printUsage() {
    console.log(`
Usage:
  node scripts/download-postman-collections.js --workspace-id <id> [options]

Options:
  --workspace-id, --ws-id   Postman workspace id (required)
  --api-key                 Postman API key (defaults to POSTMAN_API_KEY)
  --output-dir              Output directory (default: collections)
  --delay-ms                Delay between collection downloads in ms (default: 250)
  --base-url                Postman API base URL (default: https://api.getpostman.com)
  --help                    Show this help
`);
}

function parseArgs(argv) {
    const options = {
        apiKey: process.env.POSTMAN_API_KEY ?? '',
        workspaceId: '',
        outputDir: path.join(rootDir, 'collections'),
        delayMs: 250,
        baseUrl: 'https://api.getpostman.com'
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];

        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }

        if (arg === '--api-key') {
            options.apiKey = next ?? '';
            i += 1;
            continue;
        }

        if (arg === '--workspace-id' || arg === '--ws-id') {
            options.workspaceId = next ?? '';
            i += 1;
            continue;
        }

        if (arg === '--output-dir') {
            options.outputDir = path.resolve(rootDir, next ?? 'collections');
            i += 1;
            continue;
        }

        if (arg === '--delay-ms') {
            options.delayMs = Number.parseInt(next ?? '250', 10);
            i += 1;
            continue;
        }

        if (arg === '--base-url') {
            options.baseUrl = (next ?? options.baseUrl).replace(/\/+$/, '');
            i += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return options;
}

function ensureValidOptions(options) {
    if (options.help) {
        printUsage();
        process.exit(0);
    }

    if (!options.apiKey) {
        throw new Error('Missing Postman API key. Pass --api-key or set POSTMAN_API_KEY.');
    }

    if (!options.workspaceId) {
        throw new Error('Missing workspace id. Pass --workspace-id <id>.');
    }

    if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
        throw new Error(`Invalid --delay-ms value: ${options.delayMs}`);
    }
}

async function fetchJson(url, apiKey) {
    const response = await fetch(url, {
        headers: {
            'X-Api-Key': apiKey,
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Postman API ${response.status} ${response.statusText} for ${url}\n${body}`);
    }

    return response.json();
}

async function resetOutputDir(outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    const entries = await fs.readdir(outputDir, { withFileTypes: true });

    await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(outputDir, entry.name);
        await fs.rm(entryPath, { recursive: true, force: true });
    }));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    ensureValidOptions(options);

    const listUrl = `${options.baseUrl}/collections?workspace=${encodeURIComponent(options.workspaceId)}`;
    console.log(`Fetching collection list for workspace ${options.workspaceId}`);

    const listResponse = await fetchJson(listUrl, options.apiKey);
    const collections = listResponse.collections ?? [];

    console.log(`Found ${collections.length} collections`);
    console.log(`Resetting output directory: ${options.outputDir}`);
    await resetOutputDir(options.outputDir);

    for (let index = 0; index < collections.length; index += 1) {
        const metadata = collections[index];
        const itemUrl = `${options.baseUrl}/collections/${encodeURIComponent(metadata.uid)}`;
        const itemResponse = await fetchJson(itemUrl, options.apiKey);
        const collection = itemResponse.collection;

        if (!collection?.info?.name) {
            throw new Error(`Collection ${metadata.uid} does not contain a valid collection payload.`);
        }

        const collectionName = collection.info.name;
        const filename = `${collectionName}.postman_collection.json`;

        // Match the bracket prefix to determine the subfolder
        // ^\[(.*?)\] captures anything inside starting brackets: e.g., "[Client]" -> "Client"
        const folderMatch = collectionName.match(/^\[(.*?)\]/);
        let targetDir = options.outputDir;

        if (folderMatch) {
            const folderName = folderMatch[1].trim();
            targetDir = path.join(options.outputDir, folderName);

            // Ensure the extracted subfolder exists before saving
            await fs.mkdir(targetDir, { recursive: true });
        }

        const filePath = path.join(targetDir, filename);

        await fs.writeFile(filePath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');

        // Log relative path to show exactly which subfolder the file went to
        const relativeLogPath = path.relative(options.outputDir, filePath);
        console.log(`[${index + 1}/${collections.length}] ${collectionName} -> ${relativeLogPath}`);

        if (index < collections.length - 1 && options.delayMs > 0) {
            await sleep(options.delayMs);
        }
    }

    console.log(`Downloaded ${collections.length} collections to ${options.outputDir}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
