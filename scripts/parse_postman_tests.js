import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Emulate __dirname in Node.js ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define path resolutions assuming script runs inside /scripts
const COLLECTIONS_DIR = path.join(__dirname, '../collections');
const OUTPUT_DIR = path.join(__dirname, '../output');

// Maps workspace subdirectories to your actual Dashboard Module names
const MODULE_MAPPING = {
    'Client': 'Client Management',
    'Talent': 'Talent Management',
    'Order': 'Order Management',
    'Contract': 'Contract Management',
    'Assignment': 'Assignment Management',
    'JobOrder': 'Job Order Management',
    'LPF': 'Payroll/Billing Line Management',
    'Timesheet': 'Timesheet Management'
};

// Canonical route patterns used to fold literal probe paths (bad ids, nulls, etc.)
// back onto their API route for dashboard aggregation. Placeholders match any segment.
const ROUTE_PATTERNS = [
    'POST /api/v1/clients',
    'GET /api/v1/clients/financial-accounts/{finAccId}',
    'GET /api/v1/clients/{clientId}',
    'PUT /api/v1/clients/{clientId}',
    'GET /api/v1/clients/{clientId}/contacts',
    'GET /api/v1/clients/{clientId}/financial-accounts',
    'POST /api/v1/clients/{clientId}/financial-accounts',
    'PUT /api/v1/clients/{clientId}/financial-accounts/{finAccId}',
    'POST /api/v1/talents',
    'POST /api/v1/talents/time-savings',
    'GET /api/v1/talents/financial-accounts/{finAccId}',
    'GET /api/v1/talents/{talentId}',
    'PUT /api/v1/talents/{talentId}',
    'GET /api/v1/talents/{talentId}/employment-profile',
    'POST /api/v1/talents/{talentId}/employment-profile',
    'PUT /api/v1/talents/{talentId}/employment-profile',
    'GET /api/v1/talents/{talentId}/financial-accounts',
    'POST /api/v1/talents/{talentId}/financial-accounts',
    'PUT /api/v1/talents/{talentId}/financial-accounts/{finAccId}',
    'GET /api/v1/talents/{talentId}/time-savings',
    'POST /api/v1/orders',
    'GET /api/v1/orders/{orderId}',
    'PUT /api/v1/orders/{orderId}',
    'POST /api/v1/assignments',
    'POST /api/v1/assignments/amendments/{assignmentId}',
    'GET /api/v1/assignments/{assignmentId}',
    'GET /api/v1/assignments/{assignmentId}/amendments',
    'GET /api/v1/assignments/{assignmentId}/amendments/{amendmentId}',
    'POST /api/v1/payable-items',
    'GET /api/v1/payable-items/{payrollLineId}',
    'POST /api/v1/billable-items',
    'GET /api/v1/billable-items/{billingLineId}',
    'POST /api/v1/timesheets',
    'GET /api/v1/timesheets/{timesheetId}',
    'PUT /api/v1/timesheets/{timesheetId}',
    'POST /api/v1/jobOrders',
    'GET /api/v1/jobOrders/{jobOrderId}',
    'PUT /api/v1/jobOrders/{jobOrderId}'
].map(p => {
    const [method, route] = p.split(' ');
    const segments = route.split('/').filter(Boolean);
    const fixedCount = segments.filter(s => !s.startsWith('{')).length;
    return { method, route, segments, fixedCount };
}).sort((a, b) => b.fixedCount - a.fixedCount); // prefer most-specific match

function normalizeEndpoint(method, cleanedPath) {
    const pathSegments = cleanedPath.split('?')[0].split('/').filter(Boolean);
    for (const pattern of ROUTE_PATTERNS) {
        if (pattern.method !== method) continue;
        if (pattern.segments.length !== pathSegments.length) continue;
        const matches = pattern.segments.every((seg, i) =>
            seg.startsWith('{') || seg === pathSegments[i]
        );
        if (matches) return pattern.route;
    }
    return cleanedPath; // unmatched: keep as-is
}

