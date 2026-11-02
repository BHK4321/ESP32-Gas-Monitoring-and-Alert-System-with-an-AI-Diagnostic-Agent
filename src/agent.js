const TOOL_DEFINITIONS = [
  ['inspect_telemetry', 'Check whether sensor telemetry is recent and how many samples are available.'],
  ['check_signal_quality', 'Inspect the latest window for missing, invalid, or unstable readings.'],
  ['compare_baseline', 'Compare the recent gas response with the preceding baseline window.'],
  ['estimate_drift', 'Estimate gradual response shift across the recent window.']
].map(([name, description]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: {}, additionalProperties: false } }
}));

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(x => x.function.name));
const UNSAFE_REASSURANCE = /\b(?:no|not|without|zero)\s+(?:immediate\s+)?(?:safety\s+)?(?:concerns?|risk|danger|hazard)\b|\b(?:within|inside)\s+(?:the\s+)?(?:(?:acceptable|safe|normal|expected)\s+)?(?:operating\s+)?(?:range|limits?|threshold)\b|\b(?:is|are|looks|seems)\s+safe\b|\ball[-\s]clear\b/i;
const UNSAFE_CONTROL_ADVICE = /\b(?:disable|deactivate|silence|clear|reset|bypass|turn\s+off)\b.{0,35}\b(?:alarm|sensor|relay|fan|valve|actuator)\b/i;

function inspectTelemetry(state, now = Date.now()) {
  const latest = state.latest || {};
  const ageMs = latest.timestamp ? now - latest.timestamp : Infinity;
  return { fresh: ageMs < 5000, ageMs: Number.isFinite(ageMs) ? ageMs : null, count: (state.history || []).length };
}

function checkSignalQuality(state) {
  const recent = (state.history || []).slice(-12).map(x => x.gas).filter(Number.isFinite);
  const latest = state.latest || {};
  const span = recent.length ? Math.max(...recent) - Math.min(...recent) : 0;
  return {
    valid: Number.isFinite(latest.gas) && latest.gas >= 0 && latest.gas <= 1.5 && latest.quality !== 'unstable' && span < 0.75 && recent.length >= 5,
    samples: recent.length,
    span: +span.toFixed(3),
    qualityFlag: latest.quality || 'unknown'
  };
}

function compareBaseline(state) {
  const history = state.history || [], latest = state.latest || {};
  const old = history.slice(-60, -12).map(x => x.gas).filter(Number.isFinite);
  const recent = history.slice(-12).map(x => x.gas).filter(Number.isFinite);
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : latest.gas;
  const baseline = mean(old), recentMean = mean(recent);
  return { baselineIndex: +baseline.toFixed(3), recentMeanIndex: +recentMean.toFixed(3), riseIndex: +(recentMean - baseline).toFixed(3) };
}

function estimateDrift(state) {
  const window = (state.history || []).slice(-30).map(x => x.gas).filter(Number.isFinite);
  const shift = window.length > 1 ? window.at(-1) - window[0] : 0;
  const steps = window.slice(1).map((x, i) => Math.abs(x - window[i]));
  const largestStep = steps.length ? Math.max(...steps) : 0;
  const largestStepShare = Math.abs(shift) > 0 ? largestStep / Math.abs(shift) : 0;
  const pattern = largestStepShare > 0.35 ? 'abrupt_change' : Math.abs(shift) > 0.12 ? 'gradual_shift' : 'stable_or_small_change';
  return { shiftIndex: +shift.toFixed(3), largestStepIndex: +largestStep.toFixed(3), largestStepShare: +largestStepShare.toFixed(3), pattern, samples: window.length };
}

const TOOL_RUNNERS = {
  inspect_telemetry: state => inspectTelemetry(state),
  check_signal_quality: state => checkSignalQuality(state),
  compare_baseline: state => compareBaseline(state),
  estimate_drift: state => estimateDrift(state)
};

function runReadOnlyTool(name, state) {
  if (!TOOL_NAMES.has(name)) throw new Error(`Tool is not allowed: ${name}`);
  return TOOL_RUNNERS[name](state);
}

