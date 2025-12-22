const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

// ===== LINE config (from Render env vars) =====
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const app = express();
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ===== Load knowledge files =====
function loadJSON(relPath) {
  const full = path.join(__dirname, relPath);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

const dayTypeMap = loadJSON("knowledge/day_type_map.json");
const menuDetails = loadJSON("knowledge/menu_details_by_day_type.json");
const pushTemplates = loadJSON("knowledge/push_templates.json");
const companionByDay = loadJSON("knowledge/companion_by_day.json");
const faqItems = loadJSON("knowledge/faq_50.json").items;

// ===== In-memory user state (MVP) =====
// ⚠ Render 免費版/重啟會清空。正式版建議接 Google Sheet/DB。
const userState = new Map(); // userId -> { startISO: "YYYY-MM-DD" }

// ===== Helpers =====
function getTodayISO_UTC() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysBetweenISO(startISO, todayISO) {
  const start = new Date(startISO + "T00:00:00Z");
  const today = new Date(todayISO + "T00:00:00Z");
  const diff = today - start;
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

function getCurrentDayAndType(userId) {
  const st = userState.get(userId);
  if (!st?.startISO) return null;

  const todayISO = getTodayISO_UTC();
  const day = clampDay(daysBetweenISO(st.startISO, todayISO) + 1);
  const dayType = resolveDayType(day);
  return { day, dayType };
}

function parseDayFromText(text) {
  // 支援：「第12天」「12天」「12」
  const m = (text || "").match(/(\d{1,2})/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n) || n < 1 || n > 45) return null;
  return n;
}

function buildStartISOFromDayInput(inputDay) {
  // 反推起始日：start = today - (inputDay - 1)
  const todayISO = getTodayISO_UTC();
  const today = new Date(todayISO + "T00:00:00Z");
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (inputDay - 1));
  const yyyy = start.getUTCFullYear();
  const mm = String(start.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(start.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function matchFAQ(text) {
  const t = (text || "").trim();
  if (!t) return null;

  let bestAns = null;
  let bestScore = 0;

  for (const item of faqItems) {
    let score = 0;
    for (const kw of item.keywords || []) {
      if (kw && t.includes(kw)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestAns = item.answer;
    }
  }
  return bestScore > 0 ? bestAns : null;
}

function helpText() {
  return (
    "你可以這樣用我 😊\n" +
    "1) 回「開始」：我會從今天幫你記錄 45 天進度\n" +
    "2) 回「第12天」：如果你已經在進行中，我可以直接對齊進度\n" +
    "3) 回「今天菜單」：我會告訴你今天第幾天＋日型＋重點提醒\n" +
    "4) 回任一時間（如 08:00 / 12:00 / 18:00）：我回該時段菜單細節\n" +
    "5) 回「陪伴提醒」：我送你今天專屬的一句鼓勵\n" +
    "也可以直接問外食、份量、嘴饞怎麼辦等問題"
  );
}

async function replyText(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
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
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const text = (event.message.text || "").trim();

  // Help
  if (text === "help" || text === "幫助" || text === "使用說明") {
    return replyText(event.replyToken, helpText());
  }

  // Start (Day 1 today)
  if (text === "開始" || text.toLowerCase() === "start") {
    const todayISO = getTodayISO_UTC();
    userState.set(userId, { startISO: todayISO });

    const day = 1;
    const dayType = resolveDayType(day);
    const companion = companionByDay[String(day)] || "今天不用完美，方向對就很好 😊";

    const msg =
      `已幫你從今天開始 ✅\n` +
      `今天是【第 ${day} 天・${dayTypeLabel(dayType)}】\n` +
      `${pushTemplates[dayType] || ""}\n\n` +
      `💛 今日陪伴：${companion}\n\n` +
      `你可以回我：\n- 今天菜單\n- 07:45 / 08:00 / 12:00 / 18:00（看時段細節）\n- 陪伴提醒\n- 第12天（對齊進度）`;
    return replyText(event.replyToken, msg);
  }

  // Set day manually (e.g., 第12天 / 12天)
  if (text.includes("天")) {
    const inputDay = parseDayFromText(text);
    if (inputDay) {
      const startISO = buildStartISOFromDayInput(inputDay);
      userState.set(userId, { startISO });

      const dayType = resolveDayType(inputDay);
      const companion = companionByDay[String(inputDay)] || "我們一步一步來就好 😊";

      const msg =
        `收到！我已把你進度設定為【第 ${inputDay} 天】✅\n` +
        `今天日型是【${dayTypeLabel(dayType)}】\n` +
        `${pushTemplates[dayType] || ""}\n\n` +
        `💛 今日陪伴：${companion}\n\n` +
        `你可以回我：今天菜單 / 08:00 / 12:00 / 18:00 / 陪伴提醒`;
      return replyText(event.replyToken, msg);
    }
  }

  // Today menu summary
  if (text === "今天菜單" || text === "今日菜單") {
    const cur = getCurrentDayAndType(userId);
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

  // Companion reminder (day-specific)
  if (text === "陪伴提醒" || text === "鼓勵我" || text === "提醒我") {
    const cur = getCurrentDayAndType(userId);
    if (!cur) {
      return replyText(
        event.replyToken,
        "我可以給你今天專屬的陪伴提醒 😊\n請先回我「開始」，或告訴我你目前是第幾天（例如：第12天）。"
      );
    }
    const companion = companionByDay[String(cur.day)] || "今天不用完美，方向對就很好 😊";
    return replyText(event.replyToken, companion);
  }

  // Time-slot menu details (accept "08:00" or "08:00 早餐")
  const timeMatch = text.match(/(07:45|08:00|10:00|11:45|12:00|14:00|16:00|17:45|18:00|20:00)/);
  if (timeMatch) {
    const cur = getCurrentDayAndType(userId);
    if (!cur) {
      return replyText(
        event.replyToken,
        "我可以給你該時段菜單 😊\n請先回我「開始」，或告訴我你目前是第幾天（例如：第12天）。"
      );
    }
    const t = timeMatch[1];
    const slot = menuDetails[cur.dayType]?.[t];
    if (!slot) {
      return replyText(
        event.replyToken,
        `我查到你今天是【${dayTypeLabel(cur.dayType)}】，但目前這個時段沒有細節。\n你可以改問「今天菜單」或「12:00」。`
      );
    }
    const msg = `【第 ${cur.day} 天・${dayTypeLabel(cur.dayType)}】\n⏰ ${t}\n${slot}`;
    return replyText(event.replyToken, msg);
  }

  // Beverage rule quick catch (even if FAQ misses)
  if (text.includes("咖啡") || text.includes("茶") || text.includes("飲料")) {
    return replyText(event.replyToken, "45 天計畫期間，茶、咖啡等刺激性飲料建議盡量不要，以白開水或溫水為主會最穩。");
  }

  // FAQ (keyword match)
  const faqAns = matchFAQ(text);
  if (faqAns) return replyText(event.replyToken, faqAns);

  // Fallback
  return replyText(
    event.replyToken,
    "我在這裡 😊\n你可以回：開始 / 第12天 / 今天菜單 / 08:00 / 12:00 / 18:00 / 陪伴提醒\n或打「使用說明」。"
  );
}

// ===== IMPORTANT: Render needs process.env.PORT =====
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server started on port", port);
});
