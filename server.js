const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { runOllamaAgent } = require('./src/agent');
const { analyzeState } = require('./src/diagnostics');
const { computeMetrics } = require('./src/benchmark');

const PORT = Number(process.env.PORT || 8765);
const WEB = path.join(__dirname, 'web');
const mode = process.env.MODE === 'hardware' ? 'hardware' : 'simulation';
const HOST = process.env.HOST || (mode === 'hardware' ? '0.0.0.0' : '127.0.0.1');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:120b';
const benchmarkMetrics = computeMetrics();
const state = { mode, agentProvider: 'Ollama Cloud', agentModel: OLLAMA_MODEL, scenario: 'normal', startedAt: Date.now(), latest: null, history: [], investigations: [], simTick: 0, baseline: 1.0, simAlarm: false, simHighCount: 0, simLowCount: 0 };

function addSample(sample) {
  const normalized = {
    timestamp: Date.now(), gas: Number(sample.gas), gasRaw: sample.gasRaw == null ? null : Number(sample.gasRaw),
    sensors: sample.sensors || null,
    temperature: sample.temperature == null ? null : Number(sample.temperature), humidity: sample.humidity == null ? null : Number(sample.humidity),
    localAlarm: Boolean(sample.localAlarm), source: sample.source || state.mode,
    quality: sample.quality || 'ok'
  };
  if (!Number.isFinite(normalized.gas)) throw new Error('gas must be a finite normalized response value');
  state.latest = normalized;
  state.history.push(normalized);
  if (state.history.length > 600) state.history.shift();
}

function simulationTick() {
  if (state.mode !== 'simulation') return;
  const t = ++state.simTick;
  const noiseA = (Math.random() - 0.5) * 0.035;
  const noiseB = (Math.random() - 0.5) * 0.035;
  let indexA = 1 + Math.sin(t * 0.27) * 0.018 + noiseA;
  let indexB = 1 + Math.sin(t * 0.27 + 0.04) * 0.018 + noiseB;
  if (state.scenario === 'gas') { indexA = 2.25 + noiseA; indexB = 2.20 + noiseB; }
  if (state.scenario === 'drift') { indexA = Math.min(2.0, 1 + t * 0.018) + noiseA; indexB = Math.min(1.98, 1 + t * 0.017) + noiseB; }
  if (state.scenario === 'fault') { indexA = 4.095; indexB = 1 + noiseB; }
  if (state.scenario === 'spike') { indexA = t % 12 === 0 ? 2.7 : 1 + noiseA; indexB = 1 + noiseB; }
  const rawA = state.scenario === 'fault' ? 4095 : Math.max(0, Math.min(4095, Math.round(indexA * 1000)));
  const rawB = Math.max(0, Math.min(4095, Math.round(indexB * 1000)));
  const gas = (indexA + indexB) / 2;
  const fault = rawA <= 8 || rawA >= 4087;
  if (!state.simAlarm) {
    state.simLowCount = 0;
    if (Math.max(indexA, indexB) >= 1.8 || fault) { if (++state.simHighCount >= 3) state.simAlarm = true; }
    else state.simHighCount = 0;
  } else {
    state.simHighCount = 0;
    if (!fault && indexA <= 1.35 && indexB <= 1.35) { if (++state.simLowCount >= 8) state.simAlarm = false; }
    else state.simLowCount = 0;
  }
  addSample({ gas, gasRaw: rawA, sensors: { a: { raw: rawA, index: indexA }, b: { raw: rawB, index: indexB } }, temperature: 24 + Math.sin(t / 15), humidity: 48 + Math.sin(t / 17) * 2, localAlarm: state.simAlarm, source: 'simulation', quality: state.scenario === 'fault' ? 'fault_injected' : 'ok' });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function readBody(req) { return new Promise((resolve, reject) => { let b = ''; req.on('data', c => { b += c; if (b.length > 16_384) reject(new Error('body too large')); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('invalid JSON')); } }); req.on('error', reject); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }); return res.end(); }
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, { ...state, diagnostics: analyzeState(state), history: state.history.slice(-120) });
    if (url.pathname === '/api/metrics' && req.method === 'GET') return send(res, 200, benchmarkMetrics);
    if (url.pathname === '/api/scenario' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.mode !== 'simulation') return send(res, 409, { error: 'Scenario controls are disabled in hardware mode.' });
      if (!['normal', 'gas', 'drift', 'fault', 'spike'].includes(body.name)) return send(res, 400, { error: 'Unknown scenario.' });
      state.scenario = body.name; state.simTick = 0; state.startedAt = Date.now();
      return send(res, 200, { ok: true, scenario: state.scenario });
    }
    if (url.pathname === '/api/investigate' && req.method === 'POST') {
      if (!state.latest) return send(res, 409, { error: 'Waiting for the first sensor sample.' });
      let investigation;
      try { investigation = await runOllamaAgent(state, { model: OLLAMA_MODEL }); }
      catch (err) { return send(res, 503, { error: err.message, provider: 'Ollama Cloud', model: OLLAMA_MODEL }); }
      state.investigations.unshift(investigation); state.investigations.length = Math.min(20, state.investigations.length);
      return send(res, 200, investigation);
    }
    if (url.pathname === '/api/telemetry' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.mode !== 'hardware') return send(res, 409, { error: 'Start server with MODE=hardware to accept device telemetry.' });
      const indexA = Number(body.sensor_a_index), indexB = Number(body.sensor_b_index);
      const rawA = Number(body.sensor_a_raw), rawB = Number(body.sensor_b_raw);
      if (![indexA, indexB, rawA, rawB].every(Number.isFinite)) return send(res, 400, { error: 'Dual-channel telemetry requires finite sensor_a_index, sensor_b_index, sensor_a_raw and sensor_b_raw values.' });
      addSample({ gas: (indexA + indexB) / 2, gasRaw: rawA, sensors: { a: { raw: rawA, index: indexA }, b: { raw: rawB, index: indexB } }, temperature: body.temperature, humidity: body.humidity, localAlarm: body.alarm, source: 'esp32', quality: 'ok' });
      return send(res, 200, { ok: true, received: state.latest.timestamp });
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      const target = path.join(WEB, file);
      if (!target.startsWith(WEB) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      const ext = path.extname(target);
      const mime = ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      return send(res, 200, fs.readFileSync(target), mime);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (err) { return send(res, 400, { error: err.message }); }
});

if (mode === 'simulation') setInterval(simulationTick, 1000);
server.listen(PORT, HOST, () => console.log(`Local gas monitor (${mode}) on http://localhost:${PORT} (bind ${HOST})`));
