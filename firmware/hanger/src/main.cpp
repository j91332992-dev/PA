#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Wire.h>
#include <Preferences.h>
#include <Adafruit_PN532.h>
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif
#include "protocol.h"
constexpr uint8_t PIN_SDA=D4,PIN_SCL=D5,PIN_LED=D1,PN532_IRQ=D2,PN532_RESET=D3;
constexpr uint32_t LED_SAFETY_TIMEOUT_MS=sw::LED_SAFETY_TIMEOUT_MS; // 5분 기본 안전 타임아웃
Adafruit_PN532 nfc(PN532_IRQ,PN532_RESET,&Wire);Preferences prefs;String hanger;uint32_t sequence=0,bootId=0,lastHeartbeat=0,lastScan=0,lastBeacon=0,ledUntil=0;uint8_t channel=1,presentCount=0,emptyCount=0,uidChangeCount=0,currentUid[7]{},currentLen=0,candidateUid[7]{},candidateLen=0;sw::State state=sw::State::EMPTY;bool nfcReady=false;
void led(bool on){digitalWrite(PIN_LED,LED_ACTIVE_HIGH?(on?HIGH:LOW):(on?LOW:HIGH));}
void setChannel(uint8_t ch){esp_wifi_set_promiscuous(true);esp_wifi_set_channel(ch,WIFI_SECOND_CHAN_NONE);esp_wifi_set_promiscuous(false);channel=ch;}
void addBroadcast(){esp_now_peer_info_t p{};memcpy(p.peer_addr,sw::BROADCAST,6);p.channel=0;p.ifidx=WIFI_IF_STA;p.encrypt=false;if(!esp_now_is_peer_exist(sw::BROADCAST))esp_now_add_peer(&p);}
void fill(sw::Packet&p,sw::Type type){p.type=type;strlcpy(p.hangerId,hanger.c_str(),sizeof p.hangerId);p.state=state;p.uidLength=currentLen;memcpy(p.uid,currentUid,currentLen);p.sequence=++sequence;p.bootId=bootId;p.errorFlags=nfcReady?0:1;strlcpy(p.firmware,"1.0.0",sizeof p.firmware);}
bool send(sw::Packet&p){sw::seal(p);return esp_now_send(sw::BROADCAST,reinterpret_cast<uint8_t*>(&p),sizeof p)==ESP_OK;}
void report(bool event){sw::Packet p;fill(p,event?sw::Type::EVENT:sw::Type::STATUS);for(uint8_t i=0;i<(event?3:1);i++){send(p);if(event)delay(18+esp_random()%70);}Serial.printf("[ESPNOW] %s state=%u seq=%lu ch=%u\n",event?"EVENT":"HEARTBEAT",unsigned(state),sequence,channel);}
void transition(sw::State s){if(s==state)return;state=s;Serial.printf("[STATE] %u\n",unsigned(state));report(true);}
void ack(const sw::Packet&cmd){sw::Packet a;fill(a,sw::Type::ACK);strlcpy(a.gatewayId,cmd.gatewayId,sizeof a.gatewayId);a.commandId=cmd.commandId;send(a);}
void receive(const uint8_t*,const uint8_t*data,int len){if(len!=sizeof(sw::Packet))return;sw::Packet p;memcpy(&p,data,sizeof p);if(!sw::valid(p))return;if(p.type==sw::Type::BEACON){lastBeacon=millis();prefs.putUChar("channel",channel);return;}if(p.type==sw::Type::COMMAND&&sw::target(p,hanger.c_str())){Serial.printf("[COMMAND] %lu cmd=%u\n",p.commandId,(unsigned)p.command);if(p.command==sw::Command::LED_OFF){ledUntil=0;}else if(p.command==sw::Command::LED_BLINK){ledUntil=p.durationMs==0?(millis()+LED_SAFETY_TIMEOUT_MS):(millis()+p.durationMs);}ack(p);}}
bool same(const uint8_t*a,uint8_t al,const uint8_t*b,uint8_t bl){return al==bl&&memcmp(a,b,al)==0;}
void scanNfc(){uint8_t u[7],len=0;bool found=nfcReady&&nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A,u,&len,35);if(found&&len<=7){emptyCount=0;if(same(u,len,currentUid,currentLen)){presentCount=min<uint8_t>(presentCount+1,255);if(presentCount>=NFC_PRESENT_CONFIRM_COUNT)transition(sw::State::PRESENT);}else if(same(u,len,candidateUid,candidateLen)){if(++uidChangeCount>=NFC_UID_CHANGE_CONFIRM_COUNT){memcpy(currentUid,u,len);currentLen=len;presentCount=NFC_PRESENT_CONFIRM_COUNT;uidChangeCount=0;transition(sw::State::PRESENT);}}else{memcpy(candidateUid,u,len);candidateLen=len;uidChangeCount=1;}}else{presentCount=0;uidChangeCount=0;if(++emptyCount>=NFC_EMPTY_CONFIRM_COUNT){currentLen=0;memset(currentUid,0,7);transition(sw::State::EMPTY);}}}
void recoverChannel(){if(millis()-lastBeacon<15000)return;static uint32_t changed=0;if(millis()-changed<CHANNEL_DWELL_MS)return;changed=millis();channel=channel>=13?1:channel+1;setChannel(channel);Serial.printf("[CHANNEL] sweep %u\n",channel);}
void setup(){Serial.begin(115200);delay(400);pinMode(PIN_LED,OUTPUT);led(false);uint64_t mac=ESP.getEfuseMac();char id[16];snprintf(id,sizeof id,"HC-%06llX",mac&0xffffff);hanger=id;bootId=esp_random();prefs.begin("wardrobe",false);channel=prefs.getUChar("channel",1);Wire.begin(PIN_SDA,PIN_SCL);Wire.setClock(100000);nfc.begin();uint32_t version=nfc.getFirmwareVersion();nfcReady=version!=0;if(nfcReady){nfc.SAMConfig();nfc.setPassiveActivationRetries(0x01);}Serial.printf("[NFC] %s version=%08lx\n",nfcReady?"READY":"FAILED",version);WiFi.mode(WIFI_STA);WiFi.disconnect();setChannel(channel);if(esp_now_init()!=ESP_OK){Serial.println("[ERROR] ESP-NOW init");delay(2000);ESP.restart();}esp_now_register_recv_cb(receive);addBroadcast();Serial.printf("[BOOT] %s channel=%u\n",hanger.c_str(),channel);report(true);}
void loop(){uint32_t t=millis();led(t<ledUntil);if(t-lastScan>=NFC_SCAN_INTERVAL_MS+(bootId%73)){lastScan=t;scanNfc();}if(t-lastHeartbeat>=HEARTBEAT_MIN_MS+(bootId%HEARTBEAT_JITTER_MS)){lastHeartbeat=t;report(false);}recoverChannel();delay(4);}
