# contact-us

Cloudflare Worker によるお問い合わせフォームバックエンド。フォーム送信を受け付け、Discord にチケットチャンネルを作成し、Resend 経由でメール通知を行う。

## 機能

- **フォーム受付** — Cloudflare Turnstile で検証後、問い合わせ内容を受け付け
- **Discord チケット** — 問い合わせごとに Discord チャンネルを自動作成し、内容を Embed で投稿
- **メール通知** — Resend API で問い合わせ者に確認メールを送信
- **Discord `/reply` コマンド** — Discord 上から直接メールで返信可能
- **受信メール処理** — `reply+{channelId}@domain` 宛のメールを Discord チャンネルに転送

## 構成

- **ランタイム**: Cloudflare Workers
- **KV**: チケット情報（チャンネル ID → メールアドレス）の保存
- **外部サービス**: Discord API, Resend API, Cloudflare Turnstile

## 環境変数（Secrets）

| 変数名 | 説明 |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Bot トークン |
| `DISCORD_GUILD_ID` | チケットを作成するサーバー ID |
| `DISCORD_CATEGORY_ID` | チケットチャンネルを作成するカテゴリ ID |
| `DISCORD_PUBLIC_KEY` | Discord Interaction 検証用公開鍵 |
| `RESEND_API_KEY` | Resend API キー |
| `RESEND_FROM_EMAIL` | 送信元メールアドレス |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile シークレットキー |
| `ALLOWED_ORIGIN` | CORS 許可オリジン（カンマ区切りで複数指定可） |
| `REPLY_TO_DOMAIN` | 返信用メールアドレスのドメイン（省略時は `RESEND_FROM_EMAIL` のドメインを使用） |

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `POST` | `/` | フォーム送信を受け付け |
| `GET` | `/` | ヘルスチェック |
| `POST` | `/discord-interactions` | Discord Interaction Webhook |

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. Discord Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) で新しいアプリケーションを作成
2. **Bot** タブで Bot を有効化し、トークンを取得（→ `DISCORD_BOT_TOKEN`）
3. **General Information** タブで Public Key を取得（→ `DISCORD_PUBLIC_KEY`）
4. **OAuth2** → **URL Generator** で以下の権限を付与し、生成された URL からサーバーに招待
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Manage Channels`, `Send Messages`, `Embed Links`
5. チケット用のカテゴリチャンネルを Discord サーバーに作成し、カテゴリ ID を取得（→ `DISCORD_CATEGORY_ID`）
6. サーバー ID を取得（→ `DISCORD_GUILD_ID`）

### 3. Resend の設定

1. [Resend](https://resend.com) でアカウントを作成
2. **Domains** から送信用ドメインを追加
3. 表示される DNS レコード（SPF, DKIM, DMARC）をドメインの DNS に設定し、認証を完了
4. **API Keys** から API キーを取得（→ `RESEND_API_KEY`）
5. 送信元アドレスを決定（→ `RESEND_FROM_EMAIL`、例: `noreply@yourdomain`）

### 4. Cloudflare Turnstile の設定

1. **Cloudflare Dashboard** → **Turnstile** → **Add Widget**
2. 対象サイトのドメインを登録してウィジェットを作成
3. **Site Key**（フロントエンド側で使用）と **Secret Key** を取得（→ `TURNSTILE_SECRET_KEY`）

### 5. KV Namespace の設定

チケット情報（Discord チャンネル ID とメールアドレスの紐付け）を保存するために Cloudflare KV を使用する。

```bash
npx wrangler kv namespace create TICKET_KV
npx wrangler kv namespace create TICKET_KV --preview
```

出力された `id` と `preview_id` を `wrangler.toml` に設定する。

```toml
[[kv_namespaces]]
binding = "TICKET_KV"
id = "<作成時に出力された id>"
preview_id = "<preview 作成時に出力された id>"
```

### 6. Cloudflare Email Routing の設定

メール返信機能を使うには、Cloudflare ダッシュボードで Email Routing を設定する。

1. **Cloudflare Dashboard** → 対象ドメイン → **Email** → **Email Routing**
2. **Settings** タブで **Subaddressing** が有効になっていることを確認
3. **Routes** タブで以下のルールを追加

| Match | Action | Value |
|---|---|---|
| `reply@yourdomain` | Send to Worker | `contact-us-worker` |

> Subaddressing により `reply+{channelId}@domain` 宛のメールが `reply@domain` のルールで捕捉され、Worker に渡される。

### 7. Secrets の登録

各環境変数を Wrangler で登録する。

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_GUILD_ID
npx wrangler secret put DISCORD_CATEGORY_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put ALLOWED_ORIGIN
# 省略可（RESEND_FROM_EMAIL のドメインと異なる場合のみ）
npx wrangler secret put REPLY_TO_DOMAIN
```

### 8. デプロイと Discord Interaction Endpoint の設定

```bash
npx wrangler deploy
```

デプロイ後、Worker の URL を確認し Discord に登録する。

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを開く
2. **General Information** → **Interactions Endpoint URL** に `<Worker URL>/discord-interactions` を設定
3. `/reply` スラッシュコマンドを登録する

### 動作確認

1. フォームからお問い合わせを送信
2. Discord にチケットチャンネルが作成されることを確認
3. 問い合わせ者に確認メールが届くことを確認（Reply-To が `reply+{channelId}@domain` になっている）
4. 確認メールに返信 → Discord チャンネルに内容が投稿される
5. Discord で `/reply` コマンドを使用 → 問い合わせ者にメールが届く

## フロー図

```
[ユーザー]
  │ フォーム送信
  ▼
[Cloudflare Worker] ── Discord チャンネル作成
  │ 確認メール送信 (Reply-To: reply+{channelId}@domain)
  ▼
[ユーザーがメールに返信]
  │ reply+{channelId}@domain 宛に届く
  ▼
[Cloudflare Email Routing] ── Worker の email() ハンドラを呼び出す
  │ Discord チャンネルに返信内容を投稿
  ▼
[Discord スタッフが確認・/reply で返信]
  │ 返信メール (Reply-To: reply+{channelId}@domain)
  ▼
[ユーザー] ← またメールに返信できる（スレッド継続）
```

## 開発

```bash
npx wrangler dev
```

## 注意事項

- `RESEND_FROM_EMAIL` のドメインで Cloudflare Email Routing が有効になっている必要がある
- Resend の送信ドメインと受信ドメインは異なっていても構わないが、Reply-To のドメインは受信可能である必要がある
- 送信専用ドメイン（例: `noreply@send.example.com`）を使う場合は `REPLY_TO_DOMAIN` を受信側ドメインに設定する

## ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照。
