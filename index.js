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

// 保留同名介面，讓 handleEvent 不用改
async function aiAnswerSmart(question) {
  return await aiAnswer(question);
}

/* ======================================================
 * fetch 相容（Node 18 / Node 16）
 * ====================================================== */
async function fetchCompat(url, options) {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch(url, options);
  }
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

const dayTypeMap = safeLoadJSON("knowledge/day_type_map.json", {});
const menuDetails = safeLoadJSON("knowledge/menu_details_by_day_type.json", {});
const pushTemplates = safeLoadJSON("knowledge/push_templates.json", {});
const companionByDay = safeLoadJSON("knowledge/companion_by_day.json", {});
const faqJSON = safeLoadJSON("knowledge/faq_50.json", { items: [] });
const faqItems = Array.isArray(faqJSON.items) ? faqJSON.items : [];

/* ======================================================
 * In-memory cache
 * ====================================================== */
const startCache = new Map();

/* ======================================================
 * Helper functions
 * ====================================================== */
function getTodayISO_TW() {
  const d = new Date();
  const tw = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  return tw.toISOString().slice(0, 10);
}

function daysBetweenISO(startISO, todayISO) {
  const s = new Date(startISO + "T00:00:00");
  const t = new Date(todayISO + "T00:00:00");
  return Math.floor((t - s) / 86400000);
}

function clampDay(d) {
  return Math.min(45, Math.max(1, d));
}

function resolveDayType(day) {
  return dayTypeMap[String(day)] || "SLIM";
}

function dayTypeLabel(dt) {
  return {
    PREP: "準備日",
    PROTEIN_CONSECUTIVE: "連續蛋白日",
    PROTEIN_SINGLE: "單日蛋白日",
    SLIM_FIRST: "第一次纖體日",
    SLIM: "纖體日",
    METABOLIC: "新陳代謝日",
  }[dt] || dt;
}

function getTarget_(event) {
  const s = event.source || {};
  if (s.type === "group") return { targetType: "group", targetId: s.groupId };
  if (s.type === "room") return { targetType: "room", targetId: s.roomId };
  return { targetType: "user", targetId: s.userId };
}

function cacheKey_(t, id) {
  return `${t}:${id}`;
}

function getCurrentDayAndTypeFromStartISO_(startISO) {
  if (!startISO) return null;
  const today = getTodayISO_TW();
  const day = clampDay(daysBetweenISO(startISO, today) + 1);
  return { day, dayType: resolveDayType(day) };
}

/* ======================================================
 * GAS bridge
 * ====================================================== */
async function upsertTargetToSheet(targetType, targetId, startISO) {
  try {
    if (!process.env.GAS_URL || !process.env.GAS_KEY) return;

    const qs = new URLSearchParams({
      key: process.env.GAS_KEY,
      action: "upsert",
      targetType,
      targetId,
      startISO,
    });

    const url = `${process.env.GAS_URL}?${qs.toString()}`;
    await fetchCompat(url);
  } catch {}
}

async function getStartISOFromSheet(targetType, targetId) {
  try {
    if (!process.env.GAS_URL || !process.env.GAS_KEY) return null;

    const qs = new URLSearchParams({
      key: process.env.GAS_KEY,
      action: "get",
      targetType,
      targetId,
    });

    const url = `${process.env.GAS_URL}?${qs.toString()}`;
    const r = await fetchCompat(url);
    const txt = (await r.text()).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(txt) ? txt : null;
  } catch {
    return null;
  }
}

/* ======================================================
 * Webhook
 * ====================================================== */
app.post("/webhook", line.middleware(config), (req, res) => {
  res.sendStatus(200);
  const events = req.body?.events || [];
  events.forEach(handleEvent);
});

app.get("/", (_, res) => res.send("LINE Bot is running"));

/* ======================================================
 * Main handler
 * ====================================================== */
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const { targetType, targetId } = getTarget_(event);
  let text = (event.message.text || "").trim();

  if ((targetType === "group" || targetType === "room") && !text.startsWith("#")) return;
  if (text.startsWith("#")) text = text.slice(1).trim();

  // AI 問答
  if (text.startsWith("請問")) {
    const now = Date.now();
    const last = aiCooldown.get(targetId) || 0;
    if (now - last < 20000) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: "我需要喘口氣 😅 20 秒後再問我一次就可以了！" }],
      });
    }
    aiCooldown.set(targetId, now);

    const q = text.replace(/^請問\s*/, "").trim();
    if (!q) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: "例如：請問腸道健康跟什麼有關係？" }],
      });
    }

    const ans = await aiAnswerSmart(q);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: ans }],
    });
  }
}

/* ======================================================
 * Server
 * ====================================================== */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server started on port", port);
});
