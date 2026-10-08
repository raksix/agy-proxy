# agy-proxy

<p align="center">
  <b>OpenAI-compatible local bridge for Google Antigravity CLI (<code>agy</code>)</b><br>
  <i>Multi-language support: English · Türkçe · 日本語</i>
</p>

<p align="center">
  <a href="#english">English</a> •
  <a href="#türkçe">Türkçe</a> •
  <a href="#日本語">日本語</a>
</p>

<p align="center">
  <a href="README.md">🇬🇧 README (EN)</a> •
  <a href="README.tr.md">🇹🇷 README (TR)</a> •
  <a href="README.ja.md">🇯🇵 README (JA)</a>
</p>

---

<a name="english"></a>
## 🇬🇧 English

OpenAI-compatible local bridge for the **Google Antigravity CLI** (`agy`).

Hermes Agent (or any OpenAI-compatible client) sends standard `/v1/chat/completions` requests to this service. `agy-proxy` translates each incoming request into an `agy --print` run and streams back the answer in OpenAI format.

### Highlights

- **Zero npm dependencies** — built purely on Node.js standard modules (`node:http`, `node:child_process`).
- **Full SSE Streaming** — supports `stream: true` with standard OpenAI chunk tokens.
- **Multi-language response control** — explicit support for English, Turkish, and Japanese (`ja` / 日本語).
- **Large prompt safety** — avoids OS `E2BIG` argv limits by piping prompts safely via temp files.
- **Native OAuth reuse** — authenticates directly using `agy`'s existing CLI OAuth session (`~/.gemini/antigravity-cli`).
- **Resilient execution** — captures model output even if `agy` reports transient Gemini 503s afterwards.
- **Concurrency control** — configurable process queue (`AGY_MAX_CONCURRENT`).

---

### Layout

```text
server.js            The bridge HTTP server (node:http)
ecosystem.config.cjs PM2 process descriptor
start.sh             Launcher script (with PM2 integration)
login-driver.sh      FIFO-based CLI login helper for Google OAuth
stream-probe.sh      Streaming latency benchmark probe
concurrent-probe.sh  Concurrency stress testing script
package.json         Package manifest
work/                Working directory for child agy instances
```

---

### Quick Start

#### Prerequisites

- Node.js >= 18
- Google Antigravity CLI (`agy`) installed and authenticated:
  ```bash
  agy --version
  ```

#### Starting the proxy

```bash
# Using PM2 launcher:
bash start.sh

# Or directly using Node.js:
node server.js
```

#### Health check & model catalog

```bash
# Verify authentication status and active configuration
curl http://127.0.0.1:3611/health

# List available models
curl http://127.0.0.1:3611/v1/models
```

---

### Usage & Chat Completions

```bash
curl -X POST http://127.0.0.1:3611/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGY_PROXY_TOKEN" \
  -d '{
    "model": "antigravity-gemini-3.8-flash",
    "messages": [
      {"role": "user", "content": "Explain quantum computing in two sentences."}
    ]
  }'
```

Streaming is enabled by adding `"stream": true`:

```bash
curl -N -X POST http://127.0.0.1:3611/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGY_PROXY_TOKEN" \
  -d '{
    "model": "antigravity-gemini-3.8-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "Count from 1 to 5."}]
  }'
```

---

### Multi-Language Support (English / Turkish / Japanese)

You can enforce the assistant's output language in several ways:

1. **Request Body Parameter:**
   ```json
   {
     "model": "antigravity-gemini-3.8-flash",
     "language": "ja",
     "messages": [{"role": "user", "content": "Hello!"}]
   }
   ```
   *(Supported codes: `ja` / `japanese`, `tr` / `turkish`, `en` / `english`)*

2. **HTTP Headers:**
   ```bash
   -H "x-language: ja"
   # or
   -H "Accept-Language: ja"
   ```

3. **URL Query Parameter:**
   ```bash
   POST http://127.0.0.1:3611/v1/chat/completions?lang=ja
   ```

4. **Environment Variable:**
   ```bash
   export AGY_LANGUAGE=ja
   ```

---

### Model Catalog

| Model ID | Underlying agy Slug | Notes |
|---|---|---|
| `antigravity-gemini-3.8-flash` | `gemini-3.8-flash-medium` | Default balanced model |
| `antigravity-gemini-3.8-flash-fast` | `gemini-3.8-flash-low` | Lowest latency & cost |
| `antigravity-gemini-3.8-flash-thinking` | `gemini-3.8-flash-high` | Deep reasoning effort |
| `antigravity-gemini-3.7-flash` | `gemini-3.7-flash-medium` | Gemini 3.7 series |
| `antigravity-gemini-3.6-flash` | `gemini-3.6-flash-medium` | Gemini 3.6 series |

