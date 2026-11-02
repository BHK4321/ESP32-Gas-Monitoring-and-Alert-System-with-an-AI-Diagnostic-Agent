# Local Gas Monitor + Diagnostic Agent

A local-only gas-monitoring research prototype. The dashboard and Ollama-powered diagnostic agent run on your computer. No cloud account or API key is needed. The selected Ollama model must be downloaded once. The prototype supports a built-in simulator and an ESP32 telemetry mode over your local Wi-Fi.

## Start the simulation

Install Node.js 20 or later and Ollama. The default model is `qwen2.5:1.5b`; if it is not installed, download it once with `ollama pull qwen2.5:1.5b`. Then open this folder in a terminal and run:

```powershell
npm start
```

Open `http://localhost:8765`. Simulation mode binds to the laptop only. Use **Normal**, **Gas response**, **Sensor drift**, and **Signal fault** to generate repeatable demonstration cases, then select **Investigate**. For the drift demo, let the stream run for about 15–20 seconds before investigating. Ollama receives normalized readings and may call the read-only diagnostic tools; the dashboard shows its tool trace and final explanation. If Ollama or its model is unavailable, the app reports an error and does not switch to rule-based agent output. Run `npm test` for the included component checks.

## Start ESP32 telemetry mode

1. Connect the ESP32 and laptop to the same local Wi-Fi. The local server binds to the network interface so the board can reach it; it does not need internet access.
2. Copy `firmware/esp32_local_gas/credentials.example.h` to `credentials.h` and enter your Wi-Fi name, password, and the laptop's LAN IP address. Keep this file private.
3. Open `firmware/esp32_local_gas/esp32_local_gas.ino` in Arduino IDE, install/select the ESP32 Arduino core, verify pin assignments and the sensor board's electrical limits, then upload.
4. Start the server in hardware mode:

```powershell
$env:MODE='hardware'; npm start
```

The firmware posts normalized sensor response and raw ADC values to `http://<laptop-ip>:8765/api/telemetry`. Hardware mode binds the server to the local network so the ESP32 can reach it. The demo endpoint has no authentication or encryption; use it only on a trusted private LAN. Open `http://localhost:8765` on the laptop and select **Investigate**. In hardware mode the UI scenario buttons are disabled.

The firmware keeps its local indicator alarm independent of Wi-Fi and the laptop. Agent output is diagnostic advice only; it cannot switch a relay or other actuator. The example output is an LED and buzzer-driver signal for bench demonstration.

## What the agent does

The agent uses Ollama's local `/api/chat` endpoint with tool calling. Its allowlist contains only read-only tools for telemetry freshness, signal quality, baseline comparison, and drift estimation. It has no actuator tool. Ollama runs on the laptop, not on the ESP32; after the model is downloaded, inference and telemetry can remain local/offline. It is not a trained gas classifier.

## Safety and limits

This is a bench/research prototype, not a certified gas detector. Do not use it to protect people/property or to control ventilation, valves, mains, or safety equipment. MQ-series sensors need warm-up and proper calibration, are cross-sensitive, and do not by themselves provide reliable ppm readings. The example threshold and baseline ratio are demonstration values. Do not expose the sensor to released fuel or flammable vapor; use an approved calibration setup under qualified supervision for gas-response experiments. Check the exact ESP32 board and sensor-module analog output: ESP32 GPIO/ADC pins are not 5 V tolerant.

## Project layout

- `server.js` — local dashboard server, simulator, and ESP32 telemetry receiver.
- `src/agent.js` — Ollama chat/tool loop and read-only diagnostic tools.
- `web/` — local live dashboard.
- `firmware/esp32_local_gas/` — self-contained Arduino firmware and example credentials.
- `test/` — agent behavior checks.
- `PROGRESS_REPORT.md` — component status and measured software test results.
