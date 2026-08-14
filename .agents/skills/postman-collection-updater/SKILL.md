---
name: postman-collection-updater
description: Make safe, atomic updates to one existing Postman collection request through the project-local postman_collection Pi extension. Use for changing request bodies, URLs, methods, headers, auth, descriptions, or prerequest/test scripts; do not use for creating or deleting collections or requests.
---

# postman-collection-updater

> **One request per session. Exact target. Atomic write. Fresh read before every update.**

This skill edits one existing request in one Postman collection. It uses the project-local `postman_collection` extension instead of broad file edits. The extension validates the collection, resolves an exact request path, serializes a candidate copy, replaces the file atomically, and rereads the file to verify the requested item after writing.

The skill is deliberately narrow: it updates existing request fields only. It does not create or delete collections, folders, requests, environments, or scripts outside the selected request.

## Supported changes

The extension can update these fields:

- HTTP method
- URL
- Raw request body, optionally setting its language
- Request headers
- Request-level authentication
- Request description
- Request-local `prerequest` and `test` scripts

A script update replaces the complete `exec` array for that listener. Always preserve existing lines unless the user explicitly asks to replace them.

## What the user provides

The user should provide:

1. A collection path relative to `collections/`, for example:
   `collections/Sample/[Sample] JSONPlaceholder CRUD.postman_collection.json`
2. The exact request to change, preferably as its full item path.
3. The desired change.

If the collection or request is not specified, ask for it. Do not choose a request based only on a loose name when multiple matches are possible.

## Non-negotiable safety rules

1. **Stay inside `collections/`.** `collection_file` must be a relative `.json` path under the project `collections/` directory. Never pass an absolute path or `..` segment.
2. **Discover before editing.** Use `tree` or `search_requests` first. Do not guess an item path.
3. **Read before writing.** Use `read_request` with the relevant `include` fields immediately before the update. Treat its result as the source of truth.
4. **One request only.** Never update multiple requests in one call or silently broaden the target.
5. **Preserve unrelated data.** Send only the requested changed fields. When changing scripts, send the complete existing listener script plus the requested modification.
6. **No generic file writer.** When the extension is available, do not use shell, `write`, or broad JSON editing to mutate a collection.
7. **Validate content before update.** JSON request bodies must parse. Script lines must be strings and must compile under the extension's validation. Headers must not contain control characters.
8. **Stop on ambiguity or drift.** If the exact request is missing, duplicated, or the read result no longer matches the requested target, stop and ask the user rather than selecting another item.
9. **No secrets in output.** Do not print `.env`, API keys, passwords, bearer tokens, or unredacted auth. The extension redacts sensitive headers/auth when reading them.
10. **No unrelated cleanup.** Do not reformat, rename, reorder, or “fix” nearby requests.

## Session start

Print this header before tool calls:

```text
postman-collection-updater — session start
collection: <collection path>
request:    <pending exact item path>
change:     <short description>
```

## Workflow

### 1. Resolve the collection and exact request

Use the project-local `postman_collection` tool. If it is not loaded, reload Pi so `.pi/extensions/postman.ts` is discovered. The tool is available from the project root and supports these actions:

```json
{"action":"search_collections","query":"JSONPlaceholder"}
```

Then inspect the selected collection:

```json
{
  "action": "tree",
  "collection_file": "Sample/[Sample] JSONPlaceholder CRUD.postman_collection.json",
  "max_depth": 4,
  "max_nodes": 200
}
```

Use the exact `path` returned in the tree as `item_path`. For a request at the collection root, this is usually a one-element array such as `["Create Post"]`; for nested folders, include every folder name in order.

If the request name is unknown, use:

```json
{"action":"search_requests","query":"Create","collection_file":"Sample/[Sample] JSONPlaceholder CRUD.postman_collection.json"}
```

Do not treat search output as authorization to edit. It only identifies candidates; the exact tree path is required.

### 2. Read the current request

Read only the fields needed to understand and perform the requested change:

```json
{
  "action": "read_request",
  "collection_file": "Sample/[Sample] JSONPlaceholder CRUD.postman_collection.json",
  "item_path": ["Create Post"],
  "include": ["body", "scripts", "headers", "url", "auth", "description"]
}
```

Confirm:

