# Project Progress Report — Gas Monitor with Sensor Diagnostics Agent

**Report date:** 3 November 2026  
**Build target:** Local dashboard and simulator, Ollama Cloud diagnostic agent, ESP32 dual-channel firmware template  
**Current stage:** Software prototype and synthetic evaluation complete; cloud credentials and physical hardware verification pending

## What is implemented

- A local Node.js dashboard with live paired-channel graphs, status/evidence cards, scenario controls, and agent tool traces.
- Five simulator scenarios: normal readings, shared elevated response, gradual drift, ADC rail fault, and isolated spike/disagreement.
- A dual-channel diagnostic pipeline that checks stale or missing telemetry, ADC rail values, stuck readings, out-of-range response, channel disagreement, shared response changes, and gradual drift.
- An Ollama Cloud tool-using agent. The LLM must call read-only checks before summarizing the rule-based evidence. There are no actuator tools, and output guards withhold selected unsafe reassurance, control advice, or definitive gas/leak claims.
- ESP32 firmware source for two analog channels, startup baselines, a local indicator alarm with hysteresis, optional DHT22 fields, and periodic telemetry to the local dashboard.
- A reproducible synthetic benchmark that generates a JSON report.

## Measured software results

The benchmark currently runs **800 deterministic synthetic cases**: 100 cases each for normal, shared response, channel disagreement, and gradual change, plus 400 sensor-fault cases split across four fault patterns.

| Metric | Result | Scope |
|---|---:|---|
| Classification accuracy | 100% (800/800) | Synthetic cases generated from the same prototype rule definitions |
| Macro F1 | 1.00 | Five output classes, synthetic cases only |
| Shared-response detection delay | 7 samples median | Injected change; assumes 1-second samples, so about 7 seconds in this benchmark |
| Rule-classifier runtime | p50 0.0227 ms; p95 0.102 ms in the saved run | Local Node.js run; runtime varies by machine and load |
| Automated agent checks | 9 checks passed | `.env` loading, mocked Ollama API, and deterministic software behavior |

The raw case breakdown and confusion matrix are saved in `reports/benchmark-latest.json`. Regenerate them with `npm run benchmark`.

**Interpretation:** The 100% score measures whether the hand-coded rules reproduce the labels used to create these synthetic cases. The generated cases are not independent sensor experiments, and the score is not a gas-detection accuracy claim. The 7-sample value is an injected-pattern detection delay, not physical sensor response time.

## Component status

| Component | Status and evidence | Remaining work |
|---|---|---|
| Dashboard and local server | Implemented; E-drive dashboard and state/metrics endpoints returned HTTP 200 | Review the running dashboard in the browser |
| Paired-sensor diagnosis | Implemented and covered by deterministic synthetic cases and software checks | Validate thresholds and sensor-fault rules against actual sensors and recorded data |
| Ollama Cloud agent | Implemented against `https://ollama.com/api/chat`; loads `OLLAMA_API_KEY` from the ignored `.env`; default model `gpt-oss:120b`, selected for tool calling | **Live request succeeded:** HTTP 200 in 7.91 s on the simulator gas scenario; called all three required read-only tools and reported `shared_response_anomaly` | Repeat with more scenarios; this result is simulated, not physical sensor validation |
| Agent safety boundaries | Read-only tool allowlist, required diagnostic tool calls, summary checks, explicit local-alarm reporting | Review with supervisor; pattern matching is a prototype safeguard, not a formal guarantee |
| ESP32 firmware | Dual-channel template with baseline ratio, local LED/buzzer-driver outputs, fault checks and telemetry | Confirm exact board/sensors/wiring, compile, flash and bench-test; not yet physically tested |
| ESP32-to-dashboard telemetry | HTTP JSON receiver and firmware client implemented | Test on a trusted private LAN with the actual board |

## What has not been measured or verified

- No physical gas sensor readings, calibration curve, gas concentration, detection accuracy, false-alarm rate, or real response time have been measured.
- Firmware has not been compiled or flashed, and no ESP32, analog sensor pair, or actuator was physically tested.
- The live Ollama Cloud run used simulated sensor data only; no physical sensor telemetry was sent or evaluated.
- Normalized response ratios are not ppm and do not identify a gas. The prototype cannot distinguish a real gas exposure from every possible shared sensor/environmental effect.

## Run instructions

Install Node.js 20+. Copy `.env.example` to `.env`, add the Ollama key to `OLLAMA_API_KEY`, then start the app. `.env` is ignored by Git. Restart the server after editing it.

```powershell
npm start
```

Open `http://localhost:8765`; select a simulator scenario and click **Investigate readings**. The dashboard and simulator run locally, while investigation prompts and sensor history are sent to Ollama Cloud. Keep the key out of source files, browser code, screenshots, and source control.

For software verification, run `npm test` and `npm run benchmark`. For hardware mode, see `README.md` and verify the actual pins, analog voltage limits, sensor module, and output driver before wiring. The local ESP32 alarm is independent from the cloud agent and computer connection.

## Safety boundary

This is a research/bench prototype, not a certified gas detector. Do not use it to protect people/property or to control valves, ventilation, mains, or safety equipment. Do not release fuel or flammable vapor for a demonstration. Use a qualified, approved calibration setup for any physical gas-response work.
