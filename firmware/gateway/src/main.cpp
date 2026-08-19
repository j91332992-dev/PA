#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <esp_now.h>
#include <ArduinoJson.h>
#if __has_include("config.h")
#include "config.h"
#else
#error "Copy include/config.example.h to include/config.h and fill the values"
#endif
#include "protocol.h"
String gateway;uint32_t beaconAt=0,cloudAt=0,sequence=0;portMUX_TYPE mux=portMUX_INITIALIZER_UNLOCKED;constexpr uint8_t Q=32;sw::Packet queue[Q];volatile uint8_t qHead=0,qTail=0;
void enqueue(const sw::Packet&p){portENTER_CRITICAL(&mux);uint8_t next=(qHead+1)%Q;if(next!=qTail){queue[qHead]=p;qHead=next;}portEXIT_CRITICAL(&mux);}bool dequeue(sw::Packet&p){bool ok=false;portENTER_CRITICAL(&mux);if(qTail!=qHead){p=queue[qTail];qTail=(qTail+1)%Q;ok=true;}portEXIT_CRITICAL(&mux);return ok;}
void receive(const uint8_t*,const uint8_t*data,int len){if(len!=sizeof(sw::Packet))return;sw::Packet p;memcpy(&p,data,sizeof p);if(sw::valid(p))enqueue(p);}
void addBroadcast(){esp_now_peer_info_t p{};memcpy(p.peer_addr,sw::BROADCAST,6);p.channel=0;p.ifidx=WIFI_IF_STA;if(!esp_now_is_peer_exist(sw::BROADCAST))esp_now_add_peer(&p);}bool send(sw::Packet&p){sw::seal(p);return esp_now_send(sw::BROADCAST,reinterpret_cast<uint8_t*>(&p),sizeof p)==ESP_OK;}
bool request(const String&path,const char*method,const String&payload,String&response){if(WiFi.status()!=WL_CONNECTED)return false;HTTPClient http;String url=String(CLOUD_BASE_URL)+path;http.begin(url);http.addHeader("Authorization",String("Bearer ")+DEVICE_TOKEN);http.addHeader("Content-Type","application/json");http.addHeader("X-Gateway-Id",gateway);int code=!strcmp(method,"GET")?http.GET():http.POST(payload);if(code>0)response=http.getString();http.end();return code>=200&&code<300;}
String stateName(sw::State s){switch(s){case sw::State::PRESENT:return"PRESENT";case sw::State::UNSTABLE:return"UNSTABLE";case sw::State::UNKNOWN_TAG:return"UNKNOWN_TAG";default:return"EMPTY";}}
String uidHex(const sw::Packet&p){String s;for(uint8_t i=0;i<p.uidLength;i++){char b[3];snprintf(b,3,"%02X",p.uid[i]);s+=b;}return s;}
void upload(const sw::Packet&p){JsonDocument d;d["gatewayId"]=gateway;d["hangerId"]=p.hangerId;d["state"]=stateName(p.state);d["tagUid"]=uidHex(p);d["sequence"]=p.sequence;d["bootId"]=p.bootId;d["channel"]=WiFi.channel();d["firmwareVersion"]=p.firmware;d["gatewayFirmwareVersion"]="1.0.0";d["errorFlags"]=p.errorFlags;String body,out;serializeJson(d,body);if(request("/api/gateway/status","POST",body,out))Serial.printf("[CLOUD] %s OK\n",p.hangerId);else{Serial.printf("[CLOUD] %s FAIL\n",p.hangerId);enqueue(p);delay(80);}}
void ack(const sw::Packet&p){JsonDocument d;d["commandId"]=p.commandId;d["hangerId"]=p.hangerId;d["result"]="OK";d["errorCode"]=p.errorFlags;String body,out;serializeJson(d,body);request("/api/gateway/ack","POST",body,out);}
void fetchCommands(){String out;if(!request("/api/gateway/commands","GET","",out))return;JsonDocument doc;if(deserializeJson(doc,out))return;for(JsonObject c:doc["commands"].as<JsonArray>()){sw::Packet p;p.type=sw::Type::COMMAND;strlcpy(p.gatewayId,gateway.c_str(),sizeof p.gatewayId);p.sequence=++sequence;p.commandId=c["numericId"]|0;const char*cmdStr=c["command"]|"LED_BLINK";if(strcmp(cmdStr,"LED_OFF")==0){p.command=sw::Command::LED_OFF;p.durationMs=0;}else{p.command=sw::Command::LED_BLINK;p.durationMs=c["durationMs"]|0;}JsonArray targets=c["targets"];p.targetCount=min<size_t>(targets.size(),sw::MAX_TARGETS);for(uint8_t i=0;i<p.targetCount;i++)p.targetIds[i]=sw::idCode(targets[i]|"");for(uint8_t i=0;i<3;i++){send(p);delay(25+esp_random()%50);}Serial.printf("[COMMAND] %lu cmd=%u targets=%u\n",p.commandId,(unsigned)p.command,p.targetCount);}}
void beacon(){sw::Packet p;p.type=sw::Type::BEACON;strlcpy(p.gatewayId,gateway.c_str(),sizeof p.gatewayId);p.sequence=++sequence;strlcpy(p.firmware,"1.0.0",sizeof p.firmware);send(p);}
void wifi(){WiFi.mode(WIFI_STA);WiFi.begin(WIFI_SSID,WIFI_PASSWORD);Serial.print("[WIFI] connecting");for(uint8_t i=0;i<40&&WiFi.status()!=WL_CONNECTED;i++){delay(500);Serial.print('.');}Serial.println();if(WiFi.status()!=WL_CONNECTED){Serial.println("[ERROR] Wi-Fi failed; rebooting");delay(3000);ESP.restart();}Serial.printf("[WIFI] IP=%s channel=%d\n",WiFi.localIP().toString().c_str(),WiFi.channel());}
void setup(){Serial.begin(115200);delay(500);uint64_t mac=ESP.getEfuseMac();char id[16];snprintf(id,sizeof id,"GW-%06llX",mac&0xffffff);gateway=id;wifi();if(esp_now_init()!=ESP_OK){Serial.println("[ERROR] ESP-NOW init");ESP.restart();}esp_now_register_recv_cb(receive);addBroadcast();Serial.printf("[BOOT] %s\n",gateway.c_str());beacon();}
void loop(){uint32_t t=millis();if(WiFi.status()!=WL_CONNECTED){WiFi.reconnect();delay(200);}if(t-beaconAt>2000){beaconAt=t;beacon();}sw::Packet p;for(uint8_t i=0;i<6&&dequeue(p);i++){if(p.type==sw::Type::ACK)ack(p);else if(p.type==sw::Type::STATUS||p.type==sw::Type::EVENT)upload(p);}if(t-cloudAt>1500){cloudAt=t;fetchCommands();}delay(10);}
