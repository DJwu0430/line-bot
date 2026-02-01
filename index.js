require("dotenv").config();

/* ======================================================
 * AI SDKs (OpenAI ONLY)
 * ====================================================== */
const OpenAI = require("openai");

/* ======================================================
 * Web / Utils
 * ====================================================== */
const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

/* ======================================================
 * OpenAI Client
 * ====================================================== */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ======================================================
 * AI 冷卻（避免打爆 Rate Limit）
 * ====================================================== */
const aiCooldown = new Map(); // key: targetId, value: lastCallTime(ms)

/* ======================================================
 * AI 問答（只用 OpenAI + file_search）
 * ====================================================== */
async function aiAnswer(question) {
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
  if (!vectorStoreId) {
    return "系統尚未設定資料庫（OPENAI_VECTOR_STORE_ID）。";
  }

  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "你是健康管理LINE機器人的問答模式。你只能使用 file_search 找到的附件內容回答。" +
            "若附件找不到相關資訊，請直接回答：『附件資料沒有提到這件事。』" +
            "回答語氣中性、確實、像人說話，國中生看得懂。" +
            "請用條列回答，每一點後面都要加上【引用】。" +
            "【引用】格式固定為：〔檔名｜摘錄〕（摘錄請用你看到的原文短句，不要自己編）。"
        },
        { role: "user", content: question },
      ],
      tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
    });

    return resp.output_text || "附件資料沒有提到這件事。";
  } catch (err) {
    if (err?.status === 429 || err?.code === "rate_limit_exceeded") {
      return "我剛剛太忙了（AI 請求次數達到上限）。你等 20 秒再問一次，我就能回答你 😊";
    }
    throw err;
  }
}

/* ======================================================
 * fetch 相容（Node 18 / Node 16）
 * ====================================================== */
async function fetchCompat(url, options) {
  if (typeof globalThis.fetch === "function") return globalThis.fetch(url, options);
  const mod = await import("node-fetch");
  return mod.default(url, options);
}

/* ======================================================
 * LINE 設定
 * ====================================================== */
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const app = express();

let client;
if (line.messagingApi?.MessagingApiClient) {
  client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: config.channelAccessToken,
  });
} else {
  client = new line.Client(config);
}

if (!config.channelSecret || !config.channelAccessToken) {
  console.error("[FATAL] LINE env missing");
  process.exit(1);
}

/* ======================================================
 * ENV CHECK
 * ====================================================== */
console.log(
  "[ENV CHECK]",
  "LINE_CHANNEL_SECRET", process.env.LINE_CHANNEL_SECRET ? "SET" : "MISSING",
  "LINE_CHANNEL_ACCESS_TOKEN", process.env.LINE_CHANNEL_ACCESS_TOKEN ? "SET" : "MISSING",
  "OPENAI_API_KEY", process.env.OPENAI_API_KEY ? "SET" : "MISSING",
  "OPENAI_VECTOR_STORE_ID", process.env.OPENAI_VECTOR_STORE_ID ? "SET" : "MISSING"
);

/* ======================================================
 * Load knowledge files
 * ====================================================== */
function safeLoadJSON(relPath, fallback) {
  try {
    const full = path.join(__dirname, relPath);
    if (!fs.existsSync(full)) return fallback;
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    return fallback;
  }
}

const faqJSON = safeLoadJSON("knowledge/faq_50.json", { items: [] });
const faqItems = Array.isArray(faqJSON.items) ? faqJSON.items : [];

/* ======================================================
 * FAQ matching（先命中 FAQ 再打 OpenAI）
 * - 你的 faq_50.json 建議結構：
 *   { "items":[ { "keywords":[...], "answer":"..." }, ... ] }
 * ====================================================== */
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?]/g, "");
}

