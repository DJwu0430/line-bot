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

// ✅ 用「安全載入」：讀不到也不會整個掛掉（會在 Render Logs 印錯）
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

// ✅ 真正把 knowledge 檔案讀進來（你原本缺少的就是這段）
const dayTypeMap = safeLoadJSON("knowledge/day_type_map.json", {});
const menuDetails = safeLoadJSON("knowledge/menu_details_by_day_type.json", {});
const pushTemplates = safeLoadJSON("knowledge/push_templates.json", {});
const companionByDay = safeLoadJSON("knowledge/companion_by_day.json", {});
const faqJSON = safeLoadJSON("knowledge/faq_50.json", { items: [] });
const faqItems = Array.isArray(faqJSON.items) ? faqJSON.items : [];

// ===== In-memory user state (MVP) =====
// ⚠ Render 免費版/重啟會清空。正式版建議接 Google Sheet/DB。
const userState = new Map(); // userId -> { startISO: "YYYY-MM-DD" }

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
  // 用「台灣時區」的日期差，避免 UTC 差一天
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

function getCurrentDayAndType(userId) {
  const st = userState.get(userId);
  if (!st?.startISO) return null;

  const todayISO = getTodayISO_TW();
  const day = clampDay(daysBetweenISO(st.startISO, todayISO) + 1);
  const dayType = resolveDayType(day);
  return { day, dayType };
}

function parseDayFromText(text) {
  const m = (text || "").match(/(\d{1,2})/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n) || n < 1 || n > 45) return null;
  return n;
}

function buildStartISOFromDayInput(inputDay) {
  // 反推起始日：start = today - (inputDay - 1)
  const todayISO = getTodayISO_TW();
  const today = new Date(todayISO + "T00:00:00");

  const start = new Date(today);
  start.setDate(start.getDate() - (inputDay - 1));

  const yyyy = start.getFullYear();
  const mm = String(start.getMonth() + 1).padStart(2, "0");
  const dd = String(start.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

      // 越長的 keyword 分數越高，避免短字亂命中
      if (t.includes(kw)) score += Math.min(3, Math.ceil(kw.length / 2));
    }

    if (score > bestScore) {
      bestScore = score;
      bestAns = item.answer;
    }
  }

    // ✅ 門檻：至少 1 分就回
  return bestScore >= 1 ? bestAns : null;
}

function helpText() {
  return (
    "你可以這樣說 😊\n" +
    "1) 回「開始」：我會從今天幫你記錄 45 天進度\n" +
    "2) 回「第12天」：如果你已經在進行中，我可以直接對齊進度\n" +
    "3) 回「今天菜單」或「今天是哪一天」：我會告訴你今天第幾天＋日型＋重點提醒\n" +
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
async function upsertUserToSheet(userId, startISO) {
  try {
    const base = process.env.GAS_URL; // https://script.google.com/macros/s/AKfycbwntXKiniu3AGLZFSqPW6pY4UoEkKqX1rDbIUZloRmpY-fO33B3Sgg-Wo-sTgal2oA5/exec
    const key = process.env.GAS_KEY;  // linebot_2025_secret_h.p.oY
    if (!base || !key) {
      console.log("[WARN] GAS_URL or GAS_KEY missing");
      return;
    }

    const url =
      `${base}?key=${encodeURIComponent(key)}` +
      `&userId=${encodeURIComponent(userId)}` +
      `&startISO=${encodeURIComponent(startISO)}`;

    const r = await fetch(url, { method: "GET" });
    const txt = await r.text();
    console.log("[GAS] status=", r.status, "body=", txt.slice(0, 120));
  } catch (e) {
    console.log("[WARN] upsertUserToSheet failed:", e.message);
  }
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

    const userId = event.source.userId;
    const text = (event.message.text || "").trim();

    console.log("[MSG]", { text, userId });

    // Help
    if (text === "help" || text === "幫助" || text === "使用說明") {
      return replyText(event.replyToken, helpText());
    }

    if (text === "狀態") {
  return replyText(
    event.replyToken,
    `today=${getTodayISO_TW()} | FAQ=${faqItems.length} | dayTypeMap=${Object.keys(dayTypeMap||{}).length} | menuTypes=${Object.keys(menuDetails||{}).length}`
  );
}
if (text === "debug-start") {
  const st = userState.get(userId);
  return replyText(
    event.replyToken,
    `today=${getTodayISO_TW()}\nstartISO(inMemory)=${st?.startISO || "(none)"}`
  );
}
    // Start
    if (text === "開始" || text.toLowerCase() === "start") {
        const todayISO = getTodayISO_TW();
        userState.set(userId, { startISO: todayISO });
        await upsertUserToSheet(userId, todayISO);



      const day = 1;
      const dayType = resolveDayType(day);
      const companion = companionByDay[String(day)] || "第一天最重要的不是完美，而是開始。你願意踏出這一步，本身就很棒了。";

      const msg =
        `已幫你從今天開始 ✅\n` +
        `今天是【第 ${day} 天・${dayTypeLabel(dayType)}】\n` +
        `${pushTemplates[dayType] || ""}\n\n` +
        `💛 今日陪伴：${companion}\n\n` +
        `你可以回我：\n- 今天菜單 / 今天是哪一天\n- 07:45 / 08:00 / 12:00 / 18:00（看時段細節）\n- 陪伴提醒\n- 第12天（對齊進度）`;
      return replyText(event.replyToken, msg);
    }

    // Set day manually
   if (text.includes("天")) {
  const inputDay = parseDayFromText(text);
   if (inputDay) {
      const startISO = buildStartISOFromDayInput(inputDay);
      userState.set(userId, { startISO });
      await upsertUserToSheet(userId, startISO); // 

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

    // Today menu summary (包含「今天是哪一天」)
    if (text === "今天菜單" || text === "今日菜單" || text.includes("今天是哪一天") || text === "今天是哪天") {
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

    // Companion reminder
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

    // Time-slot menu details
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
          `我查到你今天是【${dayTypeLabel(cur.dayType)}】，但目前這個時段沒有細節。\n你可以改問「今天菜單」。`
        );
      }
      const msg = `【第 ${cur.day} 天・${dayTypeLabel(cur.dayType)}】\n⏰ ${t}\n${slot}`;
      return replyText(event.replyToken, msg);
    }

    if (text.startsWith("FAQ測試")) {
  const q = text.replace("FAQ測試", "").trim();
  const t = applySynonyms(normalizeText(q));
  let best = { score: 0, ans: null, id: null };

  for (const item of faqItems || []) {
    let score = 0;
    for (const kwRaw of item.keywords || []) {
      const kw = applySynonyms(normalizeText(kwRaw));
      if (kw && t.includes(kw)) score += Math.min(3, Math.ceil(kw.length / 2));
    }
    if (score > best.score) best = { score, ans: item.answer, id: item.id };
  }

  return replyText(event.replyToken, `Q=${q}\nscore=${best.score}\nid=${best.id}\nans=${best.ans || "(no match)"}`);
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
    // 不要讓錯誤導致 webhook 整批失敗；也避免無回應
    try {
      if (event?.replyToken) {
        await replyText(event.replyToken, "我剛剛處理時遇到小問題，我已經記錄起來了。你可以再傳一次「開始」😊");
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