/**
 * Parses an individual Postman collection JSON file and extracts functional tests.
 */
function parsePostmanCollection(filePath, moduleName) {
    let data;
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        data = JSON.parse(fileContent);
    } catch (error) {
        console.error(`❌ Error reading or parsing JSON from ${filePath}:`, error.message);
        return [];
    }

    const extractedTests = [];

    // Recursive helper to traverse inner Postman folders and requests
    function traverseItems(items) {
        if (!Array.isArray(items)) return;

        for (const item of items) {
            if (item.item) {
                traverseItems(item.item); // Go deeper if nested folder exists inside Postman
            }

            if (item.request) {
                const requestName = (item.name || '').trim();

                // 🛑 FILTER RULE: Exclude requests starting with "Setup" (case-insensitive)
                if (/^setup/i.test(requestName)) {
                    continue;
                }

                const request = item.request;
                const method = request.method || 'GET';
                let urlPath = '';

                if (request.url) {
                    if (Array.isArray(request.url.path)) {
                        urlPath = '/' + request.url.path.join('/');
                    } else if (typeof request.url === 'string') {
                        urlPath = request.url;
                    } else if (request.url.raw) {
                        urlPath = request.url.raw;
                    }
                }

                // Clean routing strings and map {{id}} variables to dashboard style {id}
                const cleanedPath = urlPath
                    .replace(/^https?:\/\/[^\/]+/, '')
                    .replace(/^\{\{[^}]+\}\}/, '')
                    .replace(/\{\{([^}]+)\}\}/g, '{$1}');

                const endpoint = cleanedPath || '/';

                // Look for pm.test assertions inside the post-response test block
                const events = item.event || [];
                for (const event of events) {
                    if (event.listen === 'test' && event.script) {
                        const execLines = event.script.exec || [];
                        const scriptText = Array.isArray(execLines) ? execLines.join('\n') : execLines;

                        // Match top-level pm.test descriptions
                        const regex = /pm\.test\s*\(\s*['"`](.*?)['"`]/g;
                        let match;

                        while ((match = regex.exec(scriptText)) !== null) {
                            const testName = match[1];

                            // Evaluate Category Type based on typical validation failure strings
                            const combinedContext = `${filePath} ${requestName} ${testName}`.toLowerCase();
                            const negativeKeywords = ['reject', 'invalid', 'bad', 'missing', 'error', '400', '404', '403', 'fail'];
                            const isNegative = negativeKeywords.some(keyword => combinedContext.includes(keyword));
                            const testType = isNegative ? 'Negative' : 'Positive';

                            extractedTests.push({
                                module: moduleName,
                                operation: method,
                                endpoint: endpoint,
                                normalizedEndpoint: normalizeEndpoint(method, endpoint),
                                testName: testName,
                                type: testType,
                                description: `Verifies ${testName.toLowerCase()} for the '${requestName}' pipeline.`,
                                notes: ''
                            });
                        }
                    }
                }
            }
        }
    }

    if (data.item) {
        traverseItems(data.item);
    }

    return extractedTests;
}

/**
 * Recursively walks the physical OS directories to find .postman_collection.json files
 */
function walkDirectory(currentDir, callback) {
    if (!fs.existsSync(currentDir)) {
        console.error(`❌ Source collections directory does not exist at: ${currentDir}`);
        return;
    }

    const files = fs.readdirSync(currentDir);
    for (const file of files) {
        const fullPath = path.join(currentDir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            walkDirectory(fullPath, callback);
        } else if (file.endsWith('.postman_collection.json')) {
            // Determine immediate subfolder name (e.g. Client, Talent) to assign to a Module
            const pathParts = currentDir.split(path.sep);
            const parentFolder = pathParts[pathParts.length - 1];
            const displayModule = MODULE_MAPPING[parentFolder] || parentFolder;
            callback(fullPath, displayModule);
        }
    }
}

