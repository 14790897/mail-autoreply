import { EmailMessage } from "cloudflare:email";
import { htmlToText } from "html-to-text";
import { createMimeMessage } from "mimetext";
import PostalMime from "postal-mime";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function parseTtlSeconds(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

function getInfoText(env) {
  const explicit = (env?.INFO_TEXT || "").trim();
  if (explicit) {
    // 允许在 vars/secrets 中用字面量 "\n" 表示换行（JSON 里常见写法）
    return explicit.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
  }

  return ['你好，这是一封自动回复邮件。', '', '如需获取我的微信号，请直接回复本邮件：', 'YES <code>', '', '（24小时内有效）'].join('\n');
}

function getWechatId(env) {
  return (env?.WECHAT || "").trim();
}

function getForwardTo(env) {
  return (env?.FORWARD_TO || "").trim();
}

function normalizeEmailAddress(address) {
  return (address || "").trim().toLowerCase();
}

function getReplyFromAddress(message, env) {
  const explicit = (env?.REPLY_FROM || "").trim();
  if (explicit) return explicit;

  const toAddress = (message?.to || "").trim();
  if (!toAddress) return "";

  const mappingRaw = (env?.REPLY_FROM_BY_TO || "").trim();
  if (mappingRaw) {
    try {
      const mapping = JSON.parse(mappingRaw);
      const mapped = mapping?.[normalizeEmailAddress(toAddress)];
      if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
    } catch (e) {
      console.log("email:reply_from_map_error", {
        message: e?.message || "",
        text: String(e || ""),
      });
    }
  }

  return toAddress;
}

function genCode() {
  // 简单随机码；够用来做一次性确认
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function normalizeChoice(text) {
  // 支持：YES / NO 以及中文：是 / 否（可按需删减）
  const t = (text || "").trim().toUpperCase();
  if (/\bYES\b/.test(t) || /(^|\s)是(\s|$)/.test(text || "")) return "YES";
  if (/\bNO\b/.test(t) || /(^|\s)否(\s|$)/.test(text || "")) return "NO";
  return null;
}

function extractCode(text) {
  // 从正文里抓一个类似 ABCD1234 的 token（我们生成的是 8 位字母数字）
  const m = (text || "").toUpperCase().match(/\b[A-Z0-9]{8}\b/);
  return m ? m[0] : null;
}

function getBodyText(parsed) {
  const plain = (parsed.text || "").trim();
  if (plain) return plain;
  const html = (parsed.html || "").trim();
  if (!html) return "";
  return htmlToText(html, { wordwrap: false });
}

function normalizeMessageId(id) {
  const raw = (id || "").trim();
  if (!raw) return "";
  const bracketed = raw.match(/<[^>]+>/);
  if (bracketed) return bracketed[0];
  return `<${raw}>`;
}

function buildReplyMessage({ from, to, subject, text, inReplyTo }) {
  const msg = createMimeMessage();
  msg.setSender({ addr: from });
  msg.setRecipient(to);
  msg.setSubject(subject);
  msg.addMessage({
    contentType: "text/plain",
    data: text,
  });
  const replyId = normalizeMessageId(inReplyTo);
  if (replyId) {
    msg.setHeader("In-Reply-To", replyId);
  }
  msg.setHeader("Auto-Submitted", "auto-replied");
  msg.setHeader("X-Auto-Response-Suppress", "All");
  return new EmailMessage(from, to, msg.asRaw());
}

export default {
  async email(message, env, ctx) {
    console.log("email:received", {
      from: message.from || "",
      to: message.to || "",
      subject: message.headers.get("Subject") || "",
      size: message.rawSize || 0,
    });
    // 0) 解析邮件正文（用 PostalMime）
    let parsed = { text: "" };
    let parseError = null;
    try {
      const rawSource =
        typeof message.raw === "function" ? await message.raw() : message.raw;
      parsed = await new PostalMime().parse(rawSource);
    } catch (e) {
      parseError = e;
      // 解析失败也可以继续，只是识别 YES/NO 可能不准
      parsed = { text: "" };
    }
    console.log("email:parse_meta", {
      contentType: message.headers.get("Content-Type") || "",
      rawType: typeof message.raw,
      parseError: parseError
        ? {
            name: parseError?.name || "",
            message: parseError?.message || "",
            text: String(parseError || ""),
          }
        : null,
      parsedKeys: Object.keys(parsed || {}),
      textLen: (parsed.text || "").length,
      htmlLen: (parsed.html || "").length,
    });

    // 1) 保存所有来信到 KV
    const emailId = crypto.randomUUID();
    const emailKey = `email:${Date.now()}:${emailId}`;
    const emailRecord = {
      id: emailId,
      storedAt: new Date().toISOString(),
      from: message.from || "",
      to: message.to || "",
      replyTo: message.replyTo || "",
      subject: message.headers.get("Subject") || "",
      headers: Array.from(message.headers.entries()),
      text: parsed.text || "",
      html: parsed.html || "",
    };
    ctx.waitUntil(env.CONSENT_KV.put(emailKey, JSON.stringify(emailRecord)));
    console.log("email:saved", { key: emailKey });

    // 2) 防循环：跳过自动邮件/群发列表
    const autoSubmitted = (message.headers.get("Auto-Submitted") || "").toLowerCase();
    const precedence = (message.headers.get("Precedence") || "").toLowerCase();
    if (autoSubmitted && autoSubmitted !== "no") return;
    if (["bulk", "junk", "list"].includes(precedence)) {
			console.log("email:dropped", { reason: "auto or bulk" });
			return;}

    // 3) 转发一份到收件箱，避免路由显示 Dropped
    const forwardTo = getForwardTo(env);
    if (forwardTo) {
      ctx.waitUntil(message.forward(forwardTo));
      console.log("email:forwarded", { to: forwardTo });
    } else {
      console.log("email:forward_skipped", { reason: "FORWARD_TO not set" });
    }

    // 4) 只回给来信者（reply 目标必须是来信发件人，官方也强调了相关限制/规则）
    // 优先 replyTo，否则 from
    const sender = message.replyTo || message.from;
    console.log("email:sender", { sender: sender || "" });
    if (!sender) return;

    const replyFrom = getReplyFromAddress(message, env);
    console.log("email:reply_from", { replyFrom: replyFrom || "", to: message.to || "" });
    if (!replyFrom) return;

    const bodyText = getBodyText(parsed);
    const choice = normalizeChoice(bodyText);
    const codeInMail = extractCode(bodyText);
    console.log("email:parsed", {
      choice: choice || "",
      codeInMail: codeInMail || "",
      textSize: bodyText.length,
    });

    // KV key：按发件人区分（足够满足“是否/否”授权这个场景）
    const key = `consent:${sender.toLowerCase()}`;
    const saved = await env.CONSENT_KV.get(key, { type: "json" });
    console.log("email:consent", { key, saved });
    const inReplyTo = message.headers.get("Message-ID") || parsed.messageId || "";
    console.log("email:reply_meta", { inReplyToRaw: inReplyTo });
    // saved: { code: "XXXXXXXX", stage: "PENDING" }

    // 5) 如果对方回复了 YES/NO 且带 code，并且 code 匹配 -> 执行动作
    if (saved?.stage === "PENDING" && codeInMail && codeInMail === saved.code && choice) {
      if (choice === "YES") {
        const replyMessage = buildReplyMessage({
          from: replyFrom,
          to: sender,
          subject: "已确认：微信号",
          text: (() => {
            const wechat = getWechatId(env);
            return wechat
              ? `好的，这是我的微信号：${wechat}\n\n（如需咨询/教学：100元/小时）`
              : "好的，但我还没有配置微信号（WECHAT）。";
          })(),
          inReplyTo,
        });
        try {
          await message.reply(replyMessage);
          console.log("email:replied", { to: sender, type: "wechat" });
        } catch (err) {
          console.log("email:reply_error", {
            to: sender,
            type: "wechat",
            error: {
              name: err?.name || "",
              message: err?.message || "",
              stack: err?.stack || "",
              text: String(err || ""),
            },
          });
        }

        // 用完即删，避免重复触发
        await env.CONSENT_KV.delete(key);
      } else {
        // NO：按你的要求，不发送任何邮件
        await env.CONSENT_KV.delete(key);
      }
      return;
    }

    // 6) 否则：当作“第一次来信” -> 发信息 + 给确认码
    // 如果已经 PENDING，就不要重复发（避免对方多次发你多次回）
    if (saved?.stage === "PENDING") return;

    const code = genCode();
    const ttlSeconds = parseTtlSeconds(env?.TTL_SECONDS);
    await env.CONSENT_KV.put(key, JSON.stringify({ stage: "PENDING", code }), {
      expirationTtl: ttlSeconds,
    });

    const firstReplyText = getInfoText(env).replaceAll("<code>", code);

    const firstReplyMessage = buildReplyMessage({
      from: replyFrom,
      to: sender,
      subject: "自动回复：咨询/教学说明（请确认是否需要微信）",
      text: firstReplyText,
      inReplyTo,
    });
    try {
      await message.reply(firstReplyMessage);
      console.log("email:replied", { to: sender, type: "first" });
    } catch (err) {
      console.log("email:reply_error", {
        to: sender,
        type: "first",
        error: {
          name: err?.name || "",
          message: err?.message || "",
          stack: err?.stack || "",
          text: String(err || ""),
        },
      });
    }
  },
};
