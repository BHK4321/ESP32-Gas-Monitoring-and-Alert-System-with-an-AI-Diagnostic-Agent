const test = require('node:test');
const assert = require('node:assert/strict');
const { runOllamaAgent, TOOL_DEFINITIONS, runReadOnlyTool } = require('../src/agent');

function stateFor(values, extra = {}) {
  const now = Date.now();
  const history = values.map((gas, i) => ({ gas, timestamp: now - (values.length - i) * 1000, quality: 'ok' }));
  return { history, latest: { gas: values.at(-1), timestamp: now, localAlarm: false, quality: 'ok', source: 'simulation' }, scenario: 'normal', ...extra };
}
function response(message) { return { ok: true, json: async () => ({ message }) }; }

test('offers only read-only sensor diagnostics to Ollama', () => {
  const names = TOOL_DEFINITIONS.map(x => x.function.name);
  assert.deepEqual(names, ['inspect_telemetry', 'check_signal_quality', 'compare_baseline', 'estimate_drift']);
  assert.equal(names.some(x => /relay|actuator|valve|fan/i.test(x)), false);
});
test('executes Ollama-selected tools and returns its final explanation', async () => {
  const state = stateFor(Array(20).fill(0.74));
  const calls = [];
  const fakeFetch = async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) });
    if (calls.length === 1) return response({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'inspect_telemetry', arguments: {} } }] });
    if (calls.length === 2) return response({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'check_signal_quality', arguments: {} } }] });
    return response({ role: 'assistant', content: 'Recent telemetry is fresh and the sensor window is stable. The elevated normalized response needs operator verification.' });
  };
  const out = await runOllamaAgent(state, { model: 'qwen2.5:1.5b', fetchImpl: fakeFetch });
  assert.equal(out.provider, 'Ollama');
  assert.equal(out.model, 'qwen2.5:1.5b');
  assert.match(out.summary, /elevated normalized response/);
  assert.deepEqual(out.tools.map(x => x.tool), ['inspect_telemetry', 'check_signal_quality']);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[1].body.messages.some(m => m.role === 'tool' && m.tool_name === 'inspect_telemetry'), true);
});
test('rejects model-requested tools outside the allowlist', async () => {
  let count = 0;
  const fakeFetch = async () => ++count === 1
    ? response({ role: 'assistant', content: '', tool_calls: ['switch_relay','inspect_telemetry','check_signal_quality'].map(name => ({ function: { name, arguments: {} } })) })
    : response({ role: 'assistant', content: 'That requested tool was denied; no physical action was taken.' });
  const out = await runOllamaAgent(stateFor(Array(10).fill(0.25)), { fetchImpl: fakeFetch });
  assert.equal(out.tools[0].result.error.startsWith('Rejected'), true);
  assert.equal(Object.hasOwn(out, 'actuatorCommand'), false);
});
test('withholds unsafe model reassurance and attaches the device alarm state', async () => {
  let count = 0;
  const fakeFetch = async () => ++count === 1
    ? response({ role: 'assistant', content: '', tool_calls: ['inspect_telemetry','check_signal_quality','compare_baseline','estimate_drift'].map(name => ({ function: { name, arguments: {} } })) })
    : response({ role: 'assistant', content: 'The readings are within acceptable range. There are no immediate safety concerns.' });
  const state = stateFor(Array(12).fill(0.8));
  state.latest.localAlarm = true;
  const out = await runOllamaAgent(state, { fetchImpl: fakeFetch });
  assert.equal(out.code, 'OLLAMA_OUTPUT_WITHHELD');
  assert.match(out.summary, /matched a safeguard for unsupported safety or threshold reassurance/);
  assert.match(out.summary, /simulator alarm: ACTIVE/i);
  assert.match(out.summary, /not an ESP32 alarm/i);
  assert.doesNotMatch(out.summary, /within acceptable range|no immediate safety concerns/i);
});
test('diagnostic tools detect unstable input, gradual drift, and an abrupt step', () => {
  const unstable = stateFor(Array.from({ length: 12 }, (_, i) => i % 2 ? 0.1 : 1.4), { latest: { gas: 1.4, timestamp: Date.now(), quality: 'unstable' } });
  assert.equal(runReadOnlyTool('check_signal_quality', unstable).valid, false);
  const ramp = stateFor(Array.from({ length: 30 }, (_, i) => 0.2 + i * 0.01));
  const gradual = runReadOnlyTool('estimate_drift', ramp);
  assert.ok(gradual.shiftIndex > 0.12);
  assert.equal(gradual.pattern, 'gradual_shift');
  const step = stateFor(Array.from({ length: 30 }, (_, i) => i < 15 ? 0.2 : 0.8));
  assert.equal(runReadOnlyTool('estimate_drift', step).pattern, 'abrupt_change');
});
test('withholds an Ollama summary that contradicts the estimated change pattern', async () => {
  let count = 0;
  const fakeFetch = async () => ++count === 1
    ? response({ role: 'assistant', content: '', tool_calls: ['inspect_telemetry','check_signal_quality','compare_baseline','estimate_drift'].map(name => ({ function: { name, arguments: {} } })) })
    : response({ role: 'assistant', content: 'The sensor response shows a gradual shift over the window.' });
  const values = Array.from({ length: 30 }, (_, i) => i < 15 ? 0.2 : 0.8);
  const out = await runOllamaAgent(stateFor(values, { scenario: 'gas' }), { fetchImpl: fakeFetch });
  assert.equal(out.code, 'OLLAMA_OUTPUT_WITHHELD');
  assert.match(out.summary, /wording that conflicts with the measured change pattern/);
  assert.equal(out.tools.find(x => x.tool === 'estimate_drift').result.pattern, 'abrupt_change');
});
test('does not silently switch to rules if the Ollama API is unavailable', async () => {
  await assert.rejects(() => runOllamaAgent(stateFor([0.25]), { fetchImpl: async () => { throw new Error('offline'); } }), /Cannot reach local Ollama/);
});