Raw `agy` model slugs (e.g. `gemini-3.8-flash-medium`) are also accepted as model IDs.

---

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGY_PROXY_PORT` | `3611` | HTTP server listening port |
| `AGY_PROXY_HOST` | `127.0.0.1` | Bind host (keep local for security) |
| `AGY_PROXY_TOKEN` | `agy-local` | Bearer token for API authentication |
| `AGY_BIN` | `/root/.local/bin/agy` | Absolute path to the `agy` CLI executable |
| `AGY_CWD` | `./work` | Working directory for child CLI runs |
| `AGY_MAX_CONCURRENT` | `3` | Maximum simultaneous `agy` child processes |
| `AGY_TIMEOUT_MS` | `300000` | Request timeout in milliseconds (5 minutes) |
| `AGY_LANGUAGE` | `""` | Default forced language (`en`, `tr`, `ja`) |

---

### Hermes Agent Setup

Add the proxy as an OpenAI-compatible provider in `~/.hermes/config.yaml`:

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

Start chatting:
```bash
hermes chat --provider agcli --model antigravity-gemini-3.8-flash
```

---

<a name="türkçe"></a>
## 🇹🇷 Türkçe

**Google Antigravity CLI** (`agy`) için OpenAI-uyumlu yerel köprü (proxy).

Hermes Agent (veya herhangi bir OpenAI uyumlu istemci), bu servise standart `/v1/chat/completions` istekleri gönderir. `agy-proxy`, gelen isteği bir `agy --print` çalıştırmasına dönüştürür ve cevabı OpenAI formatında (ve isteğe bağlı olarak SSE akışı olarak) geri döner.

### Öne Çıkan Özellikler

- **Sıfır bağımlılık** — Harici npm paketi gerektirmez, tamamen Node.js standart kütüphanesine (`node:http`, `node:child_process`) dayanır.
- **Gerçek Zamanlı SSE Akışı** — `stream: true` seçeneğiyle standart OpenAI formatında token akışı sağlar.
- **Çoklu Dil Desteği** — İngilizce, Türkçe ve Japonca (`ja` / 日本語) yanıt verme desteği.
- **Büyük Prompt Güvenliği** — Sistem prompt'larının işletim sistemi `E2BIG` argv sınırına takılmasını önlemek için geçici dosyalar üzerinden aktarılır.
- **Doğrudan OAuth Oturumu** — `agy`'nin halihazırda var olan Google OAuth oturumunu (`~/.gemini/antigravity-cli`) doğrudan kullanır; ek API anahtarı gerektirmez.
- **Dayanıklı Çalışma** — `agy` geçici 503/hata kodları verse bile toplanan model çıktısını kurtararak yanıtı başarıyla teslim eder.
- **Eşzamanlılık Kuyruğu** — `AGY_MAX_CONCURRENT` ile aynı anda çalışabilecek süreç sayısını sınırlar.

---

### Dosya Yapısı

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

### Hızlı Başlangıç

#### Gereksinimler

- Node.js >= 18
- Kurulu ve oturum açılmış Google Antigravity CLI (`agy`):
  ```bash
  agy --version
  ```

#### Proxy'yi Başlatma

```bash
# PM2 ile başlatmak için:
bash start.sh

# Veya doğrudan Node.js ile:
node server.js
```

#### Sağlık Kontrolü ve Model Listesi

```bash
# Oturum ve proxy durumunu kontrol edin
curl http://127.0.0.1:3611/health

