require("dotenv").config();

/* ======================================================
AI SDK
====================================================== */
const OpenAI = require("openai");

/* ======================================================
Web / LINE
====================================================== */
const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

/* ======================================================
OpenAI
====================================================== */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ======================================================
AI cooldown
====================================================== */
const aiCooldown = new Map();

/* ======================================================
GAS env (依照你 Render 的名稱)
====================================================== */
const GAS_URL = process.env.GAS_URL;
const GAS_KEY = process.env.GAS_KEY;

/* ======================================================
OpenAI QA
====================================================== */
async function aiAnswer(question) {
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

  if (!vectorStoreId) {
    return "系統沒有設定資料庫。";
  }

  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "你是健康管理LINE機器人的問答模式。" +
            "你只能使用 file_search 找到的附件內容回答。" +
            "如果找不到答案就說：附件資料沒有提到這件事。",
        },
        { role: "user", content: question },
      ],
      tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
    });

    return resp.output_text || "附件資料沒有提到這件事。";
  } catch (err) {
    if (err?.status === 429) {
      return "我現在有點忙，20 秒後再問一次 😊";
    }
    throw err;
  }
}

/* ======================================================
fetch compat
====================================================== */
async function fetchCompat(url, options) {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch(url, options);
  }

  const mod = await import("node-fetch");
  return mod.default(url, options);
}

/* ======================================================
Google Sheet API
====================================================== */

async function gasGetStartISO(targetId, targetType = "user") {
  if (!GAS_URL || !GAS_KEY) {
    console.log("[GAS] missing env");
    return null;
  }

  const url =
    `${GAS_URL}?action=get` +
    `&key=${GAS_KEY}` +
    `&targetId=${targetId}` +
    `&targetType=${targetType}`;

  const resp = await fetchCompat(url);
  const text = (await resp.text()).trim();

  if (text === "none") return null;

  return text;
}

async function gasUpsertStartISO(targetId, targetType, startISO) {
  if (!GAS_URL || !GAS_KEY) {
    console.log("[GAS] missing env");
    return null;
  }

  const url =
    `${GAS_URL}?action=upsert` +
    `&key=${GAS_KEY}` +
    `&targetId=${targetId}` +
    `&targetType=${targetType}` +
    `&startISO=${startISO}`;

  const resp = await fetchCompat(url);
  const text = await resp.text();

  if (text !== "ok") {
    throw new Error(text);
  }
}

/* ======================================================
Date helpers
====================================================== */

function getTodayISO() {
  const tw = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" })
  );

  const yyyy = tw.getFullYear();
  const mm = String(tw.getMonth() + 1).padStart(2, "0");
  const dd = String(tw.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function calcDay(startISO) {
  const start = new Date(startISO);
  const today = new Date(getTodayISO());

  const diff =
    (today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

  return Math.floor(diff) + 1;
}

/* ======================================================
FAQ
====================================================== */

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
const faqItems = faqJSON.items || [];

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?]/g, "");
}

function matchFAQ(text) {
  const t = normalizeText(text);

  for (const item of faqItems) {
    const kws = item.keywords || [];

    for (const kw of kws) {
      if (t.includes(normalizeText(kw))) {
        return item.answer;
      }
    }
  }

  return null;
}

/* ======================================================
LINE config
====================================================== */

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);

/* ======================================================
ENV check
====================================================== */

console.log(
  "[ENV CHECK]",
  "LINE_CHANNEL_SECRET", process.env.LINE_CHANNEL_SECRET ? "SET" : "MISSING",
  "LINE_CHANNEL_ACCESS_TOKEN", process.env.LINE_CHANNEL_ACCESS_TOKEN ? "SET" : "MISSING",
  "OPENAI_API_KEY", process.env.OPENAI_API_KEY ? "SET" : "MISSING",
  "OPENAI_VECTOR_STORE_ID", process.env.OPENAI_VECTOR_STORE_ID ? "SET" : "MISSING",
  "GAS_URL", process.env.GAS_URL ? "SET" : "MISSING",
  "GAS_KEY", process.env.GAS_KEY ? "SET" : "MISSING"
);

/* ======================================================
Express
====================================================== */

const app = express();

/* ======================================================
reply
====================================================== */

async function replyText(replyToken, text) {
  return client.replyMessage(replyToken, [
    {
      type: "text",
      text: String(text).slice(0, 5000),
    },
  ]);
}

/* ======================================================
Webhook
====================================================== */

app.post("/webhook", line.middleware(config), (req, res) => {
  res.sendStatus(200);

  const events = req.body.events || [];

  Promise.allSettled(events.map(handleEvent)).then((results) => {
    console.log(
      "[EVENT RESULTS]",
      results.map((r) => r.status)
    );
  });
});

app.get("/", (_, res) => res.send("LINE BOT RUNNING"));

/* ======================================================
Main handler
====================================================== */

async function handleEvent(event) {
  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  console.log("[USER TEXT]", text);

  /* ===============================
  status
  =============================== */

  if (text === "status") {
    const gasReady = GAS_URL && GAS_KEY ? "OK" : "MISSING";

    return replyText(
      event.replyToken,
      `系統狀態\nGAS: ${gasReady}\nFAQ: ${faqItems.length}`
    );
  }

  /* ===============================
  設定開始日
  =============================== */

  if (text === "開始今天") {
    const today = getTodayISO();

    await gasUpsertStartISO(userId, "user", today);

    return replyText(
      event.replyToken,
      `開始日已設定為 ${today}`
    );
  }

  if (text === "我的開始日") {
    const start = await gasGetStartISO(userId, "user");

    if (!start) {
      return replyText(event.replyToken, "你還沒有設定開始日");
    }

    return replyText(event.replyToken, `你的開始日是 ${start}`);
  }

  /* ===============================
  第幾天
  =============================== */

  if (text.includes("第幾天")) {
    const start = await gasGetStartISO(userId, "user");

    if (!start) {
      return replyText(
        event.replyToken,
        "請先設定開始日，例如：開始今天"
      );
    }

    const day = calcDay(start);

    return replyText(
      event.replyToken,
      `今天是第 ${day} 天`
    );
  }

  /* ===============================
  FAQ
  =============================== */

  const faqAns = matchFAQ(text);

  if (faqAns) {
    return replyText(event.replyToken, faqAns);
  }

  /* ===============================
  AI
  =============================== */

  if (text.startsWith("請問")) {
    const last = aiCooldown.get(userId) || 0;
    const now = Date.now();

    if (now - last < 20000) {
      return replyText(
        event.replyToken,
        "我需要休息一下 😅 20 秒後再問我"
      );
    }

    aiCooldown.set(userId, now);

    const question = text.replace("請問", "").trim();

    const ans = await aiAnswer(question);

    return replyText(event.replyToken, ans);
  }

  /* ===============================
  default
  =============================== */

  return replyText(
    event.replyToken,
    "你可以輸入：\n開始今天\n第幾天\n我的開始日\nstatus"
  );
}

/* ======================================================
Server
====================================================== */

const port = process.env.PORT || 10000;

app.listen(port, () => {
  console.log("Server started on port", port);
  console.log("[BOOT] FAQ items =", faqItems.length);
});
