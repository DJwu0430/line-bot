require("dotenv").config();

/* ======================================================
 * AI SDK
 * ====================================================== */
const OpenAI = require("openai");

/* ======================================================
 * Web / LINE
 * ====================================================== */
const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

/* ======================================================
 * OpenAI
 * ====================================================== */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ======================================================
 * AI cooldown
 * ====================================================== */
const aiCooldown = new Map();

/* ======================================================
 * GAS env
 * 依照你現在 Render 的名稱：
 * - GAS_URL
 * - GAS_KEY
 * ====================================================== */
const GAS_URL = process.env.GAS_URL;
const GAS_KEY = process.env.GAS_KEY;

/* ======================================================
 * OpenAI QA
 * ====================================================== */
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
            "如果找不到答案就說：附件資料沒有提到這件事。"
        },
        { role: "user", content: question },
      ],
      tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
    });

    return resp.output_text || "附件資料沒有提到這件事。";
  } catch (err) {
    if (err?.status === 429 || err?.code === "rate_limit_exceeded") {
      return "我現在有點忙，20 秒後再問一次 😊";
    }

    console.error("[OPENAI ERROR]", err?.response?.data || err?.message || err);
    throw err;
  }
}

/* ======================================================
 * fetch compat
 * ====================================================== */
async function fetchCompat(url, options) {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch(url, options);
  }

  const mod = await import("node-fetch");
  return mod.default(url, options);
}

/* ======================================================
 * Google Apps Script API
 * ====================================================== */
async function gasGetStartISO(targetId, targetType = "user") {
  if (!GAS_URL || !GAS_KEY) {
    console.log("[GAS] missing env");
    return null;
  }

  const url =
    `${GAS_URL}?action=get` +
    `&key=${encodeURIComponent(GAS_KEY)}` +
    `&targetId=${encodeURIComponent(targetId)}` +
    `&targetType=${encodeURIComponent(targetType)}`;

  console.log("[GAS GET URL]", url);

  const resp = await fetchCompat(url, { method: "GET" });
  const text = (await resp.text()).trim();

  console.log("[GAS GET RESP]", text);

  if (text === "none") return null;
  if (text === "unauthorized") throw new Error("GAS unauthorized");
  if (text === "missing params") throw new Error("GAS missing params");
  if (text === "bad startISO") throw new Error("GAS bad startISO");
  if (text.startsWith("error:")) throw new Error(text);

  return text;
}

