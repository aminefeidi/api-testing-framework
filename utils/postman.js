const DEFAULT_BASE_URL = "https://api.getpostman.com";
import { readFile } from "node:fs/promises";

async function fetchJson(url, apiKey, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json",
      ...(body && { "Content-Type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Postman API ${method} ${response.status} ${response.statusText} for ${url}\n${text}`,
    );
  }

  return response.json();
}

export async function fetchEnvironment(
  apiKey,
  environmentId,
  baseUrl = DEFAULT_BASE_URL,
) {
  const url = `${baseUrl}/environments/${encodeURIComponent(environmentId)}`;
  const { environment } = await fetchJson(url, apiKey);
  return environment;
}

export async function persistEnvironment(
  apiKey,
  environmentId,
  environmentPath,
  baseUrl = DEFAULT_BASE_URL,
) {
  const fileContent = await readFile(environmentPath, "utf-8");
  const wrappedContent = `{ "environment": ${fileContent} }`;
  const { environment } = JSON.parse(wrappedContent);

  // Convert all variable values to strings before persisting
  environment.values = environment.values.map((v) => ({
    ...v,
    value: stringifyValue(v.value),
  }));

  const url = `${baseUrl}/environments/${encodeURIComponent(environmentId)}`;
  await fetchJson(url, apiKey, { method: "PUT", body: { environment } });
  console.log(`Environment "${environment.name}" persisted to Postman.`);
}

/**
 * Converts a value to string representation.
 * null/undefined become "", objects/arrays are JSON-stringified,
 * everything else is coerced via String().
 */
function stringifyValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Updates a variable's initialValue and currentValue in-place.
 * initialValue is the shared default; currentValue is used at runtime.
 */
export function setEnvironmentValue(environment, key, value) {
  const entry = environment.values.find((v) => v.key === key);
  if (!entry) {
    console.warn(`Key "${key}" not found in environment.`);
    return;
  }
  entry.initialValue = value;
  entry.currentValue = value;
}
