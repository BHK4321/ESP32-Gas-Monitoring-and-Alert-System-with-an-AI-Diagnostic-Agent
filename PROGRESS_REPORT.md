# Project Progress Report — Local Gas Monitor + Diagnostic Agent

**Report date:** 2 November 2026  
**Build target:** Local laptop dashboard + ESP32 telemetry over local Wi-Fi  
**Current stage:** Software prototype complete; physical hardware verification pending

## Project outcome

The folder contains a local-only gas-monitoring prototype. It runs in simulation mode on Node.js and uses the local Ollama API for its diagnostic agent. No external account or API key is needed. The selected Ollama model must be downloaded once. An ESP32 Arduino sketch is included for local indicator control and telemetry to the laptop.

The prototype is not a certified gas detector. Simulation values are normalized demonstration data, not gas concentrations or ppm. The included training-style thresholds are placeholders and have not been calibrated against a physical sensor.

## Component results

| Component | Implemented | Verification result | Remaining work |
|---|---|---|---|
| Local web dashboard | Live status cards, rolling sensor graph, scenario controls, agent findings and tool trace | **HTTP 200**; page title `Local Gas Monitor` verified on localhost | Review visually during the presentation |
| Local simulation | Normal, elevated-response, gradual-drift and unstable-signal scenarios | Gas-response scenario fed the local Ollama investigation; no physical gas was used | Demonstrate the remaining scenarios on the laptop |
| Ollama diagnostic agent | Ollama API chat loop, tool-call processing, evidence trace, model explanation, read-only allowlist and output guard | **7/7 unit checks passed**; installed `qwen2.5:1.5b` made real local tool calls for all four diagnostics and returned a summary in about 11 seconds on the test machine | Benchmark repeated runs and explanation quality |
| Local API/server | Node built-in HTTP server; telemetry, state, scenario and investigation endpoints | Dashboard and scenario endpoints returned successfully; Ollama-backed investigation endpoint tested on localhost | Verify again during the presentation if Ollama is restarted |
| ESP32 firmware | Local baseline ratio, hysteresis, LED/buzzer-driver output, separate telemetry task | Firmware source reviewed; **not compiled or flashed** because the ESP32 board and Arduino toolchain are unavailable here | Confirm board/pins, install ESP32 Arduino core, compile, then bench-test with low-voltage indicators |
| ESP32-to-laptop telemetry | HTTP JSON POST over LAN; no cloud dependency | Endpoint and payload format implemented; **not physically exercised** | Enter local Wi-Fi and laptop IP in private `credentials.h`, then test on the same LAN |
| Progress report | Per-component status and test evidence | Created in this folder | Update with hardware test measurements after bench run |

## Automated software test results

Ran `npm test` with Node.js **v26.7.0**:

- **7 tests passed; 0 failed** in the Ollama integration unit run (mock API).
- The live Ollama test used the installed `qwen2.5:1.5b` model on a gas-response simulation; it requested all four tools. On the latest run, the guard withheld the model's unsafe/unsupported wording and showed the ESP32-reported alarm state (ACTIVE). End-to-end investigation took about 15 seconds on the test machine.
- The model once generated unsupported reassurance. The output guard withholds summaries matching unsafe safety/threshold reassurance or actuator-control advice and displays the ESP32-reported alarm state.
- A deterministic diagnostic tool now distinguishes an abrupt step from a gradual response shift; a mock test confirms contradictory Ollama wording is withheld.
- The withheld-output notice now names the matched safeguard and labels simulated alarms as simulator output rather than ESP32 telemetry.
- A mock Ollama API response selects read-only tools; the app returns the model's final explanation and tool trace.
- Requests to operate a relay are rejected by the tool allowlist.
- If the local Ollama API is unavailable, the investigation reports an error instead of switching to a hand-coded agent.

## What is not yet a measured result

- No physical sensor accuracy, gas concentration, detection delay, false-alarm rate, response time, or actuator reliability has been measured.
- The ESP32 sketch has not been compiled, uploaded, or tested with your particular board/sensor/actuator.
- The code's illustrative normalized response is not ppm. Do not report simulated scenarios as real-gas detection results.
- Ollama is the only agent language-model API; the model is not a trained gas classifier. Immediate alarm logic remains local to the ESP32.
- Output filtering catches specific unsafe reassurance and control-advice patterns; it is a prototype safeguard, not a formal safety guarantee.

## Bench demonstration plan

1. Run simulation mode and show each scenario plus the agent's tool trace.
2. After the physical circuit is checked, show clean-air readings and the board's local LED/buzzer behavior using a software-injected test scenario.
3. If real sensor response is to be measured, use a supervised calibration setup and record repeated trials, sensor warm-up, baseline, threshold, trip/clear delay, and false alarms. Do not release fuel or flammable vapor for a demo.
4. Save the raw readings and report actual measurements separately from simulation output.

## Safety and licensing notes

- Use a low-voltage LED and suitable buzzer driver for the bench prototype. Do not connect mains loads, valves, or life-safety equipment.
- The ESP32 ADC is not 5-V tolerant; verify the exact sensor module output and use a suitable interface.
- Hardware mode exposes an unauthenticated HTTP telemetry endpoint on the local network; use only on a trusted private LAN.
- The upstream GitHub repository used as a design reference does not show an explicit license file in its root listing. This project contains an independent implementation and does not copy its source files. Obtain permission or verify licensing before incorporating upstream code.
