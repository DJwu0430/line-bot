// index.js (Render)
// Supports: user / group / room
// - store startISO in Google Sheet via Apps Script WebApp (GAS)
// - fallback to in-memory Map (Render free instance can reboot)
// - commands: 開始 / 重新開始 / 第12天 / 今天菜單 / 陪伴提醒 / 07:45..20:00 / debug-start / debug-sheet / 狀態

const fetch = require("node-fetch"); // v2
const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

// ===== LINE config (from Render env vars) =====
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

if (!config.channelSecret || !config.channelAccessToken) {
  console.log("[BOOT][WARN] Missing LINE_CHANNEL_SECRET or LINE_CHANNEL_ACCESS_TOKEN");
}

const app = express();
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

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

// ===== In-memory state (per targetId) =====
// key: targetId (string) => { startISO: "YYYY-MM-DD" }
const stateMap = new Map();

// ===== Helpers: Time (Taipei) =====
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
  const diff = today.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
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

// ===== Target (user/group/room) =====
function getTarget_(event) {
  const src = event.source || {};
  // src.type: "user" | "group" | "room"
  if (src.type === "group") return { targetType: "group", targetId: src.groupId };
  if (src.type === "room") return { targetType: "room", targetId: src.roomId };
  return { targetType: "user", targetId: src.userId };
}

// ===== State -> current day =====
function getCurrentDayAndType(targetId) {
  const st = stateMap.get(targetId);
  if (!st?.startISO) return null;

  const todayISO = getTodayISO_TW();
  const day = clampDay(daysBetweenISO(st.startISO, todayISO) + 1);
  const dayType = resolveDayType(day);
  return { day, dayType };
}

function getSafeCurrentDayAndType(targetId) {
  const cur = getCurrentDayAndType(targetId);
  if (!cur) return null;
  if (!Number.isFinite(cur.day) || cur.day < 1 || cur.day > 45) return null;
  if (!cur.dayType) return null;
  return cur;
}

// ===== Parse / manual day align =====
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

// ===== FAQ simple matcher =====
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
    "你可以這樣說 😊\n" +
    "1) 回「開始」：我會從今天幫你記錄 45 天進度（群組/1對1都可）\n" +
    "2) 回「第12天」：我可以直接對齊進度\n" +
    "3) 回「今天菜單」或「今天是哪一天」：我會告訴你今天第幾天＋日型＋重點\n" +
    "4) 回任一時間（如 08:00 / 12:00 / 18:00）：我回該時段菜單細節\n" +
    "5) 回「陪伴提醒」：我送你今天專屬的一句鼓勵\n" +
    "Debug：debug-start / debug-sheet"
  );
}

async function replyText(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

// ===== GAS (Google Apps Script WebApp) =====
// ENV required on Render:
// - GAS_URL: https://script.google.com/macros/s/xxxx/exec
// - GAS_KEY: same as Script Properties SECRET_KEY in GAS

function getGASEnv_() {
  const base = process.env.GAS_URL;
  const key = process.env.GAS_KEY;
  if (!base || !key) return null;
  return { base, key };
}

async function upsertTargetToSheet(targetType, targetId, startISO) {
  try {
    const env = getGASEnv_();
    if (!env) {
      console.log("[WARN] GAS_URL or GAS_KEY missing");
      return;
    }
    const { base, key } = env;

    const qs = new URLSearchParams({ key, startISO });

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
    const env = getGASEnv_();
    if (!env) return null;
    const { base, key } = env;

    const qs = new URLSearchParams({ action: "get", key });

    if (targetType === "group") qs.set("groupId", targetId);
    else if (targetType === "room") qs.set("roomId", targetId);
    else qs.set("userId", targetId);

    const url = `${base}?${qs.toString()}`;
    const r = await fetch(url);
    const txt = (await r.text()).trim();

    console.log("[GAS GET]", { status: r.status, txt });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) return null;
    return txt;
  } catch (e) {
    console.log("[WARN] getStartISOFromSheet failed:", e.message);
    return null;
  }
}

