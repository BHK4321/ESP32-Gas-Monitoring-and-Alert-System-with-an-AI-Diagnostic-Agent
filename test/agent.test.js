const test = require('node:test');
const assert = require('node:assert/strict');
const { runOllamaAgent, TOOL_DEFINITIONS, runReadOnlyTool } = require('../src/agent');
const { loadEnvFile } = require('../src/load-env');
const { computeMetrics } = require('../src/benchmark');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stateFor(values, extra = {}) {
  const now = Date.now();
  const history = values.map((value, i) => { const index = value + ((i % 3) - 1) * 0.002; return { timestamp: now - (values.length - i) * 1000, gas: index, sensors: { a: { index, raw: Math.round(index * 1200) }, b: { index: index * 0.99, raw: Math.round(index * 0.99 * 1200) } }, quality: 'ok' }; });
  return { history, latest: { ...history.at(-1), timestamp: now, localAlarm: false, source: 'simulation' }, scenario: 'normal', mode: 'simulation', ...extra };
}
function response(message) { return { ok: true, json: async () => ({ message }) }; }

test('loads .env values without overriding variables already set by the shell', () => {
  const file = path.join(os.tmpdir(), `gas-monitor-env-${process.pid}.env`);
  const existing = process.env.OLLAMA_MODEL;
  process.env.OLLAMA_MODEL = 'shell-model';
  fs.writeFileSync(file, 'OLLAMA_MODEL=file-model\nOLLAMA_TEST_KEY="cloud key"\nOLLAMA_TEST_COMMENT=value # comment\n');
  try {
    loadEnvFile(file);
    assert.equal(process.env.OLLAMA_MODEL, 'shell-model');
    assert.equal(process.env.OLLAMA_TEST_KEY, 'cloud key');
    assert.equal(process.env.OLLAMA_TEST_COMMENT, 'value');
  } finally {
    delete process.env.OLLAMA_TEST_KEY;
    delete process.env.OLLAMA_TEST_COMMENT;
    if (existing === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = existing;
    fs.rmSync(file, { force: true });
  }
});

test('offers only read-only sensor diagnostic tools', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map(x => x.function.name), ['inspect_telemetry','assess_sensor_health','compare_channels','classify_response','estimate_drift']);
  assert.equal(TOOL_DEFINITIONS.some(x => /relay|actuator|valve|fan/i.test(x.function.name)), false);
});
test('executes Ollama-selected checks and returns evidence-based finding', async () => {
  const state = stateFor(Array(20).fill(1.1));
  const calls = [];
  const selected = ['inspect_telemetry','assess_sensor_health','classify_response'];
  const fakeFetch = async (url, request) => {
    calls.push({ url, headers: request.headers, body: JSON.parse(request.body) });
    if (calls.length === 1) return response({ role: 'assistant', content: '', tool_calls: selected.map(name => ({ function: { name, arguments: {} } })) });
    return response({ role: 'assistant', content: 'Both channels are recent and healthy, with a small difference between their response indices.' });
  };
  const out = await runOllamaAgent(state, { model: 'gpt-oss:120b', apiKey: 'test-key', fetchImpl: fakeFetch });
  assert.equal(out.provider, 'Ollama Cloud');
  assert.equal(out.model, 'gpt-oss:120b');
  assert.match(out.summary, /no_threshold_anomaly/);
  assert.deepEqual(out.tools.map(x => x.tool), selected);
  assert.equal(calls[0].url, 'https://ollama.com/api/chat');
  assert.equal(calls[0].headers.authorization, 'Bearer test-key');
});
test('rejects model-requested tools outside the read-only allowlist', async () => {
  let count = 0;
  const fakeFetch = async () => ++count === 1
    ? response({ role: 'assistant', content: '', tool_calls: ['switch_relay','inspect_telemetry','assess_sensor_health','classify_response'].map(name => ({ function: { name, arguments: {} } })) })
    : response({ role: 'assistant', content: 'The tool request was denied; no physical action was taken.' });
  const out = await runOllamaAgent(stateFor(Array(10).fill(1)), { apiKey: 'test-key', fetchImpl: fakeFetch });
  assert.equal(out.tools[0].result.error.startsWith('Rejected'), true);
  assert.equal(Object.hasOwn(out, 'actuatorCommand'), false);
});
test('classifies rail/stuck sensor fault, shared response, and disagreement separately', () => {
  const fault = stateFor(Array(12).fill(1));
  fault.history = fault.history.map(s => ({ ...s, sensors: { ...s.sensors, a: { raw: 4095, index: 4.095 } } }));
  fault.latest = fault.history.at(-1);
  assert.equal(runReadOnlyTool('classify_response', fault).classification, 'sensor_fault');
  const shared = stateFor(Array(12).fill(2.1));
  assert.equal(runReadOnlyTool('classify_response', shared).classification, 'shared_response_anomaly');
  const disagreement = stateFor(Array(12).fill(1));
  disagreement.history = disagreement.history.map(s => ({ ...s, sensors: { a: { raw: 2600, index: 2.6 }, b: { raw: 1200, index: 1.2 } } }));
  disagreement.latest = disagreement.history.at(-1);
  assert.equal(runReadOnlyTool('classify_response', disagreement).classification, 'uncertain_channel_disagreement');
});
test('estimates gradual versus abrupt changes from paired sensor history', () => {
  const ramp = stateFor(Array.from({ length: 30 }, (_, i) => 1 + i * 0.015));
  assert.equal(runReadOnlyTool('estimate_drift', ramp).jointPattern, 'gradual_shift');
  const step = stateFor(Array.from({ length: 30 }, (_, i) => i < 15 ? 1 : 2.1));
  assert.equal(runReadOnlyTool('estimate_drift', step).jointPattern, 'abrupt_change');
});
test('withholds unsafe or definitive gas claims and reports the deterministic finding', async () => {
  let count = 0;
  const fakeFetch = async () => ++count === 1
    ? response({ role: 'assistant', content: '', tool_calls: TOOL_DEFINITIONS.map(x => ({ function: { name: x.function.name, arguments: {} } })) })
    : response({ role: 'assistant', content: 'Gas leak detected and the area is safe after disabling the alarm.' });
  const state = stateFor(Array(12).fill(2.2));
  state.latest.localAlarm = true;
  const out = await runOllamaAgent(state, { apiKey: 'test-key', fetchImpl: fakeFetch });
  assert.equal(out.code, 'OLLAMA_OUTPUT_WITHHELD');
  assert.match(out.summary, /definitive gas\/leak claim/);
  assert.match(out.summary, /shared_response_anomaly/);
});
test('synthetic benchmark reports classification and runtime metrics', () => {
  const metrics = computeMetrics({ seed: 7, repetitions: 10 });
  assert.equal(metrics.cases, 80);
  assert.equal(metrics.evaluationType.includes('not physical'), true);
  assert.equal(typeof metrics.accuracy, 'number');
  assert.equal(typeof metrics.classifierRuntimeMs.p95, 'number');
});
test('requires a cloud API key and does not silently switch to rules if the API is unavailable', async () => {
  await assert.rejects(() => runOllamaAgent(stateFor([1]), { fetchImpl: async () => { throw new Error('offline'); } }), /OLLAMA_API_KEY is required/);
  await assert.rejects(() => runOllamaAgent(stateFor([1]), { apiKey: 'test-key', fetchImpl: async () => { throw new Error('offline'); } }), /Cannot reach Ollama API/);
});
