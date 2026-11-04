/* Local bench demonstrator only. Not a certified gas alarm.
   Uses two independent analog sensor channels for health/agreement checks.
   Confirm the exact board, sensors, output voltage and pinout before wiring.
   ESP32 ADC pins are not 5-V tolerant; add a suitable divider/interface.
*/
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "credentials.h"

// Optional DHT22: install the Adafruit DHT sensor library and set to 1.
#define ENABLE_DHT22 0
#if ENABLE_DHT22
#include <DHT.h>
constexpr int DHT_PIN = 4;
DHT dht(DHT_PIN, DHT22);
#endif

constexpr int SENSOR_A_PIN = 34;       // ADC1, classic ESP32 example; confirm board
constexpr int SENSOR_B_PIN = 35;       // ADC1, second independent analog sensor
constexpr int LED_PIN = 2;             // Example only; board dependent
constexpr int BUZZER_DRIVER_PIN = 25;  // Use a transistor/driver, not GPIO for buzzer load
constexpr uint32_t SAMPLE_MS = 250;
constexpr uint32_t BASELINE_MS = 60000;
constexpr uint32_t TELEMETRY_MS = 2000;
constexpr float TRIP_RATIO = 1.80f;  // Demonstration setting; calibrate for the actual sensor
constexpr float CLEAR_RATIO = 1.35f;
constexpr uint8_t TRIP_COUNT = 3, CLEAR_COUNT = 8;
constexpr uint8_t STUCK_COUNT_LIMIT = 40;

float baselineA = 0, baselineB = 0;
uint32_t baselineSamples = 0;
bool alarmOn = false, baselineReady = false;
uint8_t highCount = 0, lowCount = 0, stuckCountA = 0, stuckCountB = 0;
uint32_t lastSample = 0, bootAt = 0;
int rawA = 0, rawB = 0, previousRawA = -1, previousRawB = -1;
float indexA = 0, indexB = 0, temperatureC = NAN, humidityPct = NAN;
bool faultA = false, faultB = false;

int averagedRead(int pin) {
  uint32_t total = 0;
  for (int i = 0; i < 8; ++i) { total += analogRead(pin); delayMicroseconds(250); }
  return total / 8;
}

bool adcRail(int value) { return value <= 8 || value >= 4087; }

void updateHealth() {
  if (rawA == previousRawA) { if (stuckCountA < STUCK_COUNT_LIMIT) ++stuckCountA; } else stuckCountA = 0;
  if (rawB == previousRawB) { if (stuckCountB < STUCK_COUNT_LIMIT) ++stuckCountB; } else stuckCountB = 0;
  previousRawA = rawA; previousRawB = rawB;
  faultA = adcRail(rawA) || stuckCountA >= STUCK_COUNT_LIMIT;
  faultB = adcRail(rawB) || stuckCountB >= STUCK_COUNT_LIMIT;
}

void outputs(bool on) { digitalWrite(LED_PIN, on ? HIGH : LOW); digitalWrite(BUZZER_DRIVER_PIN, on ? HIGH : LOW); }

void telemetryTask(void*) {
  for (;;) {
    if (WiFi.status() == WL_CONNECTED && baselineReady) {
      HTTPClient http;
      String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/api/telemetry";
      http.setTimeout(700);
      if (http.begin(url)) {
        http.addHeader("Content-Type", "application/json");
        char body[320];
#if ENABLE_DHT22
        snprintf(body, sizeof(body), "{\"sensor_a_raw\":%d,\"sensor_b_raw\":%d,\"sensor_a_index\":%.4f,\"sensor_b_index\":%.4f,\"temperature\":%.2f,\"humidity\":%.2f,\"alarm\":%s}", rawA, rawB, indexA, indexB, temperatureC, humidityPct, alarmOn ? "true" : "false");
#else
        snprintf(body, sizeof(body), "{\"sensor_a_raw\":%d,\"sensor_b_raw\":%d,\"sensor_a_index\":%.4f,\"sensor_b_index\":%.4f,\"alarm\":%s}", rawA, rawB, indexA, indexB, alarmOn ? "true" : "false");
#endif
        http.POST((uint8_t*)body, strlen(body));
        http.end();
      }
    }
    vTaskDelay(pdMS_TO_TICKS(TELEMETRY_MS));
  }
}

void setup() {
  pinMode(LED_PIN, OUTPUT); pinMode(BUZZER_DRIVER_PIN, OUTPUT); outputs(false);
  Serial.begin(115200); analogReadResolution(12); bootAt = millis();
#if ENABLE_DHT22
  dht.begin();
#endif
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  xTaskCreatePinnedToCore(telemetryTask, "telemetry", 6144, nullptr, 1, nullptr, 0);
  Serial.println("Dual-channel monitor starting; collecting per-channel clean-air baselines.");
}

void loop() {
  const uint32_t now = millis();
  if (now - lastSample < SAMPLE_MS) return;
  lastSample = now;
  rawA = averagedRead(SENSOR_A_PIN); rawB = averagedRead(SENSOR_B_PIN);
  updateHealth();
#if ENABLE_DHT22
  const float t = dht.readTemperature(), h = dht.readHumidity();
  if (isfinite(t)) temperatureC = t;
  if (isfinite(h)) humidityPct = h;
#endif

  if (!baselineReady) {
    if (now - bootAt < BASELINE_MS) {
      if (faultA || faultB) { alarmOn = true; outputs(true); Serial.println("SENSOR_FAULT,DURING_BASELINE"); }
      else {
        ++baselineSamples;
        baselineA += (rawA - baselineA) / float(baselineSamples);
        baselineB += (rawB - baselineB) / float(baselineSamples);
      }
      return;
    }
    baselineReady = baselineA > 8 && baselineA < 4087 && baselineB > 8 && baselineB < 4087;
    if (!baselineReady) { alarmOn = true; outputs(true); Serial.println("SENSOR_FAULT,BASELINE_INVALID"); return; }
    Serial.printf("BASELINE_READY,a=%.1f,b=%.1f\n", baselineA, baselineB);
  }

  indexA = baselineA > 1 ? float(rawA) / baselineA : 0;
  indexB = baselineB > 1 ? float(rawB) / baselineB : 0;
  const bool responseHigh = indexA >= TRIP_RATIO || indexB >= TRIP_RATIO;
  const bool sensorFault = faultA || faultB;
  if (sensorFault) {
    alarmOn = true; highCount = 0; lowCount = 0; outputs(true);
  } else if (!alarmOn) {
    lowCount = 0;
    if (responseHigh || sensorFault) { if (++highCount >= TRIP_COUNT) { alarmOn = true; outputs(true); Serial.println(sensorFault ? "LOCAL_ALARM,SENSOR_FAULT" : "LOCAL_ALARM,RESPONSE_HIGH"); } }
    else highCount = 0;
  } else {
    highCount = 0;
    if (!sensorFault && indexA <= CLEAR_RATIO && indexB <= CLEAR_RATIO) { if (++lowCount >= CLEAR_COUNT) { alarmOn = false; outputs(false); Serial.println("LOCAL_ALARM,CLEAR"); } }
    else lowCount = 0;
  }
  Serial.printf("sample,a_raw=%d,b_raw=%d,a_index=%.3f,b_index=%.3f,fault_a=%d,fault_b=%d,alarm=%d,wifi=%d\n", rawA, rawB, indexA, indexB, faultA, faultB, alarmOn, WiFi.status() == WL_CONNECTED);
}