function applySynonyms(t) {
  const rules = [
    ["今天哪一天", "今天是哪一天"],
    ["今天哪天", "今天是哪一天"],
    ["幾天", "第幾天"],
    ["喝茶", "茶"],
    ["咖啡因", "咖啡"],
    ["酒精", "酒"],
    ["手搖飲", "飲料"],
    ["珍珠奶茶", "珍奶"],
  ];
  let out = t;
  for (const [a, b] of rules) out = out.replaceAll(a, b);
  return out;
}

function matchFAQ(text) {
  let t = applySynonyms(normalizeText(text));
  if (!t) return null;

  let bestAns = null;
  let bestScore = 0;

  for (const item of faqItems || []) {
    const kws = item.keywords || [];
    if (!Array.isArray(kws) || !item.answer) continue;

    let score = 0;
    for (const kwRaw of kws) {
      const kw = applySynonyms(normalizeText(kwRaw));
      if (!kw) continue;
      if (t.includes(kw)) score += Math.min(3, Math.ceil(kw.length / 2));
    }

    if (score > bestScore) {
      bestScore = score;
      bestAns = item.answer;
    }
  }

  // 命中門檻：>=1（你可以改成 >=2 更保守）
  return bestScore >= 1 ? bestAns : null;
}

/* ======================================================
 * Helpers
 * ====================================================== */
function getTarget_(event) {
  const s = event.source || {};
  if (s.type === "group") return { targetType: "group", targetId: s.groupId };
  if (s.type === "room") return { targetType: "room", targetId: s.roomId };
  return { targetType: "user", targetId: s.userId };
}

async function replyText(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

/* ======================================================
 * Webhook
 * ====================================================== */
app.post("/webhook", line.middleware(config), (req, res) => {
  res.sendStatus(200);
  const events = req.body?.events || [];
  Promise.allSettled(events.map(handleEvent)).catch(() => {});
});

app.get("/", (_, res) => res.send("LINE Bot is running"));

/* ======================================================
 * Main handler
 * ====================================================== */
async function handleEvent(event) {
  try {
    if (event.type !== "message" || event.message.type !== "text") return;

    const { targetType, targetId } = getTarget_(event);
    let text = (event.message.text || "").trim();

    // UX：統一全形/半形符號
    text = text.replace(/[？]/g, "?").replace(/\s+/g, " ").trim();

    // 群組/room 只接受 # 指令
    if ((targetType === "group" || targetType === "room") && !text.startsWith("#")) return;
    if ((targetType === "group" || targetType === "room") && text.startsWith("#")) {
      text = text.slice(1).trim();
      if (!text) return;
    }

    // ✅ 1) 先命中 FAQ（任何輸入都先試）
    const faqAns = matchFAQ(text);
    if (faqAns) {
      return replyText(event.replyToken, faqAns);
    }

    // ✅ 2) FAQ 沒命中 → 只有「請問」才打 OpenAI
    if (text.startsWith("請問")) {
      const now = Date.now();
      const last = aiCooldown.get(targetId) || 0;

      if (now - last < 20000) {
        return replyText(event.replyToken, "我需要喘口氣 😅 20 秒後再問我一次就可以了！");
      }
      aiCooldown.set(targetId, now);

      const question = text.replace(/^請問\s*/, "").trim();
      if (!question) {
        return replyText(event.replyToken, "你可以這樣問我 😊\n例如：\n請問腸道健康跟什麼有關係？");
      }

      const ans = await aiAnswer(question);
      return replyText(event.replyToken, ans);
    }

    // ✅ 3) 其他非請問且 FAQ 沒中：回引導
    return replyText(
      event.replyToken,
      "我在這裡 😊\n你可以直接問我常見問題（例如：咖啡/酒/飲料/第幾天），或用「請問」開頭問我健康相關問題。"
    );
  } catch (err) {
    console.error("HANDLE EVENT ERROR:", err);
    try {
      if (event?.replyToken) {
        await replyText(event.replyToken, "我剛剛處理時遇到小問題，你可以再傳一次 😊");
      }
    } catch {}
  }
}

/* ======================================================
 * Server
 * ====================================================== */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server started on port", port);
  console.log("[BOOT] FAQ items =", faqItems.length);
});
