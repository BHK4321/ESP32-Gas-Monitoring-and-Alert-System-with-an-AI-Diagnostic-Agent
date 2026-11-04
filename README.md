# Local Gas Monitor + Diagnostic Agent

A gas-monitoring research prototype with a local dashboard, dual-channel diagnostics, a built-in simulator, and an ESP32 telemetry mode. Agent investigations use Ollama Cloud, so the computer needs internet access and an Ollama API key. Sensor readings and recent history are sent to Ollama Cloud only when **Investigate** is selected. The dashboard and simulation remain on your computer.

## Start the simulation

Install Node.js 20 or later. Create an API key in your Ollama account settings, copy `.env.example` to `.env`, and put the key in `OLLAMA_API_KEY` in `.env`. The app loads `.env` when it starts. `.env` is ignored by Git; do not share or commit it.

```powershell
npm start
```

You can edit `OLLAMA_MODEL` in `.env` if you want a different Ollama Cloud model. Restart the server after changing `.env`. Existing environment variables take precedence over values in `.env`.

Open `http://localhost:8765`. Simulation mode binds to the laptop only. Use **Normal**, **Gas response**, **Sensor drift**, and **Signal fault** to generate demonstration cases, then select **Investigate**. For the drift demo, let the stream run for about 15–20 seconds first. Ollama receives normalized paired readings and recent history and may call read-only diagnostic tools; the dashboard shows its tool trace and final explanation. The app does not silently replace an unavailable model with a different agent. Run `npm test` for the included component checks and `npm run benchmark` to regenerate the synthetic classifier metrics.

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

The agent calls Ollama Cloud at `https://ollama.com/api/chat` with tool calling. Its allowlist contains only read-only tools for telemetry freshness, sensor health, channel comparison, response classification, and drift estimation. It has no actuator tool. The model is `gpt-oss:120b` by default; `OLLAMA_MODEL` can select another Ollama Cloud model that supports tool calling. `OLLAMA_URL` can override the API endpoint for development. The LLM explains diagnostics; deterministic rules classify the sensor patterns. This is not a trained gas classifier.

## Safety and limits

This is a bench/research prototype, not a certified gas detector. Do not use it to protect people/property or to control ventilation, valves, mains, or safety equipment. MQ-series sensors need warm-up and proper calibration, are cross-sensitive, and do not by themselves provide reliable ppm readings. The example threshold and baseline ratio are demonstration values. Do not expose the sensor to released fuel or flammable vapor; use an approved calibration setup under qualified supervision for gas-response experiments. Check the exact ESP32 board and sensor-module analog output: ESP32 GPIO/ADC pins are not 5 V tolerant.

Ollama Cloud processes the prompt and readings to return the requested response; review Ollama's current privacy and account terms before sending any real deployment data. Keep the API key private and out of browser code, source control, screenshots, and shared logs.

## Project layout

- `server.js` — local dashboard server, simulator, and ESP32 telemetry receiver.
- `src/agent.js` — Ollama chat/tool loop and read-only diagnostic tools.
- `web/` — local live dashboard.
- `firmware/esp32_local_gas/` — self-contained Arduino firmware and example credentials.
- `test/` — agent behavior checks.
- `PROGRESS_REPORT.md` — component status and measured software test results.
- `reports/benchmark-latest.json` — seeded, synthetic classifier benchmark output (not real gas detection accuracy).