async function gasUpsertStartISO(targetId, targetType = "user", startISO) {
  if (!GAS_URL || !GAS_KEY) {
    console.log("[GAS] missing env");
    return null;
  }

  const url =
    `${GAS_URL}?action=upsert` +
    `&key=${encodeURIComponent(GAS_KEY)}` +
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

/* ======================================================
 * Date helpers
 * ====================================================== */
function getTodayISO() {
  const tw = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" })
  );

  const yyyy = tw.getFullYear();
  const mm = String(tw.getMonth() + 1).padStart(2, "0");
  const dd = String(tw.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function isValidISODate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00`);
  return !Number.isNaN(d.getTime());
}

function calcDay(startISO) {
  const start = new Date(`${startISO}T00:00:00`);
  const today = new Date(`${getTodayISO()}T00:00:00`);

  const diffDays = Math.floor(
    (today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
  );

  return diffDays + 1;
}

/* ======================================================
 * FAQ
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
 * LINE config
 * ====================================================== */
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

if (!config.channelSecret || !config.channelAccessToken) {
  console.error("[FATAL] LINE env missing");
  process.exit(1);
}

const client = new line.Client(config);

/* ======================================================
 * ENV check
 * ====================================================== */
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
 * Express
 * ====================================================== */
const app = express();

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

  return client.replyMessage(replyToken, [
    {
      type: "text",
      text: String(text || "").slice(0, 5000),
    },
  ]);
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
      console.log("[EVENT RESULTS]", results.map((r) => r.status));

      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(
            `[EVENT ${i} REJECTED]`,
            r.reason?.response?.data || r.reason?.message || r.reason
          );
        }
      });
    })
    .catch((err) => {
      console.error("[WEBHOOK HANDLE ERROR]", err?.message || err);
    });
});

app.get("/", (_, res) => res.send("LINE BOT RUNNING"));

/* ======================================================
 * Main handler
 * ====================================================== */
async function handleEvent(event) {
  console.log("[EVENT]", JSON.stringify(event));

  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const { targetType, targetId } = getTarget_(event);
  const text = (event.message.text || "").trim();

  console.log("[TARGET]", targetType, targetId);
  console.log("[USER TEXT]", text);

  /* ===============================
   * status
   * =============================== */
  if (text === "status") {
    const gasReady = GAS_URL && GAS_KEY ? "OK" : "MISSING";
    return replyText(
      event.replyToken,
      `系統狀態\nGAS: ${gasReady}\nFAQ: ${faqItems.length}`
    );
  }

  /* ===============================
   * 設定開始日
   * =============================== */
  if (text === "開始今天") {
    const today = getTodayISO();

    try {
      await gasUpsertStartISO(targetId, targetType, today);
      return replyText(event.replyToken, `開始日已設定為 ${today}`);
    } catch (err) {
      console.error("[START TODAY ERROR]", err?.message || err);
      return replyText(
        event.replyToken,
        "我有收到你的設定，但寫入 Google Sheet 時失敗了，請再試一次。"
      );
    }
  }

  const startMatch = text.match(/^開始\s*(\d{4}-\d{2}-\d{2})$/);
  if (startMatch) {
    const startISO = startMatch[1];

    if (!isValidISODate(startISO)) {
      return replyText(
        event.replyToken,
        "日期格式不正確，請用這種格式：開始 2026-03-11"
      );
    }

    try {
      await gasUpsertStartISO(targetId, targetType, startISO);
      return replyText(event.replyToken, `開始日已設定為 ${startISO}`);
    } catch (err) {
      console.error("[SET START DATE ERROR]", err?.message || err);
      return replyText(
        event.replyToken,
        "我有收到你的設定，但寫入 Google Sheet 時失敗了，請再試一次。"
      );
    }
  }

  if (text === "我的開始日") {
    try {
      const start = await gasGetStartISO(targetId, targetType);

      if (!start) {
        return replyText(event.replyToken, "你還沒有設定開始日");
      }

      return replyText(event.replyToken, `你的開始日是 ${start}`);
    } catch (err) {
      console.error("[GET START DATE ERROR]", err?.message || err);
      return replyText(
        event.replyToken,
        "我剛剛查詢開始日時失敗了，請再試一次。"
      );
    }
  }

  /* ===============================
   * 第幾天
   * =============================== */
  if (text.includes("第幾天")) {
    try {
      const start = await gasGetStartISO(targetId, targetType);

      if (!start) {
        return replyText(
          event.replyToken,
          "請先設定開始日，例如：開始今天"
        );
      }

      const day = calcDay(start);

      if (day < 1) {
        return replyText(
          event.replyToken,
          `你的開始日是 ${start}，今天還沒到開始日。`
        );
      }

      return replyText(event.replyToken, `今天是第 ${day} 天`);
    } catch (err) {
      console.error("[CALC DAY ERROR]", err?.message || err);
      return replyText(
        event.replyToken,
        "我剛剛計算第幾天時失敗了，請再試一次。"
      );
    }
  }

  /* ===============================
   * FAQ
   * =============================== */
  const faqAns = matchFAQ(text);
  if (faqAns) {
    return replyText(event.replyToken, faqAns);
  }

  /* ===============================
   * AI
   * =============================== */
  if (text.startsWith("請問")) {
    const last = aiCooldown.get(targetId) || 0;
    const now = Date.now();

    if (now - last < 20000) {
      return replyText(
        event.replyToken,
        "我需要休息一下 😅 20 秒後再問我"
      );
    }

    aiCooldown.set(targetId, now);

    const question = text.replace(/^請問/, "").trim();

    if (!question) {
      return replyText(
        event.replyToken,
        "你可以這樣問我：\n請問今天可以喝咖啡嗎？"
      );
    }

    try {
      const ans = await aiAnswer(question);
      return replyText(event.replyToken, ans);
    } catch (err) {
      console.error("[AI ANSWER ERROR]", err?.message || err);
      return replyText(
        event.replyToken,
        "我剛剛查資料時遇到問題，你可以再問我一次 😊"
      );
    }
  }

  /* ===============================
   * default
   * =============================== */
  return replyText(
    event.replyToken,
    "你可以輸入：\nstatus\n開始今天\n開始 2026-03-11\n我的開始日\n第幾天"
  );
}

/* ======================================================
 * Server
 * ====================================================== */
const port = process.env.PORT || 10000;

app.listen(port, () => {
  console.log("Server started on port", port);
  console.log("[BOOT] FAQ items =", faqItems.length);
});
