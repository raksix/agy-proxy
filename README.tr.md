# agy-proxy

<p align="center">
  <b>Google Antigravity CLI (<code>agy</code>) için OpenAI-Uyumlu Yerel Köprü</b>
</p>

<p align="center">
  <a href="README.md">🇬🇧 English</a> •
  <a href="README.tr.md">🇹🇷 Türkçe</a> •
  <a href="README.ja.md">🇯🇵 日本語</a>
</p>

---

Hermes Agent (veya herhangi bir OpenAI uyumlu istemci), bu servise standart `/v1/chat/completions` istekleri gönderir. `agy-proxy`, gelen isteği bir `agy --print` çalıştırmasına dönüştürür ve cevabı OpenAI formatında (ve isteğe bağlı olarak SSE akışı olarak) geri döner.

## Öne Çıkan Özellikler

- **Sıfır Bağımlılık** — Harici npm paketi gerektirmez, tamamen Node.js standart kütüphanesine (`node:http`, `node:child_process`) dayanır.
- **Gerçek Zamanlı SSE Akışı** — `stream: true` seçeneğiyle standart OpenAI formatında token akışı sağlar.
- **Çoklu Dil Desteği** — İngilizce, Türkçe ve Japonca (`ja` / 日本語) yanıt verme desteği.
- **Büyük Prompt Güvenliği** — Sistem prompt'larının işletim sistemi `E2BIG` argv sınırına takılmasını önlemek için geçici dosyalar üzerinden aktarılır.
- **Doğrudan OAuth Oturumu** — `agy`'nin halihazırda var olan Google OAuth oturumunu (`~/.gemini/antigravity-cli`) doğrudan kullanır; ek API anahtarı gerektirmez.
- **Dayanıklı Çalışma** — `agy` geçici 503/hata kodları verse bile toplanan model çıktısını kurtararak yanıtı başarıyla teslim eder.
- **Eşzamanlılık Kuyruğu** — `AGY_MAX_CONCURRENT` ile aynı anda çalışabilecek süreç sayısını sınırlar.

---

## Dosya Yapısı

```text
server.js            HTTP köprü sunucusu (node:http)
ecosystem.config.cjs PM2 süreç yapılandırması
start.sh             Başlatma ve PM2 yönetim betiği
login-driver.sh      Google OAuth girişi için FIFO tabanlı yardımcı
stream-probe.sh      Akış gecikme ölçüm testi
concurrent-probe.sh  Eşzamanlı istek yük testi
package.json         Paket manifestosu
work/                Alt agy oturumlarının çalışma dizini
```

---

## Hızlı Başlangıç

### Gereksinimler

- Node.js >= 18
- Kurulu ve oturum açılmış Google Antigravity CLI (`agy`):
  ```bash
  agy --version
  ```

### Proxy'yi Başlatma

```bash
# PM2 ile başlatmak için:
bash start.sh

# Veya doğrudan Node.js ile:
node server.js
```

### Sağlık Kontrolü ve Model Listesi

```bash
# Oturum ve proxy durumunu kontrol edin
curl http://127.0.0.1:3611/health

# Mevcut modelleri listeleyin
curl http://127.0.0.1:3611/v1/models
```

---

## Kullanım ve Chat İstekleri

```bash
curl -X POST http://127.0.0.1:3611/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGY_PROXY_TOKEN" \
  -d '{
    "model": "antigravity-gemini-3.8-flash",
    "messages": [
      {"role": "user", "content": "Yapay zekanın geleceğini tek cümlede özetle."}
    ]
  }'
```

Akışlı (streaming) yanıt almak için gövdeye `"stream": true` ekleyin:

```bash
curl -N -X POST http://127.0.0.1:3611/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGY_PROXY_TOKEN" \
  -d '{
    "model": "antigravity-gemini-3.8-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "1den 5e kadar say."}]
  }'
```

---

## Çoklu Dil Desteği (Türkçe / İngilizce / Japonca)

Proxy'nin belirli bir dilde yanıt vermesini sağlamak için aşağıdaki yöntemlerden birini kullanabilirsiniz:

1. **İstek Gövdesi (Body):**
   ```json
   {
     "model": "antigravity-gemini-3.8-flash",
     "language": "tr",
     "messages": [{"role": "user", "content": "Merhaba"}]
   }
   ```
   *(Desteklenen diller: `tr` / `turkish`, `en` / `english`, `ja` / `japanese`)*

2. **HTTP Başlığı (Header):**
   ```bash
   -H "x-language: tr"
   # veya
   -H "Accept-Language: tr"
   ```

3. **URL Parametresi (Query):**
   ```bash
   POST http://127.0.0.1:3611/v1/chat/completions?lang=tr
   ```

4. **Ortam Değişkeni (Env):**
   ```bash
   export AGY_LANGUAGE=tr
   ```

---

## Model Listesi

| Model ID | Karşılık Gelen agy Modeli | Açıklama |
|---|---|---|
| `antigravity-gemini-3.8-flash` | `gemini-3.8-flash-medium` | Varsayılan dengeli model |
| `antigravity-gemini-3.8-flash-fast` | `gemini-3.8-flash-low` | En hızlı ve ekonomik model |
| `antigravity-gemini-3.8-flash-thinking` | `gemini-3.8-flash-high` | Yüksek düşünme/muhakeme modu |
| `antigravity-gemini-3.7-flash` | `gemini-3.7-flash-medium` | Gemini 3.7 serisi |
| `antigravity-gemini-3.6-flash` | `gemini-3.6-flash-medium` | Gemini 3.6 serisi |

Doğrudan `agy` model adları da (ör. `gemini-3.8-flash-medium`) kabul edilir.

---

## Yapılandırma Seçenekleri (Ortam Değişkenleri)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `AGY_PROXY_PORT` | `3611` | HTTP dinleme portu |
| `AGY_PROXY_HOST` | `127.0.0.1` | Bağlanılacak host |
| `AGY_PROXY_TOKEN` | `agy-local` | Kimlik doğrulama Bearer token'ı |
| `AGY_BIN` | `/root/.local/bin/agy` | `agy` çalıştırılabilir dosya yolu |
| `AGY_CWD` | `./work` | Alt süreçlerin çalışma dizini |
| `AGY_MAX_CONCURRENT` | `3` | Eşzamanlı azami süreç sayısı |
| `AGY_TIMEOUT_MS` | `300000` | İstek zaman aşımı (ms) |
| `AGY_LANGUAGE` | `""` | Varsayılan zorunlu dil (`en`, `tr`, `ja`) |

---

## Hermes Entegrasyonu

`~/.hermes/config.yaml` içine sağlayıcı tanımını ekleyin:

```yaml
providers:
  agcli:
    name: Antigravity CLI
    base_url: http://127.0.0.1:3611/v1
    api_mode: chat_completions
    key_env: AGY_PROXY_TOKEN
    models:
      antigravity-gemini-3.8-flash: {}
      antigravity-gemini-3.8-flash-fast: {}
      antigravity-gemini-3.8-flash-thinking: {}
```

Kullanım:
```bash
hermes chat --provider agcli --model antigravity-gemini-3.8-flash
```

---

## Lisans

MIT License © 2026 Furkan Ermağ (raksix)
