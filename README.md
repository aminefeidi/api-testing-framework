# API Testing Framework

Automated API testing framework for Postman collections using Newman.

## Features

- Run Postman collections individually or as one merged suite
- Generate HTML and JSON reports
- Load collections from local files
- Fetch and persist Postman environments through the API
- Filter collections by name or path
- Keep API keys in environment variables
- Includes a Pi extension at `.pi/extensions/postman.ts` for inspecting and safely updating Postman collections from Pi
- Includes the `postman-collection-updater` skill at `.agents/skills/postman-collection-updater/SKILL.md` for atomic request updates

## Prerequisites

- Node.js 20 or newer
- A Postman API key
- A Postman environment ID

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the project root:

```dotenv
POSTMAN_API_KEY=your_postman_api_key
POSTMAN_ENV_ID=your_postman_environment_id
```

Set `RootpathOne` and any test data variables in `environments/Dev.postman_environment.json` for the API under test. The committed environment is a safe template.

## Usage

Run all collections:

```bash
npm test -- postmanEnvId="your_postman_environment_id"
```

Run collections matching a name or path fragment:

```bash
npm test -- target="Client" postmanEnvId="your_postman_environment_id"
npm test -- target="Order/[Order] Create" postmanEnvId="your_postman_environment_id"
```

A single matching collection runs in individual mode and gets its own report.

## Other commands

Download collections from a Postman workspace:

```bash
npm run download:collections -- --workspace-id <workspace-id>
```

Generate CSV test-case and dashboard reports from local collections:

```bash
node scripts/parse_postman_tests.js
```

Reports are written to `output/`.
