const fs = require('node:fs');
const path = require('node:path');
const { computeMetrics } = require('../src/benchmark');

const metrics = computeMetrics();
const reportDir = path.join(__dirname, '..', 'reports');
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, 'benchmark-latest.json');
fs.writeFileSync(reportPath, `${JSON.stringify(metrics, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(metrics, null, 2)}\nSaved: ${reportPath}\n`);
