# mail-autoreply（中文说明）

English: `README.en.md`

这是一个 Cloudflare Email Worker，用于：
- 将每一封入站邮件保存到 Cloudflare KV
- 转发一份到指定邮箱（避免路由显示 Dropped，也方便人工查看）
- 首次来信自动回复一封“确认邮件”，内含一次性确认码
- 对方在 24 小时内回复 `YES <code>` 后，再发送微信号；回复 `NO <code>` 则不再发送

## 前置条件
- 你的域名已启用 Cloudflare Email Routing，并把某些地址路由到 Worker
- 已创建并绑定 KV 命名空间：`CONSENT_KV`
- Wrangler v4

## 配置
### 1) 绑定 KV
在 `wrangler.jsonc` 中配置 `kv_namespaces`（或用你自己的 KV id 覆盖现有 id）：

- `binding`: `CONSENT_KV`
- `id`: `<你的 KV id>`

创建 KV（示例）：
```powershell
npx wrangler kv namespace create "CONSENT_KV"
```

### 2) 修改自动回复内容/转发邮箱/微信号
当前版本把内容写在 `src/index.js` 的常量里（按需修改）：
- `INFO_TEXT`：首次自动回复的正文模板（其中 `<code>` 会被替换为确认码）
- `FORWARD_TO`：转发收件箱
- `WECHAT`：确认后发送的微信号
- `TTL_SECONDS`：确认码有效期（默认 24 小时）

另外，回信发件人支持“按收件邮箱自动对应”：
- 默认：自动用本次邮件的收件地址 `message.to` 作为回信 `from`
- 可选：设置 `REPLY_FROM` 强制固定发件人
- 可选：设置 `REPLY_FROM_BY_TO`（JSON 字符串）按收件地址映射，例如：
  - `{"bilibili@sixiangjia.de":"bilibili@sixiangjia.de","linuxdo@sixiangjia.de":"linuxdo@sixiangjia.de"}`

如果你希望用环境变量/密钥管理这些内容，建议通过 `wrangler.jsonc` 的 `vars` 或 `wrangler secret` 来做（并在代码里读取 `env`）。

### 3) 配置 Email Routing 规则
在 Cloudflare 控制台添加路由规则，例如：
- 自定义地址：`linuxdo@your-domain.com`、`bilibili@your-domain.com` 等
- 动作：Send to a Worker
- Worker：`mail-autoreply`

## 本地开发
```powershell
npm install
npm run dev
```

## 部署
```powershell
npm run deploy
```

## 查看日志
```powershell
npx wrangler tail mail-autoreply --format pretty
```

## 行为说明
- 每次收到邮件，都会写入 KV，key 类似：`email:<timestamp>:<uuid>`
- 会跳过自动邮件/群发列表邮件（例如 `Auto-Submitted`、`Precedence: bulk/junk/list`）
- 会将原邮件转发到 `FORWARD_TO`
- 对同一发件人：
  - 首次来信：发送一封含确认码的自动回复，并在 KV 写入 `consent:<sender>`（24 小时过期）
  - 在有效期内回复 `YES <code>`：发送微信号，并删除该 `consent` 记录
  - 在有效期内回复 `NO <code>`：不发送任何邮件，并删除该 `consent` 记录
  - 如果已经处于 `PENDING` 状态，会避免重复发送首次自动回复
