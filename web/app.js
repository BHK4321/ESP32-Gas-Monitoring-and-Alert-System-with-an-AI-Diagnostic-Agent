const $ = selector => document.querySelector(selector);
const canvas = $('#chart');
const ctx = canvas.getContext('2d');
let latestState = null;
let investigationInProgress = false;

const esc = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function channel(sample, id) {
  return sample?.sensors?.[id]?.index ?? (id === 'a' ? sample?.gas : null);
}

function draw(samples) {
  const scale = devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = 230;
  canvas.width = width * scale;
  canvas.height = height * scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);

  for (let i = 0; i < 5; i++) {
    const y = i * height / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.strokeStyle = '#edf1ef';
    ctx.stroke();
  }
  if (samples.length < 2) return;

  const maxValue = Math.max(2.6, ...samples.flatMap(sample => [channel(sample, 'a') || 0, channel(sample, 'b') || 0]));
  for (const [id, color] of [['a', '#328c70'], ['b', '#ca8d36']]) {
    const points = samples.map((sample, i) => ({
      x: i * width / (samples.length - 1),
      y: height - Math.min(maxValue, Math.max(0, channel(sample, id) || 0)) * height / maxValue
    }));
    ctx.beginPath();
    points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

function display(state) {
  latestState = state;
  const sample = state.latest;
  const diagnostics = state.diagnostics;
  if (sample) {
    const a = sample.sensors?.a?.index ?? sample.gas;
    const b = sample.sensors?.b?.index ?? sample.gas;
    $('#gas').textContent = ((a + b) / 2).toFixed(3);
    $('#alarm').textContent = sample.localAlarm ? 'ACTIVE' : 'CLEAR';
    $('#alarm').style.color = sample.localAlarm ? '#bf5149' : '#2b805f';
    $('#environment').textContent = sample.temperature == null ? '—' : `${sample.temperature.toFixed(1)}°C · ${sample.humidity?.toFixed(0) ?? '—'}%`;
    $('#source').textContent = sample.source === 'esp32' ? 'ESP32 online' : 'Simulator';
    $('#updated').textContent = `Updated ${new Date(sample.timestamp).toLocaleTimeString()}`;
    $('#quality').textContent = (sample.quality || 'unknown').toUpperCase();
  }

  $('#mode').textContent = state.mode === 'simulation' ? 'LOCAL SIMULATION' : 'LOCAL HARDWARE';
  $('#agentMode').textContent = `OLLAMA CLOUD · ${state.agentModel || 'MODEL'}`;
  $('#scenario').textContent = (state.scenario || 'normal').toUpperCase();
  $('#scenario').className = `tag ${state.scenario === 'gas' ? 'danger' : state.scenario === 'drift' ? 'warn' : ''}`;
  $('#scenarioNote').textContent = state.mode === 'simulation'
    ? 'Two-channel scenarios are injected for repeatable diagnostic checks.'
    : 'Dual-channel ESP32 telemetry received over local Wi-Fi.';
  $('#scenarioControls').style.display = state.mode === 'simulation' ? 'flex' : 'none';

  if (diagnostics) {
    const finding = diagnostics.classification;
    $('#findingClass').textContent = (finding?.classification || '—').replaceAll('_', ' ');
    $('#sensorHealth').textContent = finding?.channelsHealthy
      ? 'Both channels healthy'
      : finding?.classification === 'sensor_fault' ? 'Fault flagged' : 'Check channels';
    $('#channelDiff').textContent = finding?.agreement?.differenceIndex == null
      ? '—'
      : `${finding.agreement.differenceIndex.toFixed(3)} index`;
    $('#driftPattern').textContent = (finding?.drift?.jointPattern || '—').replaceAll('_', ' ');
    $('#telemetryAge').textContent = diagnostics.telemetry?.ageMs == null
      ? '—'
      : `${(diagnostics.telemetry.ageMs / 1000).toFixed(1)} s`;
  }

  draw(state.history || []);
  if (!investigationInProgress && state.investigations?.length) showFinding(state.investigations[0]);
}

function showFinding(result) {
  const box = $('#finding');
  box.className = 'finding';
  box.setAttribute('aria-busy', 'false');
  box.innerHTML = `<strong>${esc((result.code || 'OLLAMA DIAGNOSIS').replaceAll('_', ' '))} · ${esc(result.confidence || '')}</strong><p>${esc(result.summary)}</p><p class="recommend">${esc((result.recommendations || []).join(' '))}</p>`;
  $('#tools').innerHTML = (result.tools || []).map(tool => `<div class="tool"><b>${esc(tool.tool)}()</b> · ${esc(JSON.stringify(tool.result))}</div>`).join('');
}

function showLoading() {
  const box = $('#finding');
  box.className = 'finding loading';
  box.setAttribute('aria-busy', 'true');
  box.innerHTML = `<div class="loading-state">
    <span class="loading-spinner" aria-hidden="true"></span>
    <div class="loading-copy">
      <strong class="loading-title">Generating diagnosis<span class="loading-ellipsis" aria-hidden="true"></span></strong>
      <p>Ollama Cloud is reviewing the latest readings and sensor history.</p>
      <div class="loading-progress" role="progressbar" aria-label="Generating diagnosis"><span></span></div>
      <div class="loading-caption"><span class="loading-pulse" aria-hidden="true"></span> Checking telemetry · comparing channels · preparing the explanation</div>
      <div class="loading-wait">This may take several seconds.</div>
    </div>
  </div>`;
  $('#tools').replaceChildren();
}

function showError(message) {
  const box = $('#finding');
  box.className = 'finding error-state';
  box.setAttribute('aria-busy', 'false');
  box.textContent = message;
}

async function refresh() {
  try {
    const state = await fetch('/api/state').then(response => response.json());
    display(state);
  } catch {
    $('#mode').textContent = 'SERVER DISCONNECTED';
  }
}

async function loadBenchmark() {
  try {
    const metrics = await fetch('/api/metrics').then(response => response.json());
    $('#benchCases').textContent = metrics.cases;
    $('#benchAccuracy').textContent = `${(metrics.accuracy * 100).toFixed(1)}%`;
    $('#benchF1').textContent = `${(metrics.macroF1 * 100).toFixed(1)}%`;
    $('#benchDelay').textContent = metrics.sharedResponseDetectionDelay.samplesAfterInjectedChangeP50 == null
      ? '—'
      : `${metrics.sharedResponseDetectionDelay.samplesAfterInjectedChangeP50} samples`;
    $('#benchRuntime').textContent = `${metrics.classifierRuntimeMs.p95.toFixed(3)} ms`;
  } catch {}
}

document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', async () => {
  await fetch('/api/scenario', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: button.dataset.scenario })
  });
  document.querySelectorAll('[data-scenario]').forEach(item => item.classList.toggle('active', item === button));
  await refresh();
}));

$('#investigate').addEventListener('click', async () => {
  const button = $('#investigate');
  investigationInProgress = true;
  button.disabled = true;
  button.innerHTML = '<span class="button-spinner" aria-hidden="true"></span> Generating diagnosis…';
  showLoading();

  try {
    const response = await fetch('/api/investigate', { method: 'POST' });
    const result = await response.json();
    if (response.ok) showFinding(result);
    else showError(result.error || 'The diagnostic request could not be completed.');
  } catch {
    showError('Cannot reach the local gas-monitor service.');
  } finally {
    investigationInProgress = false;
    button.disabled = false;
    button.textContent = '✧ Investigate readings';
  }
});

window.addEventListener('resize', () => latestState && draw(latestState.history || []));
refresh();
loadBenchmark();
setInterval(refresh, 1000);
