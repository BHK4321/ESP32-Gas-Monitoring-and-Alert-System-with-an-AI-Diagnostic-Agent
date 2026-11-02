/* Local bench demonstrator only. Not a certified gas alarm.
   The ESP32's local LED/buzzer logic is independent of Wi-Fi and agent.
   Confirm pinout, sensor supply, and ADC voltage before wiring. GPIO ADC is
   not 5-V tolerant; many MQ modules are powered at 5 V. Use a suitable divider.
*/
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "credentials.h"

constexpr int SENSOR_PIN = 34;       // Example ADC1 pin for classic ESP32; confirm board
constexpr int LED_PIN = 2;           // Example only; board dependent
constexpr int BUZZER_DRIVER_PIN = 25; // Use a transistor/driver, not GPIO for buzzer load
constexpr uint32_t SAMPLE_MS = 250;
constexpr uint32_t BASELINE_MS = 60000;
constexpr uint32_t TELEMETRY_MS = 2000;
constexpr float TRIP_RATIO = 1.80f;  // Demo placeholder; characterize/calibrate first
constexpr float CLEAR_RATIO = 1.35f;
constexpr uint8_t TRIP_COUNT = 3, CLEAR_COUNT = 8;

float baseline = 0;
bool alarmOn = false;
uint8_t highCount = 0, lowCount = 0;
uint32_t lastSample = 0, bootAt = 0;
volatile int rawValue = 0;
volatile float latestIndex = 0;
volatile bool latestAlarm = false;

void outputs(bool on) { digitalWrite(LED_PIN, on ? HIGH : LOW); digitalWrite(BUZZER_DRIVER_PIN, on ? HIGH : LOW); }
void telemetryTask(void*) {
  for (;;) {
    if (WiFi.status() == WL_CONNECTED) {
      const int raw = rawValue;
      const float index = latestIndex;
      const bool alarm = latestAlarm;
      HTTPClient http;
      String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/api/telemetry";
      http.setTimeout(500);
      if (http.begin(url)) {
        http.addHeader("Content-Type", "application/json");
        char body[160];
        snprintf(body, sizeof(body), "{\"sensor_raw\":%d,\"gas_index\":%.4f,\"alarm\":%s}", raw, index, alarm ? "true" : "false");
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
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  xTaskCreatePinnedToCore(telemetryTask, "telemetry", 6144, nullptr, 1, nullptr, 0);
  Serial.println("Local gas monitor starting; collecting clean-air demo baseline.");
}

void loop() {
  const uint32_t now = millis();
  if (now - lastSample < SAMPLE_MS) return;
  lastSample = now;
  rawValue = analogRead(SENSOR_PIN);
  if (now - bootAt < BASELINE_MS) {
    baseline += (rawValue - baseline) / max(1.0f, float((now - bootAt) / SAMPLE_MS + 1));
    Serial.printf("baseline,raw=%d\n", rawValue);
    return;
  }
  const float index = baseline > 1 ? float(rawValue) / baseline : 0;
  latestIndex = index;
  if (!alarmOn) {
    lowCount = 0;
    if (index >= TRIP_RATIO) { if (++highCount >= TRIP_COUNT) { alarmOn = true; outputs(true); Serial.println("LOCAL_ALARM,TRIP"); } }
    else highCount = 0;
  } else {
    highCount = 0;
    if (index <= CLEAR_RATIO) { if (++lowCount >= CLEAR_COUNT) { alarmOn = false; outputs(false); Serial.println("LOCAL_ALARM,CLEAR"); } }
    else lowCount = 0;
  }
  latestAlarm = alarmOn;
  Serial.printf("sample,raw=%d,index=%.3f,alarm=%d,wifi=%d\n", rawValue, index, alarmOn, WiFi.status() == WL_CONNECTED);
}
