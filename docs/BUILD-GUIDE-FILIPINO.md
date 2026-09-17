# Gabay sa pagbuo — Azagra Fishermen Tracker

## Bago ka magbukas ng ESP32

Hindi mo pa kailangang buksan o ikabit ang board habang pinapatakbo ang dashboard. Para sa hardware phase, ihanda: ang LilyGO T-SIM A7670G R2, **nano SIM na may active mobile data**, LTE antenna, GPS/L76K module at GPS antenna (kung GPS version ito), Type-C **data** cable, at laptop. Ang mga huling tatlo ay hindi malinaw na kasama sa folder ng parts; huwag mag-final assembly kung kulang ang mga iyon.

Huwag ikabit ang board sa solar panel o CN3791 habang nag-u-upload. Sa unang test, USB-C data cable lang ang power source. Hindi dapat ikabit ang 6 V solar panel direkta sa ESP32 board.

## Step-by-step: software muna

1. I-save ang folder na ito sa laptop. Buksan ang Terminal sa top-level folder at i-run ang `node server/server.js`.
2. Buksan ang `http://localhost:3000` — maghihintay ito ng totoong GPS data mula sa board (walang demo sa final version). Kapag plug na ang board, lalabas ang totoong posisyon sa mapa kada 60 segundo.
3. Sa final deployment, ilagay ang server sa public HTTPS host o isang reachable local IP; hindi maa-access ng ESP32 ang `localhost` ng laptop.

## Step-by-step: unang hardware test

1. **Patay at walang power:** isaksak ang nano SIM sa tamang orientation. Ikabit ang LTE antenna sa LTE/IPEX connector. Kung may L76K GPS board, ikabit ang GPS module/antenna ayon sa board kit. Huwag piliting ikabit ang antenna sa maling connector.
2. Ikabit ang Type-C **data** cable mula laptop papunta sa board. Dapat may power LED at may bagong serial port ang computer. Kung walang port, subukan ibang cable—maraming Type-C cable ay charging-only.
3. I-install ang VS Code at PlatformIO extension. Buksan ang `firmware/` folder bilang project.
4. Sa `firmware/src/main.cpp`, palitan ang `APN`, `SERVER_HOST`, at `API_KEY`. Ang API key ay dapat pareho sa `server/server.js`.
5. Pindutin ang Upload. Kapag “Connecting…” lang, hawakan ang **BOOT** button habang sinisimulan ang upload, saka bitawan pagkatapos magsimula ang writing.
6. Buksan ang Serial Monitor sa 115200 baud. Dalhin ang GPS antenna/board sa labas at maghintay ng clear sky; ang unang GPS fix ay maaaring tumagal nang ilang minuto. Kapag may valid coordinates, may POST request kada 60 segundo.
7. I-check ang dashboard. Dapat gumalaw ang coordinates ng `AZG-BOAT-001` at mag-update ang “Last update.”

## Solar/battery wiring — gawin lamang matapos pumasa ang USB test

Ang available power parts ay 6 V solar panel, CN3791 charger, at 18650 cells. Ang safe high-level flow ay `solar panel → CN3791 solar input → 18650 battery → regulated board supply`. Kailangan muna ng **regulated 5 V boost converter** (o gamitin ang documented 18650 holder ng T-SIM board kung tugma ang actual board); wala akong nakitang boost converter sa supplied parts list. Dahil LTE boards ay may mataas na current bursts, huwag gumamit ng breadboard para sa final power wiring. I-test muna gamit ang multimeter, at maglagay ng fuse/switch bago permanent soldering.

## Final enclosure

1. Prototype at test muna sa breadboard/USB.
2. Kapag stable, ilipat sa protoboard; soldered connections + heat-shrink lamang para sa power wires.
3. I-mount sa enclosure gamit ang standoffs, gamitin ang cable glands, at ilabas ang GPS/LTE antenna kung kinakailangan para sa signal.
4. Huwag mag-seal ng enclosure hanggang matagumpay ang 30-minute outdoor test at power test.

## Safety / scope

Ito ay prototype tracker, hindi certified distress equipment. Magbigay ng informed consent sa fishermen, limitahan sa authorized barangay responders ang dashboard access, at huwag umasa rito bilang kapalit ng emergency radio, life jackets, o coast-guard procedures.