async function runOllamaAgent(state, options = {}) {
  const endpoint = options.endpoint || process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
  const model = options.model || process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';
  const fetchImpl = options.fetchImpl || fetch;
  const history = state.history || [];
  const latest = state.latest || {};
  const requiredTools = new Set(['inspect_telemetry', 'check_signal_quality']);
  if (latest.localAlarm || state.scenario === 'gas' || state.scenario === 'drift') {
    requiredTools.add('compare_baseline');
    requiredTools.add('estimate_drift');
  }
  const messages = [
    { role: 'system', content: 'You are a local gas-sensor diagnostics agent. Use the required read-only tools before answering; select additional tools when evidence needs checking. Report evidence and one next step in at most 80 words. Follow the change pattern returned by estimate_drift; do not call an abrupt change gradual or infer gradual drift from a single endpoint difference. Always call the value a normalized response index; it is not ppm or gas identity. Never declare the area safe or confirm a real leak from this prototype. Never control, clear, or bypass actuators or the ESP32 alarm; the device owns immediate alarm output. If data are stale or poor quality, say they cannot be trusted.' },
    { role: 'user', content: JSON.stringify({ task: 'Investigate this reading using diagnostic tools.', scenario: state.scenario, sampleCount: history.length, requiredTools: [...requiredTools], latest: { normalizedResponseIndex: latest.gas, sensorRawADC: latest.gasRaw, temperatureC: latest.temperature, humidityPercent: latest.humidity, localAlarm: latest.localAlarm, quality: latest.quality, source: latest.source, timestamp: latest.timestamp } }) }
  ];
  const trace = [];

  for (let turn = 0; turn < 8; turn++) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: TOOL_DEFINITIONS, stream: false, think: false, keep_alive: '10m', options: { temperature: 0.1, num_predict: 160, num_ctx: 4096 } }),
        signal: AbortSignal.timeout(options.timeoutMs || 180_000)
      });
    } catch (err) {
      throw new Error(`Cannot reach local Ollama at ${endpoint}: ${err.message}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama API returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const payload = await response.json();
    const message = payload.message;
    if (!message) throw new Error('Ollama returned no chat message.');
    const calls = message.tool_calls || [];

    if (calls.length) {
      messages.push(message);
      for (const call of calls) {
        const name = call.function?.name;
        if (!TOOL_NAMES.has(name)) {
          trace.push({ tool: name || 'unknown', result: { error: 'Rejected: tool is not on the read-only allowlist.' } });
          messages.push({ role: 'tool', tool_name: name || 'unknown', content: 'Tool rejected. Only the listed read-only sensor diagnostics are available.' });
          continue;
        }
        const result = runReadOnlyTool(name, state);
        trace.push({ tool: name, result });
        messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
        if (trace.length >= 8) break;
      }
      continue;
    }

    const completedTools = new Set(trace.map(x => x.tool));
    const missingTools = [...requiredTools].filter(x => !completedTools.has(x));
    if (missingTools.length) {
      messages.push(message, { role: 'user', content: `Before reporting, call these required read-only tools: ${missingTools.join(', ')}.` });
      continue;
    }
    const summary = (message.content || '').trim();
    if (!summary) throw new Error('Ollama finished without a diagnostic summary. Try a tool-calling model such as qwen2.5:1.5b.');
    const pattern = trace.find(x => x.tool === 'estimate_drift')?.result?.pattern;
    const contradictsPattern = (pattern === 'abrupt_change' && /\b(?:gradual|gradually|slow drift|slow shift)\b/i.test(summary)) || (pattern === 'gradual_shift' && /\b(?:abrupt|sudden)\b/i.test(summary));
    const rejectionReasons = [];
    if (UNSAFE_REASSURANCE.test(summary)) rejectionReasons.push('unsupported safety or threshold reassurance');
    if (UNSAFE_CONTROL_ADVICE.test(summary)) rejectionReasons.push('actuator-control advice');
    if (contradictsPattern) rejectionReasons.push('wording that conflicts with the measured change pattern');
    const rejected = rejectionReasons.length > 0;
    const localAlarm = latest.localAlarm ? 'ACTIVE' : 'CLEAR';
    const alarmDescription = latest.source === 'simulation'
      ? `Simulator alarm: ${localAlarm} (the ${state.scenario || 'selected'} scenario is simulated; this is not an ESP32 alarm).`
      : `ESP32-reported local alarm: ${localAlarm}.${latest.localAlarm ? ' Follow established site emergency procedures; do not use this prototype to clear an alarm.' : ''}`;
    const guardedSummary = rejected
      ? `The Ollama explanation was hidden because it matched a safeguard for ${rejectionReasons.join(' and ')}. This does not mean the model confirmed a leak or assessed the area as safe. ${alarmDescription} This prototype is not a certified gas detector.`
      : `${summary.replace(/\bgas concentration\b/gi, 'normalized sensor response').replace(/\bgas level\b/gi, 'normalized response index')}\n\nSafety limit: a normalized response index is not a gas concentration, and this prototype cannot determine whether an area is safe. ${alarmDescription}`;
    return { id: `INV-${Date.now()}`, timestamp: Date.now(), code: rejected ? 'OLLAMA_OUTPUT_WITHHELD' : 'OLLAMA_DIAGNOSIS', summary: guardedSummary, recommendations: [], tools: trace, confidence: 'MODEL-GENERATED', provider: 'Ollama', model };
  }
  throw new Error('Ollama did not complete a tool-based diagnosis within 8 turns. Check that the selected model supports tool calling.');
}

module.exports = { runOllamaAgent, TOOL_DEFINITIONS, runReadOnlyTool, inspectTelemetry, checkSignalQuality, compareBaseline, estimateDrift };
