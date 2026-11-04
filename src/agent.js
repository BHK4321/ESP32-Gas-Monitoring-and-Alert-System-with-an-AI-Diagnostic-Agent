require('./load-env').loadEnvFile();
const diagnostics = require('./diagnostics');

const TOOL_DEFINITIONS = [
  ['inspect_telemetry', 'Check data freshness, history length, and telemetry source.'],
  ['assess_sensor_health', 'Check each channel for missing data, ADC rail, stuck values, and out-of-range response.'],
  ['compare_channels', 'Compare recent response indices from independent channels A and B.'],
  ['classify_response', 'Classify the observed pattern conservatively as shared anomaly, sensor fault, drift, normal, or uncertain.'],
  ['estimate_drift', 'Estimate gradual or abrupt changes per channel and whether both channels agree.']
].map(([name, description]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {}, additionalProperties: false } } }));

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(x => x.function.name));
const UNSAFE_REASSURANCE = /\b(?:no|not|without|zero)\s+(?:immediate\s+)?(?:safety\s+)?(?:concerns?|risk|danger|hazard)\b|\b(?:within|inside)\s+(?:the\s+)?(?:(?:acceptable|safe|normal|expected)\s+)?(?:operating\s+)?(?:range|limits?|threshold)\b|\b(?:is|are|looks|seems)\s+safe\b|\ball[-\s]clear\b/i;
const UNSAFE_CONTROL_ADVICE = /\b(?:disable|deactivate|silence|clear|reset|bypass|turn\s+off)\b.{0,35}\b(?:alarm|sensor|relay|fan|valve|actuator)\b/i;
const CONFIRMED_GAS_CLAIM = /\b(?:(?:confirmed|definitely|detected)\s+(?:a\s+)?(?:gas\s+leak|leak|gas)|(?:gas\s+)?(?:leak|gas)\s+(?:was\s+)?(?:confirmed|detected|definitely\s+detected))\b/i;

function runReadOnlyTool(name, state) {
  const runners = {
    inspect_telemetry: diagnostics.inspectTelemetry,
    assess_sensor_health: diagnostics.assessSensorHealth,
    compare_channels: diagnostics.compareChannels,
    classify_response: diagnostics.classifyResponse,
    estimate_drift: diagnostics.estimateDrift
  };
  if (!TOOL_NAMES.has(name)) throw new Error(`Tool is not allowed: ${name}`);
  return runners[name](state);
}

