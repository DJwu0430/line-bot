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
 * GAS / Google Sheet env
 * ====================================================== */
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const SECRET_KEY = process.env.SECRET_KEY;

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

    console.error("[OPENAI ERROR]", err?.response?.data || err?.message || err);
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
 * GAS / Google Sheet helpers
 * Apps Script doGet 規格：
 * - action=get
 * - action=upsert
 * ====================================================== */
async function gasGetStartISO(targetId, targetType = "user") {
  if (!GAS_WEB_APP_URL || !SECRET_KEY) {
    console.log("[GAS] missing env, skip get");
    return null;
  }

  const url =
    `${GAS_WEB_APP_URL}?action=get` +
    `&key=${encodeURIComponent(SECRET_KEY)}` +
    `&targetId=${encodeURIComponent(targetId)}` +
    `&targetType=${encodeURIComponent(targetType)}`;

  console.log("[GAS GET URL]", url);

  const resp = await fetchCompat(url, { method: "GET" });
  const text = (await resp.text()).trim();

  console.log("[GAS GET RESP]", text);

  if (text === "none") return null;
  if (text === "unauthorized") throw new Error("GAS unauthorized");
  if (text === "missing params") throw new Error("GAS missing params");
  if (text.startsWith("error:")) throw new Error(text);

  return text;
}

async function gasUpsertStartISO(targetId, targetType = "user", startISO) {
  if (!GAS_WEB_APP_URL || !SECRET_KEY) {
    console.log("[GAS] missing env, skip upsert");
    return null;
  }

  const url =
    `${GAS_WEB_APP_URL}?action=upsert` +
    `&key=${encodeURIComponent(SECRET_KEY)}` +
    `&targetId=${encodeURIComponent(targetId)}` +
    `&targetType=${encodeURIComponent(targetType)}` +
    `&startISO=${encodeURIComponent(startISO)}`;

  console.log("[GAS UPSERT URL]", url);

  const resp = await fetchCompat(url, { method: "GET" });
  const text = (await resp.text()).trim();

  console.log("[GAS UPSERT RESP]", text);

  if (text !== "ok") {
    throw new Error(`GAS upsert failed: ${text}`);
  }

  return text;
}