# Mevcut modelleri listeleyin
curl http://127.0.0.1:3611/v1/models
```

---

### Kullanım ve Chat İstekleri

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

### Çoklu Dil Desteği (Türkçe / İngilizce / Japonca)

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

### Model Listesi

| Model ID | Karşılık Gelen agy Modeli | Açıklama |
|---|---|---|
| `antigravity-gemini-3.8-flash` | `gemini-3.8-flash-medium` | Varsayılan dengeli model |
| `antigravity-gemini-3.8-flash-fast` | `gemini-3.8-flash-low` | En hızlı ve ekonomik model |
| `antigravity-gemini-3.8-flash-thinking` | `gemini-3.8-flash-high` | Yüksek düşünme/muhakeme modu |
| `antigravity-gemini-3.7-flash` | `gemini-3.7-flash-medium` | Gemini 3.7 serisi |
| `antigravity-gemini-3.6-flash` | `gemini-3.6-flash-medium` | Gemini 3.6 serisi |

Doğrudan `agy` model adları da (ör. `gemini-3.8-flash-medium`) kabul edilir.

---

### Hermes Entegrasyonu

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

<a name="日本語"></a>
## 🇯🇵 日本語

**Google Antigravity CLI** (`agy`) 用の OpenAI 互換ローカルブリッジプロキシ。

Hermes Agent（または任意の OpenAI 互換クライアント）から標準の `/v1/chat/completions` リクエストを受け取り、`agy --print` の実行に変換して OpenAI 形式で結果を返します。

### 主な特徴

- **ゼロ依存関係** — 外部 npm パッケージ不要。Node.js 組み込みモジュール（`node:http`, `node:child_process`）のみで動作します。
- **SSE ストリーミング完全対応** — `stream: true` によるリアルタイムなトークン配信に対応。
- **多言語出力サポート** — 日本語（`ja`）、英語（`en`）、トルコ語（`tr`）への出力指定が可能。
- **大容量プロンプト保護** — OS の `E2BIG`（引数長制限）を回避するため、プロンプトを一時ファイル経由で安全に渡します。
- **Google OAuth セッションの再利用** — `agy` の既存の認証情報（`~/.gemini/antigravity-cli`）を直接利用します。
- **耐障害性** — モデル回答取得後に `agy` が一時的な Gemini 503 等のエラーを出力した場合でも、収集されたテキストを正常に返却します。
- **並行処理制御** — `AGY_MAX_CONCURRENT` による同時実行プロセスのキュー管理。

---

### ディレクトリ構成

```text
server.js            HTTP ブリッジサーバー本体 (node:http)
ecosystem.config.cjs PM2 プロセス設定ファイル
start.sh             起動用スクリプト (PM2 対応)
login-driver.sh      Google OAuth ログイン補助スクリプト (FIFO 方式)
stream-probe.sh      ストリーミング遅延計測スクリプト
concurrent-probe.sh  並行リクエスト負荷テスト
package.json         パッケージ定義
work/                子 agy プロセスの作業ディレクトリ
```

---

### クイックスタート

#### 前提条件

- Node.js >= 18
- Google Antigravity CLI (`agy`) がインストールされ、認証済みであること:
  ```bash
  agy --version
  ```

#### プロキシの起動

```bash
# PM2 経由で起動する場合:
bash start.sh

# Node.js で直接起動する場合:
node server.js
```

#### ヘルスチェック & モデル一覧

```bash
# 認証状態と設定の確認
curl http://127.0.0.1:3611/health

# 利用可能なモデル一覧
curl http://127.0.0.1:3611/v1/models
```

---

### 日本語での利用例

日本語で回答を得るには、リクエストボディに `"language": "ja"` を指定するか、HTTP ヘッダー `x-language: ja` を付与します。

```bash
curl -X POST http://127.0.0.1:3611/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGY_PROXY_TOKEN" \
  -d '{
    "model": "antigravity-gemini-3.8-flash",
    "language": "ja",
    "messages": [
      {"role": "user", "content": "量子コンピュータについて2文で説明してください。"}
    ]
  }'
```

ストリーミング出力（SSE）を行う場合:

```bash
curl -N -X POST http://127.0.0.1:3611/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $AGY_PROXY_TOKEN" \
  -d '{
    "model": "antigravity-gemini-3.8-flash",
    "language": "ja",
    "stream": true,
    "messages": [
      {"role": "user", "content": "1から5まで数えてください。"}
    ]
  }'
```

---

### 多言語指定の方法

以下のいずれの方法でも言語を指定できます:

1. **リクエストボディ:** `"language": "ja"` または `"lang": "ja"`
2. **HTTP ヘッダー:** `-H "x-language: ja"` または `-H "Accept-Language: ja"`
3. **URL クエリ:** `POST /v1/chat/completions?lang=ja`
4. **環境変数:** `export AGY_LANGUAGE=ja`

対応言語コード:
- 日本語: `ja`, `japanese`, `jp`
- トルコ語: `tr`, `turkish`
- 英語: `en`, `english`

---

### 利用可能モデル一覧

| モデル ID | agy スラグ | 説明 |
|---|---|---|
| `antigravity-gemini-3.8-flash` | `gemini-3.8-flash-medium` | 標準バランス型 |
| `antigravity-gemini-3.8-flash-fast` | `gemini-3.8-flash-low` | 高速・軽量 |
| `antigravity-gemini-3.8-flash-thinking` | `gemini-3.8-flash-high` | 深い思考・推論 |
| `antigravity-gemini-3.7-flash` | `gemini-3.7-flash-medium` | Gemini 3.7 シリーズ |
| `antigravity-gemini-3.6-flash` | `gemini-3.6-flash-medium` | Gemini 3.6 シリーズ |

---

### ライセンス

MIT License © 2026 Furkan Ermağ (raksix)
