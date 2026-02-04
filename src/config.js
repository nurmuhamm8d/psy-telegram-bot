const parseIntStrict = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n))
    throw new Error(`${name} is required and must be a number`);
  return n;
};

const parseCsvInts = (v) => {
  if (!v) return [];
  return String(v)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
};

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

const ADMIN_GROUP_ID = parseIntStrict(
  process.env.ADMIN_GROUP_ID,
  "ADMIN_GROUP_ID",
);
const OPERATOR_IDS = parseCsvInts(process.env.OPERATOR_IDS);

const DROP_PENDING_UPDATES =
  String(process.env.DROP_PENDING_UPDATES || "0") === "1";
const SEND_EXCEL_TO_TELEGRAM =
  String(process.env.SEND_EXCEL_TO_TELEGRAM || "0") === "1";

const BOT_DESCRIPTION =
  "Егер көңілің түсіп жүрсе, қорқып жүрсең немесе біреумен сөйлескің келсе — біз осындамыз. Қауіпсіз, құпия және тегін.";

const CATEGORIES = [
  { key: "bullying", label: "Буллинг", emoji: "🧑‍🤝‍🧑" },
  { key: "cyberbullying", label: "Кибербуллинг", emoji: "💻" },
  { key: "domestic_violence", label: "Тұрмыстық зорлық-зомбылық", emoji: "🏠" },
  { key: "emotional_burnout_a", label: "Эмоциялық шаршау", emoji: "😮‍💨" },
  { key: "law_prevention", label: "Құқық бұзушылықтың алдын алу", emoji: "⚖️" },
  { key: "anxious_thoughts", label: "Мазасыз ойлар", emoji: "💭" },
  { key: "stress", label: "Стресс және күйзеліс", emoji: "🌧️" },
  { key: "emotional_burnout_b", label: "Эмоциялық шаршау", emoji: "😮‍💨" },
  { key: "self_esteem", label: "Өзін-өзі бағалау мәселелері", emoji: "🪞" },
  { key: "fear_anxiety", label: "Қорқыныш пен үрей", emoji: "😰" },
  { key: "depressive_mood", label: "Депрессивті көңіл күй", emoji: "🌑" },
  { key: "family_issues", label: "Отбасылық мәселелер", emoji: "👨‍👩‍👧‍👦" },
  {
    key: "teen_support",
    label: "Жасөспірімдерге психологиялық қолдау",
    emoji: "🧒",
  },
  { key: "other", label: "Басқа психологиялық сұрақтар", emoji: "❓" },
];

const MOODS = [
  { key: "bad", label: "Нашар", emoji: "🌧️" },
  { key: "mid", label: "Орташа", emoji: "🌤️" },
  { key: "good", label: "Жақсы", emoji: "☀️" },
  { key: "great", label: "Керемет", emoji: "🌟" },
];

const MOOD_QUESTIONS = {
  bad: [
    "Қазіргі кезде сізді ең қатты мазалап тұрған не?",
    "Ұйқыңыз бен тәбетіңізде өзгеріс бар ма?",
    "Қазір қолдау көрсететін адам бар ма?",
  ],
  mid: [
    "Соңғы уақытта қандай жағдайлар көңіл күйіңізге әсер етті?",
    "Стресті қалай жеңіп жүрсіз?",
    "Психологпен сөйлескіңіз келе ме?",
  ],
  good: [
    "Өзіңізді жақсы сезінуге не көмектеседі?",
    "Қай салада қолдау немесе кеңес алғыңыз келеді?",
    "Пайдалы материалдар алуға дайынсыз ба?",
  ],
  great: [
    "Қазір сізді қуантатын нәрсе не?",
    "Өзіңізді дамыту үшін қандай тақырып қызықтырады?",
    "Мотивациялық контент алғыңыз келе ме?",
  ],
};

const SURVEY_Q_CATEGORY = "Санатты таңдаңыз";
const SURVEY_Q_NAME =
  "Сәлем! Сізді қалай атауға болады?\nАты-жөніңізді жазыңыз, біз сізбен солай сөйлесеміз 😊";
const SURVEY_Q_NAME_SHORT = "Сәлем! Сізді қалай атауға болады?";
const SURVEY_Q_MOOD = "Рахмет😊\nЕнді өз жағдайыңызды бағалап өтсеңіз";

module.exports = {
  BOT_TOKEN,
  ADMIN_GROUP_ID,
  OPERATOR_IDS,
  DROP_PENDING_UPDATES,
  SEND_EXCEL_TO_TELEGRAM,
  BOT_DESCRIPTION,
  CATEGORIES,
  MOODS,
  MOOD_QUESTIONS,
  SURVEY_Q_CATEGORY,
  SURVEY_Q_NAME,
  SURVEY_Q_NAME_SHORT,
  SURVEY_Q_MOOD,
};