function getTodayISOInTaipei() {
  const tw = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const yyyy = tw.getFullYear();
  const mm = String(tw.getMonth() + 1).padStart(2, "0");
  const dd = String(tw.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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
  "OPENAI_VECTOR_STORE_ID", process.env.OPENAI_VECTOR_STORE_ID ? "SET" : "MISSING",
  "GAS_WEB_APP_URL", process.env.GAS_WEB_APP_URL ? "SET" : "MISSING",
  "SECRET_KEY", process.env.SECRET_KEY ? "SET" : "MISSING"
);

/* ======================================================
 * Load knowledge files
 * ====================================================== */
function safeLoadJSON(relPath, fallback) {
  try {
    const full = path.join(__dirname, relPath);
    if (!fs.existsSync(full)) return fallback;
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (err) {
    console.error("[JSON LOAD ERROR]", relPath, err?.message || err);
    return fallback;
  }
}

const faqJSON = safeLoadJSON("knowledge/faq_50.json", { items: [] });
const faqItems = Array.isArray(faqJSON.items) ? faqJSON.items : [];

/* ======================================================
 * FAQ matching（先命中 FAQ 再打 OpenAI）
 * - faq_50.json 建議結構：
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
  const t = applySynonyms(normalizeText(text));
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
  if (!replyToken) return;

  if (line.messagingApi?.ReplyMessageRequest) {
    return client.replyMessage({
      replyToken,
      messages: [{ type: "text", text }],
    });
  }

  return client.replyMessage(replyToken, [{ type: "text", text }]);
}

/* ======================================================
 * Webhook
 * ====================================================== */
app.post("/webhook", line.middleware(config), (req, res) => {
  console.log("[WEBHOOK HIT]");
  console.log("[BODY]", JSON.stringify(req.body));

  res.sendStatus(200);

  const events = req.body?.events || [];
  Promise.allSettled(events.map(handleEvent))
    .then((results) => {
      console.log("[EVENT RESULTS]", JSON.stringify(results.map(r => r.status)));
    })
    .catch((err) => {
      console.error("[WEBHOOK HANDLE ERROR]", err?.message || err);
    });
});

app.get("/", (_, res) => res.send("LINE Bot is running"));

/* ======================================================
 * Main handler
 * ====================================================== */
async function handleEvent(event) {
  try {
    console.log("[EVENT]", JSON.stringify(event));

    if (event.type !== "message" || event.message.type !== "text") {
      console.log("[SKIP] not text message");
      return;
    }

    const { targetType, targetId } = getTarget_(event);
    let text = (event.message.text || "").trim();

    console.log("[TARGET]", targetType, targetId);
    console.log("[USER TEXT RAW]", text);

    // UX：統一全形/半形符號
    text = text.replace(/[？]/g, "?").replace(/\s+/g, " ").trim();
    console.log("[USER TEXT NORMALIZED]", text);

    // 群組/room 只接受 # 指令
    if ((targetType === "group" || targetType === "room") && !text.startsWith("#")) {
      console.log("[SKIP] group/room message without #");
      return;
    }

    if ((targetType === "group" || targetType === "room") && text.startsWith("#")) {
      text = text.slice(1).trim();
      if (!text) {
        console.log("[SKIP] empty command after #");
        return;
      }
    }

    // ✅ 指令：開始今天
    if (text === "開始今天") {
      const startISO = getTodayISOInTaipei();

      try {
        await gasUpsertStartISO(targetId, targetType, startISO);
        return replyText(event.replyToken, `好喔！我已幫你設定開始日為 ${startISO} 😊`);
      } catch (err) {
        console.error("[GAS UPSERT ERROR]", err?.message || err);
        return replyText(event.replyToken, "我有收到你的設定，但寫入 Google Sheet 時失敗了，請再試一次。");
      }
    }

    // ✅ 指令：開始 YYYY-MM-DD
    const startMatch = text.match(/^開始\s*(\d{4}-\d{2}-\d{2})$/);
    if (startMatch) {
      const startISO = startMatch[1];

      try {
        await gasUpsertStartISO(targetId, targetType, startISO);
        return replyText(event.replyToken, `好喔！我已幫你設定開始日為 ${startISO} 😊`);
      } catch (err) {
        console.error("[GAS UPSERT ERROR]", err?.message || err);
        return replyText(event.replyToken, "我有收到你的設定，但寫入 Google Sheet 時失敗了，請再試一次。");
      }
    }

    // ✅ 指令：查詢開始日
    if (text === "我的開始日" || text === "查詢開始日") {
      try {
        const startISO = await gasGetStartISO(targetId, targetType);
        if (!startISO) {
          return replyText(event.replyToken, "你目前還沒有設定開始日。你可以傳：開始今天 或 開始 2026-03-11");
        }
        return replyText(event.replyToken, `你目前的開始日是 ${startISO}`);
      } catch (err) {
        console.error("[GAS GET ERROR]", err?.message || err);
        return replyText(event.replyToken, "我剛剛查詢 Google Sheet 時失敗了，請再試一次。");
      }
    }

    // ✅ 1) 先命中 FAQ
    const faqAns = matchFAQ(text);
    if (faqAns) {
      console.log("[FAQ HIT]");
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
        return replyText(
          event.replyToken,
          "你可以這樣問我 😊\n例如：\n請問腸道健康跟什麼有關係？"
        );
      }

      const ans = await aiAnswer(question);
      return replyText(event.replyToken, ans);
    }

    // ✅ 3) 其他非請問且 FAQ 沒中：回引導
    return replyText(
      event.replyToken,
      "我在這裡 😊\n你可以：\n1. 傳「開始今天」\n2. 傳「開始 2026-03-11」\n3. 傳「我的開始日」\n4. 直接問常見問題（例如：咖啡、酒、飲料、第幾天）\n5. 用「請問」開頭問我健康相關問題"
    );
  } catch (err) {
    console.error("[HANDLE EVENT ERROR]", err?.response?.data || err?.message || err);

    try {
      if (event?.replyToken) {
        await replyText(event.replyToken, "我剛剛處理時遇到小問題，你可以再傳一次 😊");
      }
    } catch (replyErr) {
      console.error("[REPLY FAIL AFTER ERROR]", replyErr?.message || replyErr);
    }
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
