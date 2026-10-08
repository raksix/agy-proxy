# agy-proxy

<p align="center">
  <b>Google Antigravity CLI (<code>agy</code>) 用 OpenAI 互換ローカルブリッジプロキシ</b>
</p>

<p align="center">
  <a href="README.md">🇬🇧 English</a> •
  <a href="README.tr.md">🇹🇷 Türkçe</a> •
  <a href="README.ja.md">🇯🇵 日本語</a>
</p>

---

Hermes Agent（または任意の OpenAI 互換クライアント）から標準の `/v1/chat/completions` リクエストを受け取り、`agy --print` の実行に変換して OpenAI 形式で結果を返します。

## 主な特徴

- **ゼロ外部依存** — 外部 npm パッケージ不要。Node.js 組み込みモジュール（`node:http`, `node:child_process`）のみで完結。
- **SSE ストリーミング完全対応** — `stream: true` によるリアルタイムなトークン配信に対応。
- **多言語出力サポート** — 日本語（`ja`）、英語（`en`）、トルコ語（`tr`）への出力指定が可能。
- **大容量プロンプト保護** — OS の `E2BIG`（引数長制限）を回避するため、プロンプトを一時ファイル経由で安全に渡します。
- **Google OAuth セッションの再利用** — `agy` の既存の認証情報（`~/.gemini/antigravity-cli`）を直接利用します。
- **耐障害性** — モデル回答取得後に `agy` が一時的な Gemini 503 等のエラーを出力した場合でも、収集されたテキストを正常に返却します。
- **並行処理制御** — `AGY_MAX_CONCURRENT` による同時実行プロセスのキュー管理。

---

## ディレクトリ構成

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

## クイックスタート

### 前提条件

- Node.js >= 18
- Google Antigravity CLI (`agy`) がインストールされ、認証済みであること:
  ```bash
  agy --version
  ```

### プロキシの起動

```bash
# PM2 経由で起動する場合:
bash start.sh

# Node.js で直接起動する場合:
node server.js
```

### ヘルスチェック & モデル一覧

```bash
# 認証状態と設定の確認
curl http://127.0.0.1:3611/health

# 利用可能なモデル一覧
curl http://127.0.0.1:3611/v1/models
```

---

## 日本語での利用例

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

## 多言語指定の方法

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

## 利用可能モデル一覧

| モデル ID | agy スラグ | 説明 |
|---|---|---|
| `antigravity-gemini-3.8-flash` | `gemini-3.8-flash-medium` | 標準バランス型 |
| `antigravity-gemini-3.8-flash-fast` | `gemini-3.8-flash-low` | 高速・軽量 |
| `antigravity-gemini-3.8-flash-thinking` | `gemini-3.8-flash-high` | 深い思考・推論 |
| `antigravity-gemini-3.7-flash` | `gemini-3.7-flash-medium` | Gemini 3.7 シリーズ |
| `antigravity-gemini-3.6-flash` | `gemini-3.6-flash-medium` | Gemini 3.6 シリーズ |

---

## 環境変数設定

| 変数名 | デフォルト値 | 説明 |
|---|---|---|
| `AGY_PROXY_PORT` | `3611` | HTTP リッスンポート |
| `AGY_PROXY_HOST` | `127.0.0.1` | バインドホスト |
| `AGY_PROXY_TOKEN` | `agy-local` | Bearer 認証トークン |
| `AGY_BIN` | `/root/.local/bin/agy` | `agy` コマンドパス |
| `AGY_CWD` | `./work` | 子プロセス作業ディレクトリ |
| `AGY_MAX_CONCURRENT` | `3` | 最大同時実行プロセス数 |
| `AGY_TIMEOUT_MS` | `300000` | タイムアウト（ミリ秒） |
| `AGY_LANGUAGE` | `""` | デフォルト強制言語 (`en`, `tr`, `ja`) |

---

## Hermes Agent 設定例

`~/.hermes/config.yaml` に追加:

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

チャットの開始:
```bash
hermes chat --provider agcli --model antigravity-gemini-3.8-flash
```

---

## ライセンス

MIT License © 2026 Furkan Ermağ (raksix)
