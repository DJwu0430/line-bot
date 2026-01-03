require("dotenv").config();

const OpenAI = require("openai");

const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
// ===== AI 問答冷卻時間（避免打爆 Rate Limit）=====
const aiCooldown = new Map(); // key: targetId , value: lastCallTime(ms)

async function aiAnswer(question) {
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
  if (!vectorStoreId) return "系統尚未設定資料庫（OPENAI_VECTOR_STORE_ID）。";

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
    // ✅ 429：RPM 用完
    if (err?.status === 429 || err?.code === "rate_limit_exceeded") {
      return "我剛剛太忙了（AI 請求次數達到上限）。你等 20 秒再問一次，我就能回答你 😊";
    }
    // 其他錯誤照拋出去，讓上層記錄 log
    throw err;
  }
}



// ===== LINE config (from Render env vars) =====
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const app = express();
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});
// 環境變數檢查（不要印出實際值）
console.log("[ENV CHECK]",
  "LINE_CHANNEL_SECRET", process.env.LINE_CHANNEL_SECRET ? "SET" : "MISSING",
  "LINE_CHANNEL_ACCESS_TOKEN", process.env.LINE_CHANNEL_ACCESS_TOKEN ? "SET" : "MISSING",
  "OPENAI_API_KEY", process.env.OPENAI_API_KEY ? "SET" : "MISSING",
  "OPENAI_VECTOR_STORE_ID", process.env.OPENAI_VECTOR_STORE_ID ? "SET" : "MISSING"
);

// ===== Load knowledge files (local) =====
function safeLoadJSON(relPath, fallback) {
  try {
    const full = path.join(__dirname, relPath);
    if (!fs.existsSync(full)) {
      console.log(`[WARN] Missing ${relPath} at ${full}`);
      return fallback;
    }
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    console.log(`[WARN] Failed to load ${relPath}:`, e.message);
    return fallback;
  }
}

const dayTypeMap = safeLoadJSON("knowledge/day_type_map.json", {});
const menuDetails = safeLoadJSON("knowledge/menu_details_by_day_type.json", {});
const pushTemplates = safeLoadJSON("knowledge/push_templates.json", {});
const companionByDay = safeLoadJSON("knowledge/companion_by_day.json", {});
const faqJSON = safeLoadJSON("knowledge/faq_50.json", { items: [] });
const faqItems = Array.isArray(faqJSON.items) ? faqJSON.items : [];

// ===== In-memory cache (Render restart will clear) =====
const startCache = new Map(); // cacheKey -> { startISO }