async function ensureStartISO(targetType, targetId) {
  const inMem = stateMap.get(targetId)?.startISO;
  if (inMem) return inMem;

  const fromSheet = await getStartISOFromSheet(targetType, targetId);
  if (fromSheet) {
    stateMap.set(targetId, { startISO: fromSheet });
    return fromSheet;
  }
  return null;
}

// ===== Webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("LINE Bot is running");
});

// ===== Main handler =====
async function handleEvent(event) {
  try {
    if (event.type !== "message" || event.message.type !== "text") return;

    const { targetType, targetId } = getTarget_(event);
    const text = (event.message.text || "").trim();

    console.log("[MSG]", { text, targetType, targetId });

    // Help
    if (text === "help" || text === "幫助" || text === "使用說明") {
      return replyText(event.replyToken, helpText());
    }

    // Status
    if (text === "狀態") {
      return replyText(
        event.replyToken,
        `today=${getTodayISO_TW()} | FAQ=${faqItems.length} | dayTypeMap=${Object.keys(dayTypeMap || {}).length} | menuTypes=${Object.keys(menuDetails || {}).length}`
      );
    }

    // Debug: show mem + sheet
    if (text === "debug-start") {
      const mem = stateMap.get(targetId)?.startISO || "(none)";
      const sheet = await getStartISOFromSheet(targetType, targetId);
      if (sheet) stateMap.set(targetId, { startISO: sheet });

      return replyText(
        event.replyToken,
        `today=${getTodayISO_TW()}\n` +
          `targetType=${targetType}\n` +
          `targetId=${targetId}\n` +
          `startISO(mem)=${mem}\n` +
          `startISO(sheet)=${sheet || "(none)"}`
      );
    }

    // Debug: raw sheet check (same as debug-start but shorter)
    if (text === "debug-sheet") {
      const sheet = await getStartISOFromSheet(targetType, targetId);
      return replyText(event.replyToken, `sheetStartISO=${sheet || "none"}`);
    }

    // Start
    if (text === "開始" || text.toLowerCase() === "start") {
      const existing = await ensureStartISO(targetType, targetId);

      if (existing) {
        const cur = getSafeCurrentDayAndType(targetId);
        return replyText(
          event.replyToken,
          `你已經在進行中囉 😊\n` +
            `今天是【第 ${cur.day} 天・${dayTypeLabel(cur.dayType)}】\n\n` +
            `如果你真的想重新從第 1 天開始，請回我「重新開始」。`
        );
      }

      const todayISO = getTodayISO_TW();
      stateMap.set(targetId, { startISO: todayISO });
      await upsertTargetToSheet(targetType, targetId, todayISO);

      const day = 1;
      const dayType = resolveDayType(day);
      const companion = companionByDay[String(day)] || "第一天最重要的不是完美，而是開始。";

      return replyText(
        event.replyToken,
        `已幫你從今天開始 ✅\n` +
          `今天是【第 ${day} 天・${dayTypeLabel(dayType)}】\n\n` +
          `💛 今日陪伴：${companion}`
      );
    }

    // Restart
    if (text === "重新開始") {
      const todayISO = getTodayISO_TW();
      stateMap.set(targetId, { startISO: todayISO });
      await upsertTargetToSheet(targetType, targetId, todayISO);

      return replyText(
        event.replyToken,
        "好，我已幫你重新從第 1 天開始 😊\n今天不用完美，我會陪你一起走。"
      );
    }

    // Manual day: 第12天
    const manualDayMatch = text.match(/^第\s*(\d{1,2})\s*天$/);
    if (manualDayMatch) {
      const inputDay = parseInt(manualDayMatch[1], 10);
      if (!Number.isFinite(inputDay) || inputDay < 1 || inputDay > 45) {
        return replyText(event.replyToken, "天數請輸入 1～45 之間 😊");
      }

      const startISO = buildStartISOFromDayInput(inputDay);
      stateMap.set(targetId, { startISO });
      await upsertTargetToSheet(targetType, targetId, startISO);

      const dayType = resolveDayType(inputDay);
      const companion = companionByDay[String(inputDay)] || "我們一步一步來就好 😊";

      return replyText(
        event.replyToken,
        `好，我已幫你對齊進度 ✅\n` +
          `今天是【第 ${inputDay} 天・${dayTypeLabel(dayType)}】\n\n` +
          `💛 今日陪伴：${companion}`
      );
    }

    // Today menu summary
    if (text === "今天菜單" || text === "今日菜單" || text.includes("今天是哪一天") || text === "今天是哪天") {
      await ensureStartISO(targetType, targetId);
      const cur = getSafeCurrentDayAndType(targetId);

      if (!cur) {
        return replyText(
          event.replyToken,
          "我可以幫你算今天第幾天與日型 😊\n請先回我「開始」，或告訴我你目前是第幾天（例如：第12天）。"
        );
      }

      const companion = companionByDay[String(cur.day)] || "今天不用完美，方向對就很好 😊";
      const msg =
        `今天是【第 ${cur.day} 天・${dayTypeLabel(cur.dayType)}】\n` +
        `${pushTemplates[cur.dayType] || ""}\n\n` +
        `💛 今日陪伴：${companion}\n\n` +
        "要看細節可以回我：\n07:45 / 08:00 / 10:00 / 11:45 / 12:00 / 14:00 / 16:00 / 17:45 / 18:00 / 20:00";
      return replyText(event.replyToken, msg);
    }

    // Companion reminder
    if (text === "陪伴提醒" || text === "鼓勵我" || text === "提醒我") {
      await ensureStartISO(targetType, targetId);
      const cur = getSafeCurrentDayAndType(targetId);

      if (!cur) {
        return replyText(
          event.replyToken,
          "我可以給你今天專屬的陪伴提醒 😊\n請先回我「開始」，或告訴我你目前是第幾天（例如：第12天）。"
        );
      }
      const companion = companionByDay[String(cur.day)] || "今天不用完美，方向對就很好 😊";
      return replyText(event.replyToken, companion);
    }

    // Time-slot details
    const timeMatch = text.match(/(07:45|08:00|10:00|11:45|12:00|14:00|16:00|17:45|18:00|20:00)/);
    if (timeMatch) {
      await ensureStartISO(targetType, targetId);
      const cur = getSafeCurrentDayAndType(targetId);

      if (!cur) {
        return replyText(
          event.replyToken,
          "我可以給你該時段菜單 😊\n請先回我「開始」，或告訴我你目前是第幾天（例如：第12天）。"
        );
      }

      const t = timeMatch[1];
      const slot = menuDetails?.[cur.dayType]?.[t];
      if (!slot) {
        return replyText(
          event.replyToken,
          `我查到你今天是【${dayTypeLabel(cur.dayType)}】，但目前這個時段沒有細節。\n你可以改問「今天菜單」。`
        );
      }

      const msg = `【第 ${cur.day} 天・${dayTypeLabel(cur.dayType)}】\n⏰ ${t}\n${slot}`;
      return replyText(event.replyToken, msg);
    }

    // FAQ
    const faqAns = matchFAQ(text);
    if (faqAns) return replyText(event.replyToken, faqAns);

    // Beverage quick catch
    if (text.includes("咖啡") || text.includes("茶") || text.includes("飲料") || text.includes("酒")) {
      return replyText(event.replyToken, "45 天計畫期間，茶、咖啡等刺激性飲料建議盡量不要，以白開水或溫水為主會最穩。");
    }

    // Fallback
    return replyText(
      event.replyToken,
      "我在這裡 😊\n你可以回：開始 / 第12天 / 今天菜單 / 今天是哪一天 / 08:00 / 12:00 / 18:00 / 陪伴提醒\n或打「使用說明」。"
    );
  } catch (err) {
    console.error("HANDLE EVENT ERROR:", err);
    try {
      if (event?.replyToken) {
        await replyText(event.replyToken, "我剛剛處理時遇到小問題，你可以再傳一次「開始」😊");
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
  console.log("[BOOT] GAS_URL set =", !!process.env.GAS_URL);
  console.log("[BOOT] GAS_KEY set =", !!process.env.GAS_KEY);
});
