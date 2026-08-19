#pragma once
#include <Arduino.h>
namespace sw {
constexpr uint8_t VERSION=1,MAX_TARGETS=16;constexpr uint8_t BROADCAST[6]={0xff,0xff,0xff,0xff,0xff,0xff};
enum class Type:uint8_t{BEACON=1,STATUS=2,EVENT=3,COMMAND=4,ACK=5};enum class State:uint8_t{PRESENT=1,EMPTY=2,UNKNOWN_TAG=4,UNSTABLE=5};enum class Command:uint8_t{LED_BLINK=1};
struct __attribute__((packed)) Packet{uint16_t magic=0x5753;uint8_t version=VERSION;Type type=Type::STATUS;char gatewayId[16]{};char hangerId[16]{};State state=State::EMPTY;uint8_t uidLength=0;uint8_t uid[7]{};uint32_t sequence=0;uint32_t bootId=0;uint32_t commandId=0;Command command=Command::LED_BLINK;uint16_t durationMs=0;uint8_t targetCount=0;uint32_t targetIds[MAX_TARGETS]{};uint32_t errorFlags=0;char firmware[12]{};uint32_t checksum=0;};
static_assert(sizeof(Packet)<=250,"ESP-NOW v1 packet limit");
inline uint32_t checksum(const Packet&p){const uint8_t*d=reinterpret_cast<const uint8_t*>(&p);uint32_t h=2166136261u;for(size_t i=0;i<sizeof(Packet)-sizeof(uint32_t);++i)h=(h^d[i])*16777619u;return h;}
inline uint32_t idCode(const char*id){uint32_t value=0;for(const char*p=id;*p;p++)if((*p>='0'&&*p<='9')||(*p>='A'&&*p<='F')||(*p>='a'&&*p<='f'))value=(value<<4)|(*p<='9'?*p-'0':((*p&~32)-'A'+10));return value;} inline bool valid(const Packet&p){return p.magic==0x5753&&p.version==VERSION&&p.checksum==checksum(p);}inline void seal(Packet&p){p.checksum=checksum(p);}inline bool target(const Packet&p,const char*id){uint32_t mine=idCode(id);for(uint8_t i=0;i<p.targetCount&&i<MAX_TARGETS;i++)if(p.targetIds[i]==mine)return true;return false;}
}
