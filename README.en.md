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
   - Edit constants in `src/index.js`: `INFO_TEXT`, `FORWARD_TO`, `WECHAT`, `TTL_SECONDS`
   - Reply sender selection:
     - Default: uses the inbound recipient `message.to` as reply `from`
     - Optional: set `REPLY_FROM` to force a fixed sender
     - Optional: set `REPLY_FROM_BY_TO` (JSON string) to map recipient -> sender
   - If you prefer env vars/secrets, add `vars`/`secrets` in Wrangler and read them from `env` in code

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
