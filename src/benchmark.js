const { performance } = require('node:perf_hooks');
const { classifyResponse } = require('./diagnostics');

function rng(seed) {
  let value = seed >>> 0;
  return () => { value = (1664525 * value + 1013904223) >>> 0; return value / 0x100000000; };
}
function makeCase(label, random, eventAt = 15) {
  const history = [];
  let fixedRaw = 1400 + Math.floor(random() * 200);
  const sharedLevel = 1.9 + random() * 1.1;
  const isolatedLevel = 1.8 + random() * 1.2;
  const driftSlope = 0.012 + random() * 0.012;
  const driftDirection = random() < 0.5 ? 1 : -1;
  for (let i = 0; i < 30; i++) {
    const jitter = () => (random() - 0.5) * 0.08;
    let a = 1 + jitter(), b = 1 + jitter(), rawA, rawB;
    if (label === 'shared_response' && i >= eventAt) { a = sharedLevel + jitter(); b = sharedLevel - 0.04 + jitter(); }
    if (label === 'adc_rail_low') { a = 0; rawA = 0; }
    if (label === 'adc_rail_high') { a = 4.095; rawA = 4095; }
    if (label === 'stuck_channel') { a = 1; rawA = fixedRaw; }
    if (label === 'missing_channel') { a = null; rawA = null; }
    if (label === 'channel_disagreement' && i >= eventAt) a = isolatedLevel + jitter();
    if (label === 'gradual_change') { a = b = 1 + driftDirection * i * driftSlope + jitter(); }
    if (a == null) { history.push({ timestamp: Date.now() - (30 - i) * 1000, gas: b, sensors: { a: null, b: { index: b, raw: Math.round(b * 1200) } }, quality: 'ok' }); continue; }
    rawA ??= Math.max(0, Math.min(4095, Math.round(a * 1200)));
    rawB ??= Math.max(0, Math.min(4095, Math.round(b * 1200)));
    if (label === 'stuck_channel') rawA = fixedRaw;
    history.push({ timestamp: Date.now() - (30 - i) * 1000, gas: (a + b) / 2, sensors: { a: { index: a, raw: rawA }, b: { index: b, raw: rawB } }, quality: 'ok' });
  }
  return { scenario: label, mode: 'simulation', history, latest: history.at(-1) };
}

function computeMetrics({ seed = 4321, repetitions = 100 } = {}) {
  const labels = ['normal', 'shared_response', 'adc_rail_low', 'adc_rail_high', 'stuck_channel', 'missing_channel', 'channel_disagreement', 'gradual_change'];
  const expected = { normal: 'no_threshold_anomaly', shared_response: 'shared_response_anomaly', adc_rail_low: 'sensor_fault', adc_rail_high: 'sensor_fault', stuck_channel: 'sensor_fault', missing_channel: 'sensor_fault', channel_disagreement: 'uncertain_channel_disagreement', gradual_change: 'gradual_response_change' };
  const matrix = Object.fromEntries(labels.map(label => [expected[label], Object.fromEntries(Object.values(expected).map(name => [name, 0]))]));
  const timings = [];
  const delays = [];
  let runSeed = seed;
  for (const label of labels) {
    for (let n = 0; n < repetitions; n++) {
      const state = makeCase(label, rng(runSeed++));
      const start = performance.now();
      const prediction = classifyResponse(state).classification;
      timings.push(performance.now() - start);
      matrix[expected[label]][prediction] = (matrix[expected[label]][prediction] || 0) + 1;
      if (label === 'shared_response') {
        for (let i = 14; i < state.history.length; i++) {
          const partial = { ...state, history: state.history.slice(0, i + 1), latest: state.history[i] };
          if (classifyResponse(partial).classification === 'shared_response_anomaly') { delays.push(i - 14); break; }
        }
      }
    }
  }
  const names = [...new Set(Object.values(expected))];
  const total = repetitions * labels.length;
  let correct = 0;
  const perClass = {};
  for (const name of names) {
    const tp = matrix[name][name] || 0;
    const actual = Object.values(matrix[name]).reduce((a, b) => a + b, 0);
    const predicted = Object.values(matrix).reduce((sum, row) => sum + (row[name] || 0), 0);
    correct += tp;
    const precision = predicted ? tp / predicted : 0;
    const recall = actual ? tp / actual : 0;
    perClass[name] = { precision: +precision.toFixed(4), recall: +recall.toFixed(4), f1: +(precision + recall ? 2 * precision * recall / (precision + recall) : 0).toFixed(4), support: actual };
  }
  const sorted = timings.slice().sort((a, b) => a - b);
  const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] || 0;
  return {
    evaluationType: 'deterministic synthetic benchmark; not physical gas detection performance', seed, repetitionsPerClass: repetitions, cases: total,
    accuracy: +(correct / total).toFixed(4), macroF1: +(names.reduce((sum, name) => sum + perClass[name].f1, 0) / names.length).toFixed(4),
    perClass, confusionMatrix: matrix,
    sharedResponseDetectionDelay: { samplesAfterInjectedChangeP50: delays.length ? delays.sort((a, b) => a - b)[Math.floor((delays.length - 1) * 0.5)] : null, samplePeriodMsAssumed: 1000 },
    classifierRuntimeMs: { p50: +percentile(0.5).toFixed(4), p95: +percentile(0.95).toFixed(4) }
  };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(computeMetrics(), null, 2)}\n`);
module.exports = { makeCase, computeMetrics };
