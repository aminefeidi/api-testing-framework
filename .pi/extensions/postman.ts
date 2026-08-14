import { readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pmc from "postman-collection";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const { Collection } = pmc;
const LISTENERS = ["prerequest", "test"] as const;
type Listener = (typeof LISTENERS)[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RawItem = { name?: string; id?: string; item?: RawItem[]; request?: Record<string, unknown>; event?: unknown[]; [key: string]: unknown };

type ParsedCollection = {
	file: string;
	relativeFile: string;
	text: string;
	document: Record<string, unknown>;
	collection: Record<string, unknown>;
};

type Target = { item: RawItem; path: string[] };

const headerSchema = Type.Object({
	key: Type.String(),
	value: Type.String(),
	disabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const scriptSchema = Type.Object({
	listen: Type.Union([Type.Literal("prerequest"), Type.Literal("test")]),
	exec: Type.Array(Type.String()),
}, { additionalProperties: false });

const parameters = Type.Object({
	action: Type.String({ description: "Operation: search_collections | search_requests | list_collections | tree | read_request | update_request." }),
	query: Type.Optional(Type.String({ minLength: 1, description: "Case-insensitive partial collection or request name to search for." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	collection_file: Type.Optional(Type.String({ description: "Path relative to collections/, for example Client/[Client] Create & Verify.postman_collection.json" })),
	item_path: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Exact folder/request name path. The final name must be a request." })),
	max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 12 })),
	max_nodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	include: Type.Optional(Type.Array(Type.Union([
		Type.Literal("body"), Type.Literal("scripts"), Type.Literal("headers"), Type.Literal("url"),
		Type.Literal("auth"), Type.Literal("description"),
	]), { uniqueItems: true })),
	method: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	raw_body: Type.Optional(Type.String()),
	body_language: Type.Optional(Type.Union([
		Type.Literal("json"), Type.Literal("text"), Type.Literal("xml"), Type.Literal("javascript"), Type.Literal("html"),
	])),
	scripts: Type.Optional(Type.Array(scriptSchema, { maxItems: 2 })),
	headers: Type.Optional(Type.Array(headerSchema)),
	auth: Type.Optional(Type.Any({ description: "Request auth object, or null to remove request-level auth." })),
	description: Type.Optional(Type.String()),
}, { additionalProperties: true });

function result(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
		isError,
	};
}

function failure(error: unknown) {
	return result({ status: "error", error: error instanceof Error ? error.message : String(error) }, true);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJson(value: unknown): value is Json {
	if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
	if (Array.isArray(value)) return value.every(isJson);
	return isObject(value) && Object.values(value).every(isJson);
}

function collectionRoot(document: Record<string, unknown>) {
	return isObject(document.collection) ? document.collection : document;
}

function requestMethod(item: RawItem) {
	const request = item.request;
	return isObject(request) && typeof request.method === "string" ? request.method : undefined;
}

function requestUrl(item: RawItem) {
	const request = item.request;
	if (!isObject(request)) return undefined;
	if (typeof request.url === "string") return request.url;
	return isObject(request.url) && typeof request.url.raw === "string" ? request.url.raw : undefined;
}

function eventNames(item: RawItem) {
	return Array.isArray(item.event)
		? item.event.filter(isObject).map((event) => event.listen).filter((listen): listen is string => typeof listen === "string")
		: [];
}

function walkRequests(items: unknown, parentPath: string[] = [], found: Target[] = []): Target[] {
	if (!Array.isArray(items)) return found;
	for (const value of items) {
		if (!isObject(value)) continue;
		const item = value as RawItem;
		const itemPath = [...parentPath, typeof item.name === "string" ? item.name : "(unnamed)"];
		if (isObject(item.request)) found.push({ item, path: itemPath });
		if (Array.isArray(item.item)) walkRequests(item.item, itemPath, found);
	}
	return found;
}

function treeNodes(items: unknown, parentPath: string[], depth: number, maxDepth: number, maxNodes: number, nodes: Record<string, unknown>[]) {
	if (!Array.isArray(items) || depth > maxDepth || nodes.length >= maxNodes) return;
	for (const value of items) {
		if (!isObject(value) || nodes.length >= maxNodes) return;
		const item = value as RawItem;
		const itemPath = [...parentPath, typeof item.name === "string" ? item.name : "(unnamed)"];
		if (isObject(item.request)) {
			nodes.push({ kind: "request", id: item.id, path: itemPath, name: item.name, method: requestMethod(item), url: requestUrl(item), hasBody: isObject(item.request.body), events: eventNames(item) });
		}
		if (Array.isArray(item.item)) {
			nodes.push({ kind: "folder", id: item.id, path: itemPath, name: item.name });
			treeNodes(item.item, itemPath, depth + 1, maxDepth, maxNodes, nodes);
		}
	}
}

function redactHeaders(headers: unknown) {
	if (!Array.isArray(headers)) return [];
	return headers.filter(isObject).map((header) => {
		const copy = { ...header };
		const key = typeof copy.key === "string" ? copy.key : "";
		if (/(authorization|api[ _-]?key|token|secret|password)/i.test(key) && "value" in copy) copy.value = "[redacted]";
		return copy;
	});
}

function redactAuth(auth: unknown) {
	if (!isObject(auth)) return auth;
	const copy: Record<string, unknown> = { ...auth };
	for (const [key, value] of Object.entries(copy)) {
		if (/(authorization|api[ _-]?key|token|secret|password|value)/i.test(key)) copy[key] = "[redacted]";
		else if (Array.isArray(value)) copy[key] = value.map((entry) => isObject(entry) && typeof entry.key === "string" && /(token|secret|password|key)/i.test(entry.key) ? { ...entry, value: "[redacted]" } : entry);
	}
	return copy;
}

function scriptEvents(item: RawItem) {
	if (!Array.isArray(item.event)) return [];
	return item.event.filter(isObject).map((event) => {
		const script = isObject(event.script) ? event.script : {};
		return { listen: event.listen, exec: Array.isArray(script.exec) ? script.exec : [] };
	});
}

function findTarget(collection: Record<string, unknown>, itemPath: string[]) {
	const matches = walkRequests(collection.item).filter((target) => target.path.length === itemPath.length && target.path.every((part, index) => part === itemPath[index]));
	if (matches.length !== 1) throw new Error(matches.length === 0 ? `Request not found: ${itemPath.join(" / ")}` : `Request path is ambiguous: ${itemPath.join(" / ")}`);
	return matches[0];
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function validateScript(exec: string[]) {
	if (!exec.every((line) => typeof line === "string")) throw new Error("Script exec must contain only strings.");
	new Function(exec.join("\n"));
}

function setScript(item: RawItem, listen: Listener, exec: string[]) {
	validateScript(exec);
	if (!Array.isArray(item.event)) item.event = [];
	let event = item.event.find((value): value is Record<string, unknown> => isObject(value) && value.listen === listen);
	if (!event) {
		event = { listen, script: { type: "text/javascript", exec: [] } };
		item.event.push(event);
	}
	if (!isObject(event.script)) event.script = { type: "text/javascript" };
	event.script.exec = exec;
}

function setRawBody(item: RawItem, raw: string, language?: string) {
	if (!isObject(item.request) || !isObject(item.request.body) || item.request.body.mode !== "raw") throw new Error("set_raw_body requires an existing raw request body.");
	const body = item.request.body;
	const currentLanguage = isObject(body.options) && isObject(body.options.raw) ? body.options.raw.language : undefined;
	const effectiveLanguage = language ?? currentLanguage;
	if (effectiveLanguage === "json") JSON.parse(raw);
	body.raw = raw;
	if (language) {
		if (!isObject(body.options)) body.options = {};
		if (!isObject(body.options.raw)) body.options.raw = {};
		body.options.raw.language = language;
	}
}

function setUrl(item: RawItem, url: string) {
	if (!url.trim()) throw new Error("URL must not be empty.");
	if (!isObject(item.request)) throw new Error("Target has no request object.");
	if (typeof item.request.url === "string") item.request.url = url;
	else if (isObject(item.request.url)) item.request.url.raw = url;
	else item.request.url = url;
}

function setHeaders(item: RawItem, headers: Array<{ key: string; value: string; disabled?: boolean }>) {
	for (const header of headers) {
		if (!header.key || /[\r\n\0]/.test(header.key) || /[\r\n\0]/.test(header.value)) throw new Error("Header names and values cannot contain control characters.");
	}
	if (!isObject(item.request)) throw new Error("Target has no request object.");
	item.request.header = headers.map((header) => ({ ...header }));
}

function applyUpdate(item: RawItem, params: Record<string, unknown>) {
	const fields = ["method", "url", "raw_body", "scripts", "headers", "auth", "description"].filter((field) => params[field] !== undefined);
	if (fields.length === 0) throw new Error("Provide at least one request field to update.");
	if (!isObject(item.request)) throw new Error("Target has no request object.");
	if (params.method !== undefined) {
		if (typeof params.method !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(params.method)) throw new Error("Invalid HTTP method.");
		item.request.method = params.method;
	}
	if (params.url !== undefined) {
		if (typeof params.url !== "string") throw new Error("URL must be a string.");
		setUrl(item, params.url);
	}
	if (params.raw_body !== undefined) {
		if (typeof params.raw_body !== "string") throw new Error("raw_body must be a string.");
		setRawBody(item, params.raw_body, typeof params.body_language === "string" ? params.body_language : undefined);
	}
	if (params.scripts !== undefined) {
		if (!Array.isArray(params.scripts)) throw new Error("scripts must be an array.");
		const seen = new Set<string>();
		for (const script of params.scripts) {
			if (!isObject(script) || !LISTENERS.includes(script.listen as Listener) || !Array.isArray(script.exec) || seen.has(script.listen as string)) throw new Error("Each prerequest/test script must be unique and valid.");
			seen.add(script.listen as string);
			setScript(item, script.listen as Listener, script.exec as string[]);
		}
	}
	if (params.headers !== undefined) {
		if (!Array.isArray(params.headers)) throw new Error("headers must be an array.");
		setHeaders(item, params.headers as Array<{ key: string; value: string; disabled?: boolean }>);
	}
	if (params.auth !== undefined) {
		if (!isJson(params.auth)) throw new Error("auth must be JSON data.");
		item.request.auth = params.auth;
	}
	if (params.description !== undefined) {
		if (typeof params.description !== "string") throw new Error("description must be a string.");
		item.description = params.description;
	}
	return fields;
}

function serialize(document: Record<string, unknown>, original: string) {
	const indentation = original.match(/\n([ \t]+)"/)?.[1] ?? "  ";
	const newline = original.includes("\r\n") ? "\r\n" : "\n";
	const trailingNewline = /(?:\r?\n)$/.test(original);
	const text = JSON.stringify(document, null, indentation).replace(/\n/g, newline);
	return trailingNewline ? `${text}${newline}` : text;
}

export default function postmanExtension(pi: ExtensionAPI) {
	const collectionsRoot = (cwd: string) => path.join(cwd, "collections");

	async function resolveFile(cwd: string, relativeFile: string) {
		if (!relativeFile || path.isAbsolute(relativeFile) || relativeFile.split(/[\\/]/).includes("..") || !relativeFile.endsWith(".json")) throw new Error("collection_file must be a .json path relative to collections/.");
		const root = await realpath(collectionsRoot(cwd));
		const file = path.resolve(root, relativeFile);
		if (path.relative(root, file).startsWith("..") || path.isAbsolute(path.relative(root, file))) throw new Error("collection_file escapes collections/.");
		const resolved = await realpath(file);
		if (path.relative(root, resolved).startsWith("..") || path.isAbsolute(path.relative(root, resolved)) || !(await stat(resolved)).isFile()) throw new Error("collection_file is not a collection file under collections/.");
		return { root, file: resolved, relativeFile: path.relative(root, resolved).split(path.sep).join("/") };
	}

	async function parse(cwd: string, relativeFile: string): Promise<ParsedCollection> {
		const resolved = await resolveFile(cwd, relativeFile);
		const text = await readFile(resolved.file, "utf8");
		const document = JSON.parse(text) as Record<string, unknown>;
		const collection = collectionRoot(document);
		new Collection(collection);
		return { ...resolved, text, document, collection };
	}

	async function files(cwd: string, directory = collectionsRoot(cwd)): Promise<string[]> {
		const entries = await readdir(directory, { withFileTypes: true });
		const nested = await Promise.all(entries.map(async (entry) => {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) return files(cwd, entryPath);
			return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
		}));
		return nested.flat();
	}

	async function atomicReplace(cwd: string, parsed: ParsedCollection, candidate: string, targetPath: string[], expectedItem: RawItem) {
		const temp = path.join(path.dirname(parsed.file), `.${path.basename(parsed.file)}.${randomUUID()}.tmp`);
		try {
			await writeFile(temp, candidate, { encoding: "utf8", flag: "wx" });
			await rename(temp, parsed.file);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
		const reread = await parse(cwd, parsed.relativeFile);
		const verified = findTarget(reread.collection, targetPath);
		if (JSON.stringify(verified.item) !== JSON.stringify(expectedItem)) throw new Error("Post-write verification failed.");
	}

	pi.registerTool({
		name: "postman_collection",
		label: "Postman Collection",
		description: "Search Postman collection or request names, inspect a compact collection tree, read one exact request, or safely update one existing request under collections/. Request paths must be exact; updates use atomic replacement and post-write verification.",
		parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const input = params as Record<string, unknown>;
				if (input.action === "search_collections") {
					if (typeof input.query !== "string" || !input.query.trim()) throw new Error("query must be a non-empty string.");
					const root = collectionsRoot(ctx.cwd);
					const query = input.query.trim().toLocaleLowerCase();
					const limit = typeof input.limit === "number" ? input.limit : 20;
					const matches = (await Promise.all((await files(ctx.cwd)).map(async (file) => {
						const document = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
						const collection = collectionRoot(document);
						new Collection(collection);
						const name = isObject(collection.info) && typeof collection.info.name === "string" ? collection.info.name : "";
						const relativeFile = path.relative(root, file).split(path.sep).join("/");
						return `${relativeFile}\n${name}`.toLocaleLowerCase().includes(query) ? { file: relativeFile, name, id: isObject(collection.info) ? collection.info._postman_id : undefined, requests: walkRequests(collection.item).length } : undefined;
					}))).filter((match): match is NonNullable<typeof match> => match !== undefined)
						.sort((a, b) => a.file.localeCompare(b.file)).slice(0, limit);
					return result({ query: input.query, collections: matches, returned: matches.length, truncated: matches.length === limit });
				}

				if (input.action === "search_requests") {
					if (typeof input.query !== "string" || !input.query.trim()) throw new Error("query must be a non-empty string.");
					const root = collectionsRoot(ctx.cwd);
					const query = input.query.trim().toLocaleLowerCase();
					const limit = typeof input.limit === "number" ? input.limit : 50;
					const collectionFiles = input.collection_file === undefined ? await files(ctx.cwd) : [(await resolveFile(ctx.cwd, String(input.collection_file))).file];
					const matches = (await Promise.all(collectionFiles.map(async (file) => {
						const document = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
						const collection = collectionRoot(document);
						new Collection(collection);
						const collectionFile = path.relative(root, file).split(path.sep).join("/");
						return walkRequests(collection.item).filter(({ item, path: itemPath }) => `${itemPath.join(" / ")}\n${requestMethod(item) ?? ""}\n${requestUrl(item) ?? ""}`.toLocaleLowerCase().includes(query)).map(({ item, path: itemPath }) => ({ collectionFile, path: itemPath, id: item.id, name: item.name, method: requestMethod(item), url: requestUrl(item) }));
					}))).flat().sort((a, b) => `${a.collectionFile}/${a.path.join("/")}`.localeCompare(`${b.collectionFile}/${b.path.join("/")}`)).slice(0, limit);
					return result({ query: input.query, collectionFile: input.collection_file, requests: matches, returned: matches.length, truncated: matches.length === limit });
				}

				if (input.action === "list_collections") {
					const root = collectionsRoot(ctx.cwd);
					const collectionFiles = await files(ctx.cwd);
					const collections = await Promise.all(collectionFiles.map(async (file) => {
						const text = await readFile(file, "utf8");
						const document = JSON.parse(text) as Record<string, unknown>;
						const collection = collectionRoot(document);
						new Collection(collection);
						const requests = walkRequests(collection.item);
						const folders = (function count(items: unknown): number { return Array.isArray(items) ? items.filter(isObject).reduce((total, item) => total + (Array.isArray(item.item) ? 1 + count(item.item) : 0), 0) : 0; })(collection.item);
						return { file: path.relative(root, file).split(path.sep).join("/"), name: isObject(collection.info) ? collection.info.name : undefined, id: isObject(collection.info) ? collection.info._postman_id : undefined, folders, requests: requests.length };
					}));
					return result({ collections: collections.sort((a, b) => a.file.localeCompare(b.file)) });
				}

				if (input.action === "tree") {
					if (input.collection_file === undefined) return result({ collections: (await files(ctx.cwd)).map((file) => path.relative(collectionsRoot(ctx.cwd), file).split(path.sep).join("/")).sort(), nextHint: "Pass collection_file to inspect its tree." });
					const parsed = await parse(ctx.cwd, String(input.collection_file));
					const maxDepth = typeof input.max_depth === "number" ? input.max_depth : 4;
					const maxNodes = typeof input.max_nodes === "number" ? input.max_nodes : 200;
					const nodes: Record<string, unknown>[] = [];
					treeNodes(parsed.collection.item, [], 0, maxDepth, maxNodes, nodes);
					const total = walkRequests(parsed.collection.item).length;
					return result({ collection: { file: parsed.relativeFile, name: isObject(parsed.collection.info) ? parsed.collection.info.name : undefined, requestCount: total }, tree: nodes, returnedNodes: nodes.length, truncated: nodes.length >= maxNodes, nextHint: "Use read_request with collection_file and item_path." });
				}

				if (input.action === "read_request") {
					const parsed = await parse(ctx.cwd, String(input.collection_file));
					if (!Array.isArray(input.item_path) || !input.item_path.every((part) => typeof part === "string")) throw new Error("item_path must be an array of strings.");
					const target = findTarget(parsed.collection, input.item_path as string[]);
					const request = target.item.request as Record<string, unknown>;
					const include = new Set(Array.isArray(input.include) ? input.include : []);
					const output: Record<string, unknown> = { method: request.method, url: requestUrl(target.item), bodyMode: isObject(request.body) ? request.body.mode : undefined, eventNames: eventNames(target.item), headerNames: Array.isArray(request.header) ? request.header.filter(isObject).map((header) => header.key) : [] };
					if (include.has("body")) output.body = request.body;
					if (include.has("scripts")) output.scripts = scriptEvents(target.item);
					if (include.has("headers")) output.headers = redactHeaders(request.header);
					if (include.has("url")) output.url = request.url;
					if (include.has("auth")) output.auth = redactAuth(request.auth);
					if (include.has("description")) output.description = target.item.description;
					return result({ target: { collectionFile: parsed.relativeFile, path: target.path, id: target.item.id, name: target.item.name }, request: output });
				}

				if (input.action === "update_request") {
					const resolved = await resolveFile(ctx.cwd, String(input.collection_file));
					return await withFileMutationQueue(resolved.file, async () => {
						const parsed = await parse(ctx.cwd, resolved.relativeFile);
						if (!Array.isArray(input.item_path) || !input.item_path.every((part) => typeof part === "string")) throw new Error("item_path must be an array of strings.");
						const candidateDocument = clone(parsed.document);
						const candidateCollection = collectionRoot(candidateDocument);
						const target = findTarget(candidateCollection, input.item_path as string[]);
						const changedFields = applyUpdate(target.item, input);
						new Collection(candidateCollection);
						const candidate = serialize(candidateDocument, parsed.text);
						JSON.parse(candidate);
						await atomicReplace(ctx.cwd, parsed, candidate, target.path, target.item);
						return result({ status: "updated", target: { collectionFile: parsed.relativeFile, path: target.path, id: target.item.id }, changedFields });
					});
				}

				throw new Error("Unknown action.");
			} catch (error) {
				return failure(error);
			}
		},
	});
}
