const CHANNELS = ['a', 'b'];

function channelOf(sample, id) {
  const source = sample?.sensors?.[id];
  if (source && source.index != null && Number.isFinite(Number(source.index))) return { index: Number(source.index), raw: source.raw != null && Number.isFinite(Number(source.raw)) ? Number(source.raw) : null };
  return null;
}

function summarizeChannels(state, windowSize = 20) {
  const history = (state.history || []).slice(-windowSize);
  return Object.fromEntries(CHANNELS.map(id => {
    const readings = history.map(sample => ({ reading: channelOf(sample, id), sample })).filter(x => x.reading);
    const recent = readings.slice(-20);
    const latest = channelOf(state.latest || history.at(-1), id);
    const rawValues = recent.map(x => x.reading.raw).filter(Number.isFinite);
    const indexValues = recent.map(x => x.reading.index);
    const rail = latest?.raw != null && (latest.raw <= 8 || latest.raw >= 4087);
    const rawStuck = rawValues.length >= 20 && new Set(rawValues.slice(-20)).size === 1;
    const indexStuck = rawValues.length < 20 && indexValues.length >= 20 && new Set(indexValues.slice(-20)).size === 1;
    const outsideRange = latest && (latest.index < 0 || latest.index > 4);
    const faults = [];
    if (!latest) faults.push('missing_channel');
    if (rail) faults.push('adc_rail');
    if (rawStuck || indexStuck) faults.push('stuck_reading');
    if (outsideRange) faults.push('response_out_of_range');
    const average = xs => xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : null;
    return [id, { available: Boolean(latest), latestIndex: latest?.index ?? null, latestRaw: latest?.raw ?? null, samples: readings.length, meanIndex: +((average(indexValues) ?? 0).toFixed(3)), adcRail: rail, stuck: rawStuck || indexStuck, faults }];
  }));
}

function inspectTelemetry(state, now = Date.now()) {
  const latest = state.latest || {};
  const ageMs = latest.timestamp ? Math.max(0, now - latest.timestamp) : null;
  return { fresh: ageMs != null && ageMs < 5000, ageMs, count: (state.history || []).length, source: latest.source || 'unknown' };
}

function assessSensorHealth(state) {
  const channels = summarizeChannels(state);
  const faults = Object.entries(channels).flatMap(([channel, result]) => result.faults.map(code => ({ channel, code })));
  return { healthy: faults.length === 0 && Object.values(channels).every(x => x.available), channels, faults };
}

function compareChannels(state) {
  const history = (state.history || []).slice(-5);
  const means = Object.fromEntries(CHANNELS.map(id => {
    const values = history.map(sample => channelOf(sample, id)?.index).filter(Number.isFinite);
    return [id, values.length ? +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3) : null];
  }));
  const enough = Object.values(means).every(Number.isFinite);
  const difference = enough ? +(Math.abs(means.a - means.b)).toFixed(3) : null;
  const wider = (state.history || []).slice(-20);
  const differences = wider.map(sample => { const a = channelOf(sample, 'a')?.index, b = channelOf(sample, 'b')?.index; return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : null; }).filter(Number.isFinite);
  const maxDifference = differences.length ? +Math.max(...differences).toFixed(3) : null;
  return { available: enough, meanIndexA: means.a, meanIndexB: means.b, differenceIndex: difference, maxRecentDifferenceIndex: maxDifference, disagreementDetected: enough && (difference > 0.55 || maxDifference > 0.9), agrees: enough && difference <= 0.55 && maxDifference <= 0.9, windowSamples: history.length };
}

function assessEnvironment(state) {
  const latest = state.latest || {};
  const temperatureC = Number.isFinite(latest.temperature) ? latest.temperature : null;
  const humidityPct = Number.isFinite(latest.humidity) ? latest.humidity : null;
  const available = temperatureC != null && humidityPct != null;
  return { available, temperatureC, humidityPct, plausible: available && temperatureC >= -40 && temperatureC <= 85 && humidityPct >= 0 && humidityPct <= 100 };
}

function compareBaseline(state) {
  const channels = summarizeChannels(state, 12);
  return { baselineReference: 'per-sensor startup baseline (index 1.0)', channels: Object.fromEntries(CHANNELS.map(id => [id, { baselineIndex: 1, recentMeanIndex: channels[id].meanIndex, riseIndex: +(channels[id].meanIndex - 1).toFixed(3) }])) };
}

function estimateDrift(state) {
  const history = (state.history || []).slice(-30);
  const results = {};
  for (const id of CHANNELS) {
    const values = history.map(sample => channelOf(sample, id)?.index).filter(Number.isFinite);
    const shift = values.length > 1 ? values.at(-1) - values[0] : 0;
    const steps = values.slice(1).map((x, i) => Math.abs(x - values[i]));
    const largestStep = steps.length ? Math.max(...steps) : 0;
    const largestStepShare = Math.abs(shift) > 0 ? largestStep / Math.abs(shift) : 0;
    const pattern = largestStepShare > 0.35 ? 'abrupt_change' : Math.abs(shift) > 0.12 ? 'gradual_shift' : 'stable_or_small_change';
    results[id] = { shiftIndex: +shift.toFixed(3), largestStepIndex: +largestStep.toFixed(3), largestStepShare: +largestStepShare.toFixed(3), pattern, samples: values.length };
  }
  const samePattern = results.a.pattern === results.b.pattern;
  return { channels: results, jointPattern: samePattern ? results.a.pattern : 'channel_patterns_differ' };
}

function classifyResponse(state) {
  const health = assessSensorHealth(state);
  const agreement = compareChannels(state);
  const baseline = compareBaseline(state);
  const drift = estimateDrift(state);
  let classification = 'uncertain';
  let reason = 'Need two healthy sensor channels and enough recent samples to distinguish a shared response from a channel problem.';
  if (health.faults.length) {
    classification = 'sensor_fault';
    reason = 'At least one sensor channel has a missing, rail, stuck, or out-of-range signal indicator.';
  } else if (!agreement.available) {
    classification = 'insufficient_data';
    reason = 'Both sensor channels need recent valid readings.';
  } else if (!agreement.agrees) {
    classification = 'uncertain_channel_disagreement';
    reason = 'The channels differ beyond the prototype agreement bound; this could be a sensor issue or a real spatial gradient.';
  } else if (baseline.channels.a.recentMeanIndex >= 1.8 && baseline.channels.b.recentMeanIndex >= 1.8) {
    classification = 'shared_response_anomaly';
    reason = 'Both healthy channels show a persistent response above their startup baselines.';
  } else if (drift.jointPattern === 'gradual_shift') {
    classification = 'gradual_response_change';
    reason = 'Both channels show a gradual change; source is not identified by this prototype.';
  } else if (baseline.channels.a.recentMeanIndex < 1.8 && baseline.channels.b.recentMeanIndex < 1.8) {
    classification = 'no_threshold_anomaly';
    reason = 'Both channels are healthy and below the demonstration response threshold.';
  }
  return { classification, reason, channelsHealthy: health.healthy, agreement, baseline, drift, sensorHealth: health.channels, confidence: classification.startsWith('uncertain') || classification === 'insufficient_data' ? 'low' : 'rule-based prototype label' };
}

function analyzeState(state, now = Date.now()) {
  return { telemetry: inspectTelemetry(state, now), environment: assessEnvironment(state), classification: classifyResponse(state) };
}

module.exports = { CHANNELS, channelOf, inspectTelemetry, assessEnvironment, assessSensorHealth, compareChannels, compareBaseline, estimateDrift, classifyResponse, analyzeState };
