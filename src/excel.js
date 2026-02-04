const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const db = require("./db");
const {
  MOOD_QUESTIONS,
  SURVEY_Q_CATEGORY,
  SURVEY_Q_NAME_SHORT,
  SURVEY_Q_MOOD,
} = require("./config");

const EXPORTS_DIR = process.env.EXPORTS_DIR
  ? path.resolve(process.env.EXPORTS_DIR)
  : path.join(process.cwd(), "exports");

const KEEP_TOTAL = (() => {
  const n = Number(process.env.EXPORTS_KEEP_TOTAL || 200);
  return Number.isFinite(n) && n > 20 ? n : 200;
})();

const KEEP_LIVE_PER_SESSION = (() => {
  const n = Number(process.env.EXPORTS_KEEP_LIVE_PER_SESSION || 30);
  return Number.isFinite(n) && n > 5 ? n : 30;
})();

const ensureDir = (p) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
};

const isoFromMs = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toISOString();
  } catch {
    return "";
  }
};

const cleanupExports = () => {
  try {
    if (!fs.existsSync(EXPORTS_DIR)) return;

    const files = fs
      .readdirSync(EXPORTS_DIR)
      .filter((f) => f.toLowerCase().endsWith(".xlsx"))
      .map((f) => {
        const fp = path.join(EXPORTS_DIR, f);
        let st = null;
        try {
          st = fs.statSync(fp);
        } catch {
          st = null;
        }
        return { name: f, path: fp, mtime: st ? st.mtimeMs : 0 };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const byKey = new Map();
    for (const it of files) {
      const m = it.name.match(/^live_(\d+)_(\d+)_\d+\.xlsx$/i);
      if (!m) continue;
      const key = `${m[1]}_${m[2]}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(it);
    }

    for (const arr of byKey.values()) {
      if (arr.length <= KEEP_LIVE_PER_SESSION) continue;
      for (const x of arr.slice(KEEP_LIVE_PER_SESSION)) {
        try {
          fs.unlinkSync(x.path);
        } catch {}
      }
    }

    const files2 = fs
      .readdirSync(EXPORTS_DIR)
      .filter((f) => f.toLowerCase().endsWith(".xlsx"))
      .map((f) => {
        const fp = path.join(EXPORTS_DIR, f);
        let st = null;
        try {
          st = fs.statSync(fp);
        } catch {
          st = null;
        }
        return { path: fp, mtime: st ? st.mtimeMs : 0 };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files2.length > KEEP_TOTAL) {
      for (const x of files2.slice(KEEP_TOTAL)) {
        try {
          fs.unlinkSync(x.path);
        } catch {}
      }
    }
  } catch {}
};

const buildSurveyRows = (session) => {
  const rows = [];

  rows.push([
    "CATEGORY",
    SURVEY_Q_CATEGORY,
    session?.category_label ? String(session.category_label) : "",
  ]);
  rows.push([
    "NAME",
    SURVEY_Q_NAME_SHORT,
    session?.display_name ? String(session.display_name) : "",
  ]);
  rows.push([
    "MOOD",
    SURVEY_Q_MOOD,
    session?.mood_label ? String(session.mood_label) : "",
  ]);

  const moodKey = session?.mood_key ? String(session.mood_key) : "";
  const qs = MOOD_QUESTIONS[moodKey] || [];

  rows.push([
    "MOOD_Q1",
    qs[0] ? String(qs[0]) : "",
    session?.mood_q1 ? String(session.mood_q1) : "",
  ]);
  rows.push([
    "MOOD_Q2",
    qs[1] ? String(qs[1]) : "",
    session?.mood_q2 ? String(session.mood_q2) : "",
  ]);
  rows.push([
    "MOOD_Q3",
    qs[2] ? String(qs[2]) : "",
    session?.mood_q3 ? String(session.mood_q3) : "",
  ]);

  return rows;
};

const exportSessionXlsx = async (clientId, sessionId, tag) => {
  ensureDir(EXPORTS_DIR);
  await db.openIndex();

  const profile = await db.getClientProfile(clientId);
  const session = await db.getSessionById(clientId, sessionId);

  const t = String(tag || "live").toLowerCase();
  const ts = Date.now();

  const name =
    t === "start" || t === "end"
      ? `${t}_${clientId}_${sessionId}.xlsx`
      : `live_${clientId}_${sessionId}_${ts}.xlsx`;

  const filePath = path.join(EXPORTS_DIR, name);

  const wb = new ExcelJS.Workbook();
  const ws1 = wb.addWorksheet("Session");
  ws1.addRow(["Field", "Value"]);
  ws1.addRow(["Client ID", String(clientId)]);
  ws1.addRow(["Session ID", String(sessionId)]);
  ws1.addRow(["Username", profile?.username ? String(profile.username) : ""]);
  ws1.addRow([
    "First Name",
    profile?.first_name ? String(profile.first_name) : "",
  ]);
  ws1.addRow([
    "Last Name",
    profile?.last_name ? String(profile.last_name) : "",
  ]);
  ws1.addRow([
    "Language",
    profile?.language_code ? String(profile.language_code) : "",
  ]);
  ws1.addRow(["State", session?.state ? String(session.state) : ""]);
  ws1.addRow([
    "Created At (ms)",
    session?.created_at_ms ? String(session.created_at_ms) : "",
  ]);
  ws1.addRow([
    "Created At (iso)",
    session?.created_at_ms ? isoFromMs(session.created_at_ms) : "",
  ]);
  ws1.addRow([
    "Closed At (ms)",
    session?.closed_at_ms ? String(session.closed_at_ms) : "0",
  ]);
  ws1.addRow([
    "Closed At (iso)",
    session?.closed_at_ms ? isoFromMs(session.closed_at_ms) : "",
  ]);

  const ws2 = wb.addWorksheet("Survey");
  ws2.addRow(["step", "question", "answer"]);
  const surveyRows = buildSurveyRows(session);
  for (const r of surveyRows) ws2.addRow(r);

  await wb.xlsx.writeFile(filePath);

  cleanupExports();
  return filePath;
};

module.exports = { exportSessionXlsx };
