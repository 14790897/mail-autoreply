# mail-autoreply

Cloudflare Email Worker that:
- saves every inbound email to KV,
- forwards a copy to a mailbox,
- auto-replies with a consent code, and
- sends the WeChat ID after a valid YES + code reply.

## Requirements
- Cloudflare Email Routing enabled for your domain.
- A KV namespace bound as `CONSENT_KV`. (use `wrangler kv namespace create "CONSENT_KV"`)
- Wrangler v4.

## Configure
1) Create a KV namespace and update `wrangler.jsonc`:
   - `kv_namespaces`: `{ "binding": "CONSENT_KV", "id": "<YOUR_KV_ID>" }`

2) Customize the reply content and forwarding target:
   - Configure via Wrangler env vars/secrets (read from `env`):
     - `FORWARD_TO`: mailbox to receive forwarded copies (required; if empty, forwarding is skipped)
     - `WECHAT`: WeChat ID sent after a valid `YES <code>` (recommended as a secret)
     - `TTL_SECONDS`: consent code TTL in seconds (default: `86400`)
     - `INFO_TEXT`: first auto-reply template (supports `<code>` placeholder; newlines can be `\n` or literal `\\n`)
   - Reply sender selection:
     - Default: uses the inbound recipient `message.to` as reply `from`
     - Optional: set `REPLY_FROM` to force a fixed sender
     - Optional: set `REPLY_FROM_BY_TO` (JSON string) to map recipient -> sender
   - Use `wrangler.jsonc` `vars` for non-sensitive values, and `npx wrangler secret put WECHAT` for sensitive values

3) Add Email Routing rules in Cloudflare:
   - Custom addresses (for example):
     - `linuxdo@sixiangjia.de`
     - `bilibili@sixiangjia.de`
     - `douyin@sixiangjia.de`
   - Action: "Send to a Worker"
   - Worker: `mail-autoreply`

## Development
```powershell
npm install
npm run dev
```

## Deploy
```powershell
npm run deploy
```

## Logs
```powershell
npx wrangler tail mail-autoreply --format pretty
```

## Behavior
- On first email from a sender, the worker sends an auto-reply containing a code.
- If the sender replies with `YES <code>`:
  - The worker replies with the WeChat ID.
- If the sender replies with `NO <code>`:
  - No further reply is sent.
- All inbound emails are saved in KV with keys like `email:<timestamp>:<uuid>`.
- A copy is forwarded to `FORWARD_TO`.
