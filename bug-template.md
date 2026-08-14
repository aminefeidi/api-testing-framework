# [Module] Brief, clear summary of the issue — e.g., Endpoint X returns Error Y when Z

* **Affected Endpoint:** `[HTTP Method] [URL/Path — e.g., GET /api/v1/resource/{id}]`
* **Severity/Impact:** [e.g., Blocker / High / Medium / Low]
* **Environment:** [e.g., Sandbox, Staging, Production]

**Description**

[Flat and terse. Short fragments/bullets, not a narrative essay. State what's failing, what's affected, and the impact — no filler connectors ("this means that...", "as a result..."). Example:

`PUT` X ignores field Y. `200` every time. Other fields save fine, this one doesn't.

- Case A: [input] → [expected] → [actual]
- Case B: [input] → [expected] → [actual]]

**Error Response / Logs**

[Paste the relevant API response payload, terminal console logs, or server stack traces here.]

```json
{
  "code": "[ERROR_CODE]",
  "message": "[Error message details]",
  "timestamp": "[YYYY-MM-DDTHH:mm:ss.SSSSSSSSS]",
  "details": null
}

```

**Steps**

1. **Prerequisite:** [e.g., Create a prerequisite entity or authenticate to retrieve a valid token/ID].
2. **Action:** [e.g., Send a request to the affected endpoint using the data from Step 1].
3. **Observation:** [e.g., Observe the specific HTTP error status and response payload].

**Expected Behavior**

[Clearly describe what *should* happen when the system functions correctly. Specify expected HTTP status codes, data transformations, and the ideal end state.]

**Actual Behavior**

[Describe what *actually* happens, highlighting the discrepancy between reality and the expected behavior.]
