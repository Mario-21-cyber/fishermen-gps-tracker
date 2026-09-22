/* LilyGO T-SIM A7670G R2 tracker. Verify the physical GPS daughterboard before use. */
#include <Arduino.h>
#include <TinyGPSPlus.h>

// Pin map from LilyGO T-A7670G documentation; GPS is the optional external L76K module.
constexpr int MODEM_RX=27, MODEM_TX=26, MODEM_POWER=4, BOARD_POWERON=12;
constexpr int GPS_RX=22, GPS_TX=21, GPS_WAKE=19;
constexpr int SOS_BTN=32; // SOS push button: PULANG wire -> GPIO32, ITIM -> GND (momentary: pindot=lubog, bitaw=aangat)
constexpr unsigned long SOS_REPEAT_MS=10000; // habang SOS aktibo (hindi pa resolved), muling ipapadala ang SOS kada 10s (dedupe sa server: hindi ito gumagawa ng bagong alert)
constexpr unsigned long SOS_CANCEL_MS=5000; // hawakan ang button ng 5s = manual CANCEL ng SOS (kung hindi ma-resolve sa dashboard)
unsigned int sosSeq=0; // bilang ng SOS trigger: BAGONG pindot = bagong episode = bagong SOS alert sa dashboard
constexpr int BEEP_PIN=33; // BUZZER: signal wire -> GPIO33, GND -> GND (nagbeep habang SOS aktibo)
void beepOnce(unsigned ms){ for(unsigned long t0=millis(); millis()-t0<ms;){ digitalWrite(BEEP_PIN,HIGH); delayMicroseconds(180); digitalWrite(BEEP_PIN,LOW); delayMicroseconds(180);} } // ~2.8kHz beep
const char* DEVICE_ID="AZG-BOAT-001";
const char* APN="internet"; // SMART. Kung hindi mag-data, subukan: "smartlte" o "smartbro"
const char* SERVER_HOST="139.59.118.248"; // serveo edge IP (dig +short <subdomain>) - connect target
constexpr uint16_t SERVER_PORT=80; // port 80: pinapadaan ng carrier network (ang 13682 ay kinakain ng TCP middlebox)
const char* SERVER_HOSTNAME="139.59.118.248"; // Host header - dito nagro-route ang serveo (nagbabago tuwing bagong ssh -R session!)
const char* API_KEY="trk_1bb66ac268770ea40f3e7f8b177e6e72590e71ad9172b645"; // dapat pareho sa TRACKER_API_KEY sa server/server.js (default: tugma na)
HardwareSerial modem(1), gpsSerial(2); TinyGPSPlus gps;
unsigned long lastSend=0, lastGpsPrint=0;
void at(const String& s,unsigned long wait=600){modem.println(s);delay(wait);while(modem.available())Serial.write(modem.read());}
bool modemOk(){modem.println("AT+CPIN?");unsigned long t0=millis();String r="";while(millis()-t0<1200){while(modem.available())r+=(char)modem.read();if(r.indexOf("+CPIN")>=0)return true;}return false;}
bool waitTok(const String& tok,unsigned long ms){unsigned long t0=millis();String r="";while(millis()-t0<ms){while(modem.available()){char c=modem.read();r+=c;Serial.write(c);}if(r.indexOf(tok)>=0)return true;}return false;}
bool modemReady(){pinMode(BOARD_POWERON,OUTPUT);digitalWrite(BOARD_POWERON,HIGH);modem.begin(115200,SERIAL_8N1,MODEM_RX,MODEM_TX);bool alive=false;unsigned long t0=millis();while(millis()-t0<20000&&!(alive=modemOk())){}Serial.println(alive?"[MODEM] responsive (auto-boot OK)":"[MODEM] silent 20s; pulsing power...");if(!alive){pinMode(MODEM_POWER,OUTPUT);digitalWrite(MODEM_POWER,HIGH);delay(1200);digitalWrite(MODEM_POWER,LOW);t0=millis();while(millis()-t0<25000&&!(alive=modemOk())){};}Serial.println(alive?"[MODEM] responsive after pulse":"[MODEM] STILL SILENT - hindi gumising ang modem");at("ATE0");at("AT+CPIN?");at("AT+CGDCONT=1,\"IP\",\""+String(APN)+"\"");at("AT+CGATT=1",3000);at("AT+CGATT?",1000);return true;}
bool cipOpen(){modem.println("AT+CIPOPEN=0,\"TCP\",\""+String(SERVER_HOST)+"\","+String(SERVER_PORT));unsigned long t0=millis();String r="";while(millis()-t0<22000){while(modem.available())r+=(char)modem.read();if(r.indexOf("+CIPOPEN:")>=0){Serial.print("[CIP] ");Serial.println(r);return r.indexOf("+CIPOPEN: 0,0")>=0;}}Serial.println("[CIP] timeout");return false;}
bool g_sosCancel=false; // naka-set kapag ang sagot ng server ay may "sosCancel":true = na-resolve na ng admin ang SOS sa dashboard
bool tcpSend(const String& request){
  modem.println("AT+CIPSEND=0,"+String(request.length()));
  if(!waitTok(">",6000)){Serial.println("[CIP] walang '>' prompt");return false;}
  modem.print(request);
  bool ok=waitTok("HTTP/1.1",9000); // naghihintay ng sagot ng server = naihatid ang post
  String resp=""; unsigned long rt0=millis(); // kunin ang body ng sagot (para sa sosCancel flag)
  while(millis()-rt0<1500){while(modem.available())resp+=(char)modem.read();}
  if(resp.indexOf("\"sosCancel\":true")>=0) g_sosCancel=true;
  at("AT+CIPCLOSE=0",400);
  return ok;
}
bool sendJson(const String& json){
  String request="POST /api/telemetry HTTP/1.1\r\nHost: "+String(SERVER_HOSTNAME)+"\r\nX-API-Key: "+API_KEY+"\r\nContent-Type: application/json\r\nContent-Length: "+String(json.length())+"\r\nConnection: close\r\n\r\n"+json;
  at("AT+NETOPEN",800); // ERROR kapag open na — okay lang
  bool sent=false;
  for(int a=1;a<=2&&!sent;a++){ // agad na retry sa iisang cycle: hindi na maghihintay ng susunod na 10s
    at("AT+CIPCLOSE=0",400);    // linisin ang posibleng naiwang socket bago mag-open (iwas wedge)
    if(cipOpen()) sent=tcpSend(request); else Serial.println("[CIP] attempt "+String(a)+" failed");
  }
  return sent;
}
bool postLocation(){ if(!gps.location.isValid())return true; Serial.println("[POST] sending location...");
  String json="{\"deviceId\":\""+String(DEVICE_ID)+"\",\"lat\":"+String(gps.location.lat(),6)+",\"lng\":"+String(gps.location.lng(),6)+",\"speedKph\":"+String(gps.speed.kmph(),1)+",\"accuracyM\":8}";
  bool sent=sendJson(json);
  Serial.println(sent?"[POST] OK":"[POST] FAIL");
  return sent;
}
bool postSOS(){
  // Kahit WALANG GPS fix, ipapadala pa rin ang SOS (mas mahalaga ang alerto kaysa sa eksaktong posisyon)
  double lat=gps.location.isValid()?gps.location.lat():0.0, lng=gps.location.isValid()?gps.location.lng():0.0;
  Serial.printf("[SOS] pinapadala ang SOS #%u sa dashboard...\n",sosSeq);
  String json="{\"deviceId\":\""+String(DEVICE_ID)+"\",\"lat\":"+String(lat,6)+",\"lng\":"+String(lng,6)+",\"sos\":true,\"sosSeq\":"+String(sosSeq)+"}";
  bool sent=sendJson(json);
  Serial.println(sent?"[SOS] SENT OK — may SOS alert na sa dashboard":"[SOS] FAILED — ulit muli sa susunod na cycle");
  return sent;
}
void setup(){Serial.begin(115200);gpsSerial.begin(9600,SERIAL_8N1,GPS_RX,GPS_TX);pinMode(GPS_WAKE,OUTPUT);digitalWrite(GPS_WAKE,HIGH);pinMode(SOS_BTN,INPUT_PULLUP);pinMode(BEEP_PIN,OUTPUT);digitalWrite(BEEP_PIN,LOW);modemReady();Serial.println("Tracker booted; move GPS antenna outdoors for first fix.");Serial.println("[SOS] ISANG PINDOT = AGAD na SOS sa dashboard (isang alert kada pindot). Hawak 5s = CANCEL. Buzzer sa GPIO33.");}
bool lastPostOk=true;
void loop(){while(gpsSerial.available())gps.encode(gpsSerial.read());
// ---- SOS button: ISANG PINDOT = AGAD na SOS send (momentary button: pindot=lubog, bitaw=aangat) ----
// Ang isang pindot ay AGAD na nagpapadala ng SOS sa dashboard (isang alert kada pindot).
// Beep TULOY-TULOY hanggang: (a) ma-resolve ng admin sa dashboard (dito dumarating ang
// sosCancel mula sa sagot ng server), o (b) hawakan ang button ng 5s = manual CANCEL.
static bool down=false, sosActive=false, armed=true;
static unsigned long downT0=0, sosLast=0, beepT=0;
bool level=digitalRead(SOS_BTN); unsigned long now=millis();
if(level==HIGH){ armed=true; down=false; }        // bitaw (aangat) = pwede nang muling mag-trigger
if(level==LOW){
  if(!down){ down=true; downT0=now; }             // simula ng paglubog
  if(!sosActive && armed){                        // *** ISANG PINDOT = AGAD na SOS ***
    armed=false; sosActive=true; g_sosCancel=false; sosSeq++;
    Serial.printf("[SOS] *** PININDOT — SOS #%u AGAD na ipapadala sa dashboard + beep tuloy-tuloy ***\n",sosSeq);
    sosLast=now; postSOS();
  }
}
if(sosActive){
  if(g_sosCancel){ // na-resolve na ng admin sa dashboard — tumigil lahat; balik sa dating icon
    sosActive=false; g_sosCancel=false; digitalWrite(BEEP_PIN,LOW);
    Serial.println("[SOS] na-RESOLVE na ng admin — STOP ang beep; balik sa normal tracking");
  } else if(down && now-downT0>=SOS_CANCEL_MS){ // hawak 5s = manual CANCEL
    sosActive=false; digitalWrite(BEEP_PIN,LOW);
    Serial.println("[SOS] CANCELLED (hawak 5s) — tumigil ang beep; i-mark-as-read ng admin ang alert sa dashboard");
  } else {
    if(now-beepT>=400){ beepT=now; beepOnce(150); }         // beep paulet-ulet hanggang ma-resolve/i-cancel
    if(now-sosLast>=SOS_REPEAT_MS){ sosLast=now; postSOS(); } // ulit kada 10s (dedupe sa server: isang alert lang)
  }
}
// ---- normal GPS heartbeat ----
if(millis()-lastGpsPrint>10000){lastGpsPrint=millis();Serial.printf("GPS: %s lat=%.6f lng=%.6f sats=%d spd=%.1fkph\n",gps.location.isValid()?"FIX":"NO FIX",gps.location.lat(),gps.location.lng(),gps.satellites.value(),gps.speed.kmph());}unsigned long interval=lastPostOk?10000:6000; // heartbeat kada 10s = mas mabilis maka-detect ang dashboard ng offline/online; pumalya? retry pagkatapos ng 6s
      if (millis() - lastSend > interval) {
      lastSend = millis();
      lastPostOk = postLocation();
    }}