// ===== Helpers =====
function getTodayISO_TW() {
  const d = new Date();
  const tw = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const yyyy = tw.getFullYear();
  const mm = String(tw.getMonth() + 1).padStart(2, "0");
  const dd = String(tw.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysBetweenISO(startISO, todayISO) {
  const start = new Date(startISO + "T00:00:00");
  const today = new Date(todayISO + "T00:00:00");
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

function clampDay(day) {
  if (day < 1) return 1;
  if (day > 45) return 45;
  return day;
}

function resolveDayType(day) {
  return dayTypeMap[String(day)] || "SLIM";
}

function dayTypeLabel(dt) {
  const map = {
    PREP: "準備日",
    PROTEIN_CONSECUTIVE: "連續蛋白日",
    PROTEIN_SINGLE: "單日蛋白日",
    SLIM_FIRST: "第一次纖體日",
    SLIM: "纖體日",
    METABOLIC: "新陳代謝日",
  };
  return map[dt] || dt;
}

function getTarget_(event) {
  const src = event.source || {};
  if (src.type === "group") return { targetType: "group", targetId: src.groupId };
  if (src.type === "room") return { targetType: "room", targetId: src.roomId };
  return { targetType: "user", targetId: src.userId };
}

function cacheKey_(targetType, targetId) {
  return `${targetType}:${targetId}`;
}

function getCurrentDayAndTypeFromStartISO_(startISO) {
  if (!startISO) return null;
  const todayISO = getTodayISO_TW();
  const day = clampDay(daysBetweenISO(startISO, todayISO) + 1);
  if (!Number.isFinite(day)) return null;
  const dayType = resolveDayType(day);
  return { day, dayType };
}

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

  return bestScore >= 1 ? bestAns : null;
}

function helpText() {
  return (
    "你可以這樣試試看 😊\n" +
    "「開始」或「重新開始」，我將協助你開啟旅程\n" +
    "或是問我「今天的菜單」，\n" +
    "或是以「請問」為開頭問我健康相關的問題\n\n" +
    "📌 群組模式：請用 #開頭，例如 #今天菜單 / #開始 / #help"
  );
}

async function replyText(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

// ===== GAS bridge =====
// GAS_URL: https://script.google.com/macros/s/XXXX/exec
// GAS_KEY: 你的 SECRET_KEY
async function upsertTargetToSheet(targetType, targetId, startISO) {
  try {
    const base = process.env.GAS_URL;
    const key = process.env.GAS_KEY;
    if (!base || !key) {
      console.log("[WARN] GAS_URL or GAS_KEY missing");
      return;
    }

    // ✅ 同時送「新參數 + 舊參數」，確保 Apps Script 吃哪套都能 work
    const qs = new URLSearchParams({
      key,
      action: "upsert",
      startISO,
      targetId,          // 新版
      targetType         // 新版
    });

    // 舊版相容
    if (targetType === "group") qs.set("groupId", targetId);
    else if (targetType === "room") qs.set("roomId", targetId);
    else qs.set("userId", targetId);

    const url = `${base}?${qs.toString()}`;
    const r = await fetch(url);
    const txt = (await r.text()).trim();
    console.log("[GAS UPSERT]", { status: r.status, txt });
  } catch (e) {
    console.log("[WARN] upsertTargetToSheet failed:", e.message);
  }
}


async function getStartISOFromSheet(targetType, targetId) {
  try {
    const base = process.env.GAS_URL;
    const key = process.env.GAS_KEY;
    if (!base || !key) return null;

    // ✅ 同時送「新參數 + 舊參數」，避免 missing params
    const qs = new URLSearchParams({
      action: "get",
      key,
      targetId,          // 新版
      targetType         // 新版
    });

    // 舊版相容
    if (targetType === "group") qs.set("groupId", targetId);
    else if (targetType === "room") qs.set("roomId", targetId);
    else qs.set("userId", targetId);

    const url = `${base}?${qs.toString()}`;
    const r = await fetch(url);
    const txt = (await r.text()).trim();

    // ✅ 這行很重要：你之後看 log 就知道到底 Apps Script 吃到什麼
    console.log("[GAS GET]", { url, status: r.status, txt });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) return null;
    return txt;
  } catch (e) {
    console.log("[WARN] getStartISOFromSheet failed:", e.message);
    return null;
  }
}


async function ensureStartISO(targetType, targetId) {
  const key = cacheKey_(targetType, targetId);
  const inMem = startCache.get(key)?.startISO;
  if (inMem) return inMem;

  const fromSheet = await getStartISOFromSheet(targetType, targetId);
  if (fromSheet) {
    startCache.set(key, { startISO: fromSheet });
    return fromSheet;
  }
  return null;
}

function buildStartISOFromDayInput(inputDay) {
  const todayISO = getTodayISO_TW();
  const today = new Date(todayISO + "T00:00:00");
  const start = new Date(today);
  start.setDate(start.getDate() - (inputDay - 1));
  const yyyy = start.getFullYear();
  const mm = String(start.getMonth() + 1).padStart(2, "0");
  const dd = String(start.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ===== Webhook =====
app.post("/webhook", line.middleware(config), (req, res) => {
  res.sendStatus(200);

  const events = req.body?.events || [];
  console.log("[WEBHOOK HIT] events =", events.length);

  Promise.allSettled(events.map(handleEvent)).then((results) => {
    const rejected = results.filter((r) => r.status === "rejected");
    if (rejected.length) {
      console.error("[WEBHOOK] rejected count =", rejected.length);
      for (const r of rejected) console.error(r.reason);
    }
  });
});

app.get("/webhook", (req, res) => {
  console.log("[DEBUG] GET /webhook reached");
  return res.status(200).send("GET OK");
});




app.get("/", (req, res) => {
  res.send("LINE Bot is running");
});

// ===== Main handler =====
async function handleEvent(event) {
  try {
    if (event.type !== "message" || event.message.type !== "text") return;

    const { targetType, targetId } = getTarget_(event);
    let text = (event.message.text || "").trim();
    // ===== UX：統一全形/半形符號（正規化輸入）=====
text = text
  .replace(/[？]/g, "?")   // 全形問號 → 半形
  .replace(/\s+/g, " ")    // 多個空白 → 單一空白
  .trim();

      

    // ===== ✅ 方案B核心：群組/room 只接受 # 指令 =====
    if ((targetType === "group" || targetType === "room") && !text.startsWith("#")) {
      return; // 當作一般聊天，不回覆
    }
    if ((targetType === "group" || targetType === "room") && text.startsWith("#")) {
      text = text.slice(1).trim(); // 去掉 # 再走原本邏輯
      if (!text) return;
    }
    // ===== ✅ AI 問答模式：以「請問」開頭才走 =====
  if (text.startsWith("請問")) {
  // ===== AI 問答冷卻（避免打爆 Rate Limit）=====
  const now = Date.now();
  const last = aiCooldown.get(targetId) || 0;

  if (now - last < 20000) {
    return replyText(event.replyToken, "我需要喘口氣 😅 20 秒後再問我一次就可以了！");
  }

  // ⭐ 只有真的要打 OpenAI 才記錄時間
  aiCooldown.set(targetId, now);
    // 把「請問」拿掉，再交給 AI
  const question = text.replace(/^請問\s*/, "").trim();

  // UX：如果只打「請問」
  if (!question) {
    return replyText(
      event.replyToken,
      "你可以這樣問我 😊\n例如：\n請問腸道健康跟什麼有關係？"
    );
  }

  const answer = await aiAnswer(question);
  return replyText(event.replyToken, answer);
  }
    
    console.log("[MSG]", { text, targetType, targetId });

    if (text === "help" || text === "幫助" || text === "使用說明") {
      return replyText(event.replyToken, helpText());
    }

    if (text === "狀態") {
      return replyText(
        event.replyToken,
        `today=${getTodayISO_TW()} | FAQ=${faqItems.length} | dayTypeMap=${Object.keys(dayTypeMap || {}).length} | menuTypes=${Object.keys(menuDetails || {}).length}`
      );
    }

    if (text === "debug-start") {
      const mem = startCache.get(cacheKey_(targetType, targetId))?.startISO || "(none)";
      const sheet = await getStartISOFromSheet(targetType, targetId);
      if (sheet) startCache.set(cacheKey_(targetType, targetId), { startISO: sheet });

      return replyText(
        event.replyToken,
        `today=${getTodayISO_TW()}\n` +
          `targetType=${targetType}\n` +
          `targetId=${targetId}\n` +
          `startISO(mem)=${mem}\n` +
          `startISO(sheet)=${sheet || "(none)"}`
      );
    }

    // 開始：若已存在則提示；否則寫入今天
    if (text === "開始" || text.toLowerCase() === "start") {
      const existing = await ensureStartISO(targetType, targetId);
      if (existing) {
        const cur = getCurrentDayAndTypeFromStartISO_(existing);
        return replyText(
          event.replyToken,
          `你已經在進行中囉 😊\n今天是【第 ${cur.day} 天・${dayTypeLabel(cur.dayType)}】\n\n如果你真的想重新從第 1 天開始，請回我「重新開始」。`
        );
      }

      const todayISO = getTodayISO_TW();
      startCache.set(cacheKey_(targetType, targetId), { startISO: todayISO });
      await upsertTargetToSheet(targetType, targetId, todayISO);

      const cur = getCurrentDayAndTypeFromStartISO_(todayISO);
      const companion = companionByDay[String(cur.day)] || "第一天最重要的不是完美，而是開始。";

      return replyText(
        event.replyToken,
        `已幫你從今天開始 ✅\n今天是【第 ${cur.day} 天・${dayTypeLabel(cur.dayType)}】\n\n💛 今日陪伴：${companion}`
      );
    }

    if (text === "重新開始") {
      const todayISO = getTodayISO_TW();
      startCache.set(cacheKey_(targetType, targetId), { startISO: todayISO });
      await upsertTargetToSheet(targetType, targetId, todayISO);
      return replyText(event.replyToken, "好，我已幫你重新從第 1 天開始 😊\n今天不用完美，我會陪你一起走。");
    }

    // 手動對齊：第12天
    const manualDayMatch = text.match(/^第\s*(\d{1,2})\s*天$/);
    if (manualDayMatch) {
      const inputDay = parseInt(manualDayMatch[1], 10);
      if (inputDay < 1 || inputDay > 45) return replyText(event.replyToken, "天數請輸入 1～45 之間 😊");

      const startISO = buildStartISOFromDayInput(inputDay);
      startCache.set(cacheKey_(targetType, targetId), { startISO });
      await upsertTargetToSheet(targetType, targetId, startISO);

      const dayType = resolveDayType(inputDay);
      const companion = companionByDay[String(inputDay)] || "我們一步一步來就好 😊";

      return replyText(
        event.replyToken,
        `好，我已幫你對齊進度 ✅\n今天是【第 ${inputDay} 天・${dayTypeLabel(dayType)}】\n\n💛 今日陪伴：${companion}`
      );
    }

    // 今天菜單 / 今天是哪一天
    if (text === "今天菜單" || text === "今日菜單" || text.includes("今天是哪一天") || text === "今天是哪天") {
      const startISO = await ensureStartISO(targetType, targetId);
      if (!startISO) {
        return replyText(event.replyToken, "我可以幫你算今天第幾天與日型 😊\n請先回我「開始」，或告訴我你目前是第幾天（例如：第12天）。");
      }

      const cur = getCurrentDayAndTypeFromStartISO_(startISO);
      const companion = companionByDay[String(cur.day)] || "今天不用完美，方向對就很好 😊";

      const msg =
        `今天是【第 ${cur.day} 天・${dayTypeLabel(cur.dayType)}】\n` +
        `${pushTemplates[cur.dayType] || ""}\n\n` +
        `💛 今日陪伴：${companion}\n\n` +
        "要看細節可以回我：\n07:45 / 08:00 / 10:00 / 11:45 / 12:00 / 14:00 / 16:00 / 17:45 / 18:00 / 20:00";

      return replyText(event.replyToken, msg);
    }

    // 陪伴提醒
    if (text === "陪伴提醒" || text === "鼓勵我" || text === "提醒我") {
      const startISO = await ensureStartISO(targetType, targetId);
      if (!startISO) return replyText(event.replyToken, "請先回我「開始」，或告訴我你目前是第幾天（例如：第12天）。");

      const cur = getCurrentDayAndTypeFromStartISO_(startISO);
      const companion = companionByDay[String(cur.day)] || "今天不用完美，方向對就很好 😊";
      return replyText(event.replyToken, companion);
    }

    // 時段菜單
    const timeMatch = text.match(/(07:45|08:00|10:00|11:45|12:00|14:00|16:00|17:45|18:00|20:00)/);
    if (timeMatch) {
      const startISO = await ensureStartISO(targetType, targetId);
      if (!startISO) return replyText(event.replyToken, "請先回我「開始」，或告訴我你目前是第幾天（例如：第12天）。");

      const cur = getCurrentDayAndTypeFromStartISO_(startISO);
      const t = timeMatch[1];
      const slot = menuDetails[cur.dayType]?.[t];
      if (!slot) return replyText(event.replyToken, `我查到你今天是【${dayTypeLabel(cur.dayType)}】，但目前這個時段沒有細節。你可以改問「今天菜單」。`);

      return replyText(event.replyToken, `【第 ${cur.day} 天・${dayTypeLabel(cur.dayType)}】\n⏰ ${t}\n${slot}`);
    }

    // FAQ
    const faqAns = matchFAQ(text);
    if (faqAns) return replyText(event.replyToken, faqAns);

    // fallback
    return replyText(event.replyToken, "我在這裡 😊\n你可以回：「開始」 或 「今天菜單」或 以「請問」為開頭問我健康相關的問題 \n或打「使用說明」。");
  } catch (err) {
    console.error("HANDLE EVENT ERROR:", err);
    try {
      if (event?.replyToken) {
        await replyText(event.replyToken, "我剛剛處理時遇到小問題，你可以再傳一次 😊");
      }
    } catch (e2) {
      console.error("REPLY FAIL:", e2);
    }
    return;
  }
}

// ===== IMPORTANT: Render needs process.env.PORT =====
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server started on port", port);
  console.log("[BOOT] FAQ items =", faqItems.length);
  console.log("[BOOT] dayTypeMap keys =", Object.keys(dayTypeMap || {}).length);
});













