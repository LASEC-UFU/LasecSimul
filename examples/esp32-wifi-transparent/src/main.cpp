// Baseline do Wi-Fi transparente da ESP32 simulada pelo LasecSimul.
//
// SSID e senha sao deliberadamente inexistentes: no QEMU o WiFi.begin() apenas
// dispara a conexao do enlace virtual. Cada etapa imprime uma linha "[wifi-e2e]"
// que os testes automatizados procuram no UART0.
#include <Arduino.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <ArduinoOTA.h>

static WebServer server(80);
static WiFiUDP udp;

static void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info)
{
    switch (event) {
    case ARDUINO_EVENT_WIFI_STA_START:
        Serial.println("[wifi-e2e] event=STA_START");
        break;
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
        Serial.println("[wifi-e2e] event=STA_CONNECTED");
        break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
        Serial.printf("[wifi-e2e] event=STA_DISCONNECTED reason=%u\n",
                      info.wifi_sta_disconnected.reason);
        break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
        Serial.printf("[wifi-e2e] event=STA_GOT_IP ip=%s\n",
                      IPAddress(info.got_ip.ip_info.ip.addr).toString().c_str());
        break;
    default:
        break;
    }
}

static void httpGet(const char *url)
{
    HTTPClient http;
    if (!http.begin(url)) {
        Serial.printf("[wifi-e2e] http url=%s begin=fail\n", url);
        return;
    }
    const int code = http.GET();
    Serial.printf("[wifi-e2e] http url=%s code=%d\n", url, code);
    http.end();
}

static void httpsGet(const char *host)
{
    NetworkClientSecure client;
    client.setInsecure();
    if (!client.connect(host, 443)) {
        Serial.printf("[wifi-e2e] https host=%s connect=fail\n", host);
        return;
    }
    client.printf("HEAD / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host);
    const String status = client.readStringUntil('\n');
    Serial.printf("[wifi-e2e] https host=%s status=%s\n", host, status.c_str());
    client.stop();
}

void setup()
{
    Serial.begin(115200);
    Serial.println("[wifi-e2e] boot");
    WiFi.onEvent(onWiFiEvent);

    WiFi.begin("ssid-que-nao-existe", "senha-que-nao-existe");
    const uint32_t started = millis();
    while (WiFi.status() != WL_CONNECTED) {
        delay(100);
        if (millis() - started > 60000) {
            Serial.printf("[wifi-e2e] connect=timeout status=%d\n", WiFi.status());
            break;
        }
    }
    if (WiFi.status() != WL_CONNECTED) {
        return;
    }

    Serial.printf("[wifi-e2e] connected ip=%s gw=%s dns=%s mac=%s\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.gatewayIP().toString().c_str(),
                  WiFi.dnsIP().toString().c_str(),
                  WiFi.macAddress().c_str());

    IPAddress resolved;
    if (WiFi.hostByName("example.com", resolved)) {
        Serial.printf("[wifi-e2e] dns example.com=%s\n", resolved.toString().c_str());
    } else {
        Serial.println("[wifi-e2e] dns example.com=fail");
    }
    httpGet("http://example.com/");
    httpsGet("example.com");

    server.on("/", []() { server.send(200, "text/plain", "lasecsimul-wifi-ok\n"); });
    server.begin();
    Serial.println("[wifi-e2e] webserver port=80");

    udp.begin(4210);
    Serial.println("[wifi-e2e] udp port=4210");

    if (MDNS.begin("lasecsimul-esp32")) {
        MDNS.addService("http", "tcp", 80);
        Serial.println("[wifi-e2e] mdns host=lasecsimul-esp32.local");
    }

    ArduinoOTA.setHostname("lasecsimul-esp32");
    ArduinoOTA.setMdnsEnabled(false);
    ArduinoOTA.begin();
    Serial.println("[wifi-e2e] ota port=3232");
    Serial.println("[wifi-e2e] ready");
}

void loop()
{
    server.handleClient();
    ArduinoOTA.handle();

    const int size = udp.parsePacket();
    if (size > 0) {
        char buffer[128];
        const int length = udp.read(buffer, sizeof(buffer) - 1);
        buffer[length > 0 ? length : 0] = 0;
        udp.beginPacket(udp.remoteIP(), udp.remotePort());
        udp.printf("echo:%s", buffer);
        udp.endPacket();
        Serial.printf("[wifi-e2e] udp echo from=%s len=%d\n",
                      udp.remoteIP().toString().c_str(), length);
    }
    delay(2);
}