/**
 * Escapes strings to generate cleanly-formatted RFC 4180 CSV files
 */
const escapeCSV = (val) => {
    if (!val) return '';
    let str = val.toString().replace(/"/g, '""');
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
        str = `"${str}"`;
    }
    return str;
};

/**
 * Execution Orchestrator
 */
function main() {
    const allRecords = [];

    console.log(`🚀 Scanning Postman collections directory: "${COLLECTIONS_DIR}"`);

    walkDirectory(COLLECTIONS_DIR, (filePath, moduleName) => {
        const fileRecords = parsePostmanCollection(filePath, moduleName);
        allRecords.push(...fileRecords);
    });

    if (allRecords.length === 0) {
        console.log('⚠️ No testing assertions were found after skipping setup entries.');
        return;
    }

    // Ensure target output folder directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // -------------------------------------------------------------
    // GENERATION 1: Granular Test Cases Sheet
    // -------------------------------------------------------------
    const testCasesFilename = path.join(OUTPUT_DIR, 'Tests_API_FR-One_Southbound_-_Test_Cases.csv');
    const testCasesHeaders = ['Module', 'Endpoint', 'Test Name', 'Type', 'Description', 'Notes / Blocker'];
    let testCasesCsv = testCasesHeaders.join(',') + '\n';

    for (const record of allRecords) {
        const row = [
            escapeCSV(record.module),
            escapeCSV(`${record.operation} ${record.endpoint}`),
            escapeCSV(record.testName),
            escapeCSV(record.type),
            escapeCSV(record.description),
            escapeCSV(record.notes)
        ];
        testCasesCsv += row.join(',') + '\n';
    }
    fs.writeFileSync(testCasesFilename, testCasesCsv, 'utf8');

    // -------------------------------------------------------------
    // GENERATION 2: Computed Real Data Dashboard Summary
    // -------------------------------------------------------------
    const dashboardFilename = path.join(OUTPUT_DIR, 'Tests_API_FR-One_Southbound_-_Dashboard.csv');
    const dashboardAggregation = {};

    for (const record of allRecords) {
        const key = `${record.module}|${record.operation}|${record.normalizedEndpoint}`;
        if (!dashboardAggregation[key]) {
            dashboardAggregation[key] = {
                module: record.module,
                operation: record.operation,
                endpoint: record.normalizedEndpoint,
                total: 0,
                positive: 0,
                negative: 0
            };
        }
        dashboardAggregation[key].total += 1;
        if (record.type === 'Positive') dashboardAggregation[key].positive += 1;
        if (record.type === 'Negative') dashboardAggregation[key].negative += 1;
    }

    const dashboardHeaders = ['Module', 'Operation', 'Endpoint', 'Total tests', 'Positive', 'Negative', 'Statut'];
    let dashboardCsv = dashboardHeaders.join(',') + '\n';

    let lastModuleSeen = '';
    for (const key of Object.keys(dashboardAggregation)) {
        const item = dashboardAggregation[key];
        const moduleCell = item.module === lastModuleSeen ? '' : item.module;
        lastModuleSeen = item.module;

        const row = [
            escapeCSV(moduleCell),
            escapeCSV(item.operation),
            escapeCSV(item.endpoint),
            item.total,
            item.positive,
            item.negative,
            'Done'
        ];
        dashboardCsv += row.join(',') + '\n';
    }
    fs.writeFileSync(dashboardFilename, dashboardCsv, 'utf8');

    console.log(`\n🎉 Success! Files compiled directly inside target output folder:`);
    console.log(` ➡️  Test Cases (Prepend Module Column): "${path.basename(testCasesFilename)}"`);
    console.log(` ➡️  Dashboard (Sum Calculations Metrics): "${path.basename(dashboardFilename)}"`);
}

main();