async function runOllamaAgent(state, options = {}) {
  const endpoint = options.endpoint || process.env.OLLAMA_URL || 'https://ollama.com/api/chat';
  const model = options.model || process.env.OLLAMA_MODEL || 'gpt-oss:120b';
  const cloud = new URL(endpoint).hostname === 'ollama.com';
  const apiKey = options.apiKey || process.env.OLLAMA_API_KEY;
  if (cloud && !apiKey) throw new Error('OLLAMA_API_KEY is required for Ollama Cloud. Set it in this terminal before starting the server.');
  const fetchImpl = options.fetchImpl || fetch;
  const latest = state.latest || {};
  const requiredTools = new Set(['inspect_telemetry', 'assess_sensor_health', 'classify_response']);
  const turnsUsed = [];
  const result = diagnostics.classifyResponse(state);
  const messages = [
    { role: 'system', content: 'You are a sensor diagnostics agent. Select and call the required read-only tools before answering. Use tool outputs as evidence; do not diagnose a real leak or assert the physical cause. Distinguish sensor fault, shared response anomaly, drift, and uncertain channel disagreement. Call an uncertain result uncertain. Report key numeric evidence and one next step in at most 90 words. A response index is relative to each sensor startup baseline, not ppm or gas identity. Never declare an area safe, and never control, clear, or bypass the ESP32 alarm or other actuator.' },
    { role: 'user', content: JSON.stringify({ task: 'Investigate the latest sensor history, choose diagnostic checks, and explain what the evidence supports.', scenario: state.scenario, historySamples: (state.history || []).length, requiredTools: [...requiredTools], latest: { responseIndexA: latest.sensors?.a?.index, responseIndexB: latest.sensors?.b?.index, rawA: latest.sensors?.a?.raw, rawB: latest.sensors?.b?.raw, temperatureC: latest.temperature, humidityPercent: latest.humidity, localAlarm: latest.localAlarm, source: latest.source }, ruleClassification: result.classification }) }
  ];
  const trace = [];

  for (let turn = 0; turn < 10; turn++) {
    let response;
    try {
      const headers = { 'content-type': 'application/json' };
      if (cloud) headers.authorization = `Bearer ${apiKey}`;
      response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify({ model, messages, tools: TOOL_DEFINITIONS, stream: false, think: false, options: { temperature: 0.1, num_predict: 192, num_ctx: 4096 } }), signal: AbortSignal.timeout(options.timeoutMs || 180_000) });
    } catch (err) { throw new Error(`Cannot reach Ollama API at ${endpoint}: ${err.message}`); }
    if (!response.ok) { const detail = await response.text().catch(() => ''); throw new Error(`Ollama API returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`); }
    const payload = await response.json();
    const message = payload.message;
    if (!message) throw new Error('Ollama returned no chat message.');
    const calls = message.tool_calls || [];
    turnsUsed.push(calls.map(call => call.function?.name || 'unknown').join(',') || 'final');
    if (calls.length) {
      messages.push(message);
      for (const call of calls) {
        const name = call.function?.name;
        if (!TOOL_NAMES.has(name)) {
          trace.push({ tool: name || 'unknown', result: { error: 'Rejected: tool is not on the read-only allowlist.' } });
          messages.push({ role: 'tool', tool_name: name || 'unknown', content: 'Tool rejected. Only listed read-only diagnostics are available.' });
        } else {
          const toolResult = runReadOnlyTool(name, state);
          trace.push({ tool: name, result: toolResult });
          messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(toolResult) });
        }
        if (trace.length >= 10) break;
      }
      continue;
    }
    const completed = new Set(trace.map(x => x.tool));
    const missing = [...requiredTools].filter(name => !completed.has(name));
    if (missing.length) { messages.push(message, { role: 'user', content: `Before answering, call these required read-only tools: ${missing.join(', ')}.` }); continue; }
    const summary = (message.content || '').trim();
    if (!summary) throw new Error('Ollama finished without a diagnostic summary.');
    const pattern = trace.find(x => x.tool === 'estimate_drift')?.result?.jointPattern;
    const contradictsPattern = (pattern === 'abrupt_change' && /\b(?:gradual|gradually|slow drift|slow shift)\b/i.test(summary)) || (pattern === 'gradual_shift' && /\b(?:abrupt|sudden)\b/i.test(summary));
    const reasons = [];
    if (UNSAFE_REASSURANCE.test(summary)) reasons.push('unsupported safety or threshold reassurance');
    if (UNSAFE_CONTROL_ADVICE.test(summary)) reasons.push('actuator-control advice');
    if (CONFIRMED_GAS_CLAIM.test(summary)) reasons.push('a definitive gas/leak claim');
    if (contradictsPattern) reasons.push('wording that conflicts with the measured change pattern');
    const rejected = reasons.length > 0;
    const alarmSource = latest.source === 'simulation' ? `Simulator alarm: ${latest.localAlarm ? 'ACTIVE' : 'CLEAR'} (${state.scenario} scenario).` : `ESP32 alarm: ${latest.localAlarm ? 'ACTIVE' : 'CLEAR'}.`;
    const guarded = rejected
      ? `The model explanation was hidden because it matched a safeguard for ${reasons.join(' and ')}. Rule-based finding: ${result.classification} (${result.reason}) ${alarmSource}`
      : `${summary}\n\nRule-based finding: ${result.classification}. ${result.reason} ${alarmSource}`;
    return { id: `INV-${Date.now()}`, timestamp: Date.now(), code: rejected ? 'OLLAMA_OUTPUT_WITHHELD' : 'OLLAMA_DIAGNOSIS', summary: guarded, recommendations: [], tools: trace, diagnostics: result, confidence: 'MODEL-GENERATED + RULE METRICS', provider: cloud ? 'Ollama Cloud' : 'Ollama local API', model };
  }
  const completed = [...new Set(turnsUsed.flatMap(x => x === 'final' ? [] : x.split(',')))];
  const missing = [...requiredTools].filter(name => !completed.includes(name));
  throw new Error(`Ollama did not complete a tool-based diagnosis within 10 turns. Completed: ${completed.join(', ') || 'none'}. Missing required: ${missing.join(', ') || 'none'}.`);
}

module.exports = { runOllamaAgent, TOOL_DEFINITIONS, runReadOnlyTool };
