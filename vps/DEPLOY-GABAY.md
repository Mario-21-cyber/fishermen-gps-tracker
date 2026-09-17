# 🚀 VPS Deployment Gabay — Fishermen Monitor

Gawin itong **permanente at propesyonal**: 24/7 online, permanenteng URL,
hindi na nakadepende sa Mac.

---

## HAKBANG 1 — Mag-rent ng VPS (~10 minuto)

### ✅ KUNG TIPID ANG HANAP (rekomendasyon ko): RackNerd — ~$11/TAON lang!
Iyon ay **~₱630 kada TAON = ~₱53 kada buwan**. Kaya ng tracker natin nang
kumpleto (maliit lang ang kailangan natin: 1GB RAM, 20GB disk).

1. Pumunta sa **racknerd.com** → hanapin ang **"Specials / KVM Treasury"**
   section sa homepage (mga annual promo na $10.99-$12.99/taon, 1GB RAM KVM).
2. Piliin ang **Ubuntu 22.04 64-bit** bilang OS sa checkout.
3. Location: **San Jose, CA** (pinakamalapit na sa Pilipinas sa mga DC nila).
4. Bayad: **PayPal o card**.
   💡 **Walang PayPal?** I-link ang **GCash mo sa PayPal** (karaniwang gawain
   ng mga Pinoy: PayPal → "Link bank/card" o cash-in mula GCash), tapos
   bayaran gamit ang PayPal.
5. Makakatanggap ka ng **email: IP address + root password** — ibigay mo ito
   sa akin (o gamitin sa Hakbang 2 sa ibaba).

Ibang opsyon kung gusto mo ng iba:

| Provider | Presyo | Kailan piliin |
|---|---|---|
| **RackNerd** (promo) | **~$11/TAON** (~₱53/buwan) | ✅ Pinakamura — ito ang kunin mo |
| [vultr.com](https://www.vultr.com) | ~$6/buwan | Kung gusto mo **Singapore** (mas mabilis nang kaunti) |
| [contabo.com](https://contabo.com) | ~$5/buwan | Kung gusto mo ng malaking specs |
| [hostinger.com](https://www.hostinger.com) | ~₱170-300/buwan | **Tumatanggap ng GCash sa PH** — kung walang PayPal/card |

Kailangan: **credit/debit card o PayPal** (si Hostinger, minsang may GCash).
Pagkatapos magbayad, makatatanggap ka ng email na may **IP address** at
**root password**.

### 🔄 KUNG BUWANAN ANG GUSTO (1-month subscription, i-cancel kahit kailan)

| Provider | Buwanan | Paliwanag |
|---|---|---|
| **DigitalOcean** ($4-6/buwan ≈ ₱230-340) | hourly billing — cancel kahit kailan | **Top pick**; Singapore DC; PayPal/card; walang minimum deposit |
| **Vultr** ($6/buwan ≈ ₱340) | hourly — cancel anytime | Singapore rin; ⚠️ **IWASAN ang $2.50 plan — IPv6-only, HINDI gagana ang board!** |
| **Hostinger KVM 1** (~₱280-350/buwan) | buwanan | **Tumatanggap ng GCash sa PH** — kung wala kang PayPal/card |

Piliin ang **Ubuntu 22.04**, region **Singapore** kung meron. Ang maliit na
plan (512MB-1GB) ay sapat — 50MB lang ang kainin ng ating server.

💡 Tandaan lang: ang buwanan ay 4-6x na mas mahal kaysa sa RackNerd annual
(₱53/buwan) sa mahabang panahon — pero mas flexible kung hindi pa sigurado.
Ang proseso ng deploy ay **pareho sa lahat** (Hakbang 2-6 sa ibaba).


⚠️ Sapat na ang pinakamaliit na plan (512MB-1GB RAM) — maliit lang talaga ang
kailangan ng ating server (zero-dependency Node, 1 bangka, JSON file storage).


## HAKBANG 2 — I-upload ang tracker mula sa Mac (1 command)

```bash
cd ~/Documents/Codex/2026-08-29/gaw/outputs/fishermen-gps-tracker/vps
./upload.sh root@<VPS-IP>
```
(I-type ang root password mula sa email. Isasama rin ang kasalukuyang data —
703+ track points, devices, at admin login mo.)

## HAKBANG 3 — I-install sa VPS (1 command)

```bash
ssh root@<VPS-IP> 'bash /opt/fishermen-tracker/vps/install.sh'
```
Awtomatikong gagawin: Node.js install → systemd service (auto-restart) →
firewall (SSH/HTTP lang ang bukas) → server start.

## HAKBANG 4 — Subukan!

Buksan sa kahit anong device: **`http://<VPS-IP>:3000`** — login ka gaya ng dati.

## HAKBANG 5 — I-flash ang board papuntang VPS (huling beses na!)

Dahil **hindi na magbabago ang URL**, isang flash na lang at tapos forever:

```bash
cd ~/Documents/Codex/2026-08-29/gaw/outputs/fishermen-gps-tracker
# palitan ang dalawang linya sa firmware/src/main.cpp:
#   SERVER_HOST="<VPS-IP>"           (connect target)
#   SERVER_HOSTNAME="<VPS-IP>"       (Host header — pareho lang)
# tapos, naka-plug ang board sa USB:
~/.platformio/penv/bin/pio run -d firmware -t upload
```

## HAKBANG 6 — Patayin na ang lumang serveo setup (opsyonal)

```bash
launchctl unload ~/Library/LaunchAgents/com.fishermen.serveo.plist
```
Ang Mac ay pwede nang i-shutdown kahit kailan — sa VPS na ang lahat.
(Ang `~/fishermen-tracker` production copy ay hindi na kailangan din.)

---

## 🔒 Security (mahirap nang balikan — gawin agad)

1. **Palitan ang default API key**: sa VPS, i-edit ang
   `/etc/systemd/system/fishermen.service` → i-uncomment at palitan ang
   `TRACKER_API_KEY` → `systemctl daemon-reload && systemctl restart fishermen`
   → **at** palitan ang parehong key sa firmware (`main.cpp`) bago mag-flash.
2. **Malakas na admin password** sa dashboard (Settings kung meron, o
   `data/admin.json`).
3. Iwanang naka-enable ang ufw (SSH/80/3000 lang).

## 🩺 Kapag may problema

```bash
ssh root@<VPS-IP>
systemctl status fishermen        # tumatakbo ba?
journalctl -u fishermen -n 50     # huling 50 linya ng log
systemctl restart fishermen       # restart
```
Sa Mac, ang data ay ligtas pa rin sa `~/fishermen-tracker/data/` (backup).