- The collection file and exact item path are correct.
- The HTTP method and URL match the intended request.
- The body mode supports the requested body change. `raw_body` updates require an existing raw body.
- Existing scripts, headers, auth, and description are understood before replacing any of them.

If the desired change conflicts with the current request or requires an unsupported structural change, stop and report it.

### 3. Build the smallest update

Construct only the changed fields for `update_request`:

```json
{
  "action": "update_request",
  "collection_file": "Sample/[Sample] JSONPlaceholder CRUD.postman_collection.json",
  "item_path": ["Create Post"],
  "raw_body": "{\n  \"title\": \"Updated sample\",\n  \"body\": \"Example\",\n  \"userId\": 1\n}",
  "body_language": "json"
}
```

For script changes, provide the complete replacement listener, not only a fragment:

```json
{
  "action": "update_request",
  "collection_file": "Sample/[Sample] JSONPlaceholder CRUD.postman_collection.json",
  "item_path": ["Get Post"],
  "scripts": [
    {
      "listen": "test",
      "exec": [
        "pm.test('returns HTTP 200', function () {",
        "    pm.response.to.have.status(200);",
        "});",
        "",
        "pm.test('has an id', function () {",
        "    pm.expect(pm.response.json().id).to.be.a('number');",
        "});"
      ]
    }
  ]
}
```

Do not send unchanged fields unless needed to preserve a complete script listener. Do not send `scripts` with duplicate `listen` values. Do not use `raw_body` to change a non-raw request.

### 4. Execute and verify the atomic update

Call `update_request` once with the exact path and smallest valid change. The extension:

1. Locks mutations for the target file.
2. Reloads and validates the source collection.
3. Resolves the exact request path.
4. Applies the requested field update to a clone.
5. Validates the candidate collection and scripts.
6. Writes a temporary file and atomically renames it over the source.
7. Rereads the collection and verifies the selected request matches the candidate.

If the tool returns an error, assume no update was accepted unless verification says otherwise. Do not retry blindly. Read the request again to establish the actual state, then report or ask for a decision.

### 5. Post-update checks

After a successful update:

- Read the same request again with the changed field included.
- Confirm only the requested field changed.
- Parse the collection JSON if an independent syntax check is useful.
- If the user requested behavior changes, tell them that the API collection itself was not executed unless they explicitly asked for a run.

Do not run the whole suite as part of an edit unless requested. Updates are atomic file operations, not live API validation.

## Failure handling

Stop and report the exact error for:

- Collection file not found or outside `collections/`
- Request path not found or ambiguous
- Invalid JSON body
- Invalid JavaScript script
- Invalid HTTP method, URL, or header
- Unsupported body mode or structural operation
- Post-write verification failure
- Any change that would touch more than the selected request

Never “fix” an error by changing the target, disabling validation, adding a missing request, or editing the collection directly.

## Session end

Print this handoff:

```text
postman-collection-updater — session end
collection: <collection path>
request:    <exact item path>
status:     updated | not updated
fields:     <changed fields, or none>
verification: <same request reread successfully | failure reason>
backup:     <reported by the extension, if available>
next step:  <optional live test command, only if relevant>
```

## Examples

### Change a URL

```json
{
  "action": "update_request",
  "collection_file": "Sample/[Sample] JSONPlaceholder CRUD.postman_collection.json",
  "item_path": ["Get Post"],
  "url": "https://jsonplaceholder.typicode.com/posts/2"
}
```

### Add a request header

Because `headers` replaces the complete header list, first read the current headers, then send the complete desired list:

```json
{
  "action": "update_request",
  "collection_file": "Sample/[Sample] JSONPlaceholder CRUD.postman_collection.json",
  "item_path": ["List Posts"],
  "headers": [
    {"key":"Accept","value":"application/json"}
  ]
}
```

### Update a description

```json
{
  "action": "update_request",
  "collection_file": "Sample/[Sample] JSONPlaceholder CRUD.postman_collection.json",
  "item_path": ["Create Post"],
  "description": "Creates a sample resource for demonstration purposes."
}
```

## Scope boundary

This skill updates existing request fields only. It intentionally skips structural CRUD, collection-level event editing, environment editing, backup management outside what the extension performs, and live API execution. Add those capabilities only when the extension exposes explicit, independently validated operations for them.
