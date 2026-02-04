const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const DB_PATH =
  process.env.DB_PATH || path.join(process.cwd(), "data", "bot.sqlite");

let db = null;
const colsCache = new Map();

const nowMs = () => Date.now();

const ensureDirForFile = (p) => {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const qIdent = (name) => String(name).replace(/"/g, '""');

const readColumns = async (table) => {
  const t = String(table || "");
  const rows = await db.all(`PRAGMA table_info("${qIdent(t)}")`);
  return rows.map((r) => r.name);
};

const tableColumns = async (table) => {
  const t = String(table || "");
  if (colsCache.has(t)) return colsCache.get(t);
  const cols = await readColumns(t);
  colsCache.set(t, cols);
  return cols;
};

const invalidateCols = (table) => colsCache.delete(String(table || ""));

const hasColumn = async (table, col) => {
  const cols = await tableColumns(table);
  return cols.includes(col);
};

const ensureColumn = async (table, col, decl) => {
  const cols = await tableColumns(table);
  if (cols.includes(col)) return;
  await db.exec(
    `ALTER TABLE "${qIdent(table)}" ADD COLUMN "${qIdent(col)}" ${decl}`,
  );
  invalidateCols(table);
};

const ensureIndex = async (sql) => {
  await db.exec(sql);
};

const createBaseTables = async () => {
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = OFF;

    CREATE TABLE IF NOT EXISTS bot_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS client_topics (
      client_id INTEGER PRIMARY KEY,
      thread_id INTEGER NOT NULL,
      title TEXT,
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS client_profiles (
      client_id INTEGER PRIMARY KEY,
      user_id INTEGER,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      language_code TEXT,
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      state TEXT,
      category_key TEXT,
      category_label TEXT,
      display_name TEXT,
      mood_key TEXT,
      mood_label TEXT,
      mood_q1 TEXT,
      mood_q2 TEXT,
      mood_q3 TEXT,
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      closed_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL DEFAULT 0,
      session_id INTEGER,
      role TEXT,
      direction TEXT,
      msg_type TEXT,
      text TEXT,
      src_chat_id INTEGER,
      src_thread_id INTEGER,
      src_message_id INTEGER,
      dst_chat_id INTEGER,
      dst_message_id INTEGER,
      ts_ms INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT
    );
  `);

  await ensureIndex(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_client_topics_thread ON client_topics(thread_id)`,
  );
  await ensureIndex(
    `CREATE INDEX IF NOT EXISTS idx_sessions_client_active ON sessions(client_id, is_active, session_id)`,
  );
  await ensureIndex(
    `CREATE INDEX IF NOT EXISTS idx_messages_client_session_time ON messages(client_id, session_id, created_at_ms, id)`,
  );
};

const migrate = async () => {
  await ensureColumn("bot_meta", "updated_at_ms", "INTEGER NOT NULL DEFAULT 0");

  await ensureColumn(
    "client_topics",
    "thread_id",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn("client_topics", "title", "TEXT");
  await ensureColumn(
    "client_topics",
    "created_at_ms",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "client_topics",
    "updated_at_ms",
    "INTEGER NOT NULL DEFAULT 0",
  );

  await ensureColumn("client_profiles", "user_id", "INTEGER");
  await ensureColumn("client_profiles", "username", "TEXT");
  await ensureColumn("client_profiles", "first_name", "TEXT");
  await ensureColumn("client_profiles", "last_name", "TEXT");
  await ensureColumn("client_profiles", "language_code", "TEXT");
  await ensureColumn(
    "client_profiles",
    "created_at_ms",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "client_profiles",
    "updated_at_ms",
    "INTEGER NOT NULL DEFAULT 0",
  );

  await ensureColumn("sessions", "is_active", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn("sessions", "state", "TEXT");
  await ensureColumn("sessions", "category_key", "TEXT");
  await ensureColumn("sessions", "category_label", "TEXT");
  await ensureColumn("sessions", "display_name", "TEXT");
  await ensureColumn("sessions", "mood_key", "TEXT");
  await ensureColumn("sessions", "mood_label", "TEXT");
  await ensureColumn("sessions", "mood_q1", "TEXT");
  await ensureColumn("sessions", "mood_q2", "TEXT");
  await ensureColumn("sessions", "mood_q3", "TEXT");
  await ensureColumn("sessions", "created_at_ms", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("sessions", "updated_at_ms", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("sessions", "closed_at_ms", "INTEGER NOT NULL DEFAULT 0");

  await ensureColumn("messages", "client_id", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("messages", "session_id", "INTEGER");
  await ensureColumn("messages", "role", "TEXT");
  await ensureColumn("messages", "direction", "TEXT");
  await ensureColumn("messages", "msg_type", "TEXT");
  await ensureColumn("messages", "text", "TEXT");
  await ensureColumn("messages", "src_chat_id", "INTEGER");
  await ensureColumn("messages", "src_thread_id", "INTEGER");
  await ensureColumn("messages", "src_message_id", "INTEGER");
  await ensureColumn("messages", "dst_chat_id", "INTEGER");
  await ensureColumn("messages", "dst_message_id", "INTEGER");
  await ensureColumn("messages", "ts_ms", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("messages", "created_at_ms", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("messages", "payload_json", "TEXT");

  const n = nowMs();

  const backfillMs = async (table, col) => {
    if (!(await hasColumn(table, col))) return;
    await db.run(
      `UPDATE "${qIdent(table)}" SET "${qIdent(col)}" = ? WHERE "${qIdent(col)}" IS NULL OR "${qIdent(col)}" = 0`,
      [n],
    );
  };

  await backfillMs("bot_meta", "updated_at_ms");
  await backfillMs("client_topics", "created_at_ms");
  await backfillMs("client_topics", "updated_at_ms");
  await backfillMs("client_profiles", "created_at_ms");
  await backfillMs("client_profiles", "updated_at_ms");
  await backfillMs("sessions", "created_at_ms");
  await backfillMs("sessions", "updated_at_ms");

  if (
    (await hasColumn("messages", "ts_ms")) &&
    (await hasColumn("messages", "created_at_ms"))
  ) {
    await db.exec(
      `UPDATE messages SET created_at_ms = ts_ms WHERE (created_at_ms IS NULL OR created_at_ms = 0) AND ts_ms IS NOT NULL AND ts_ms > 0`,
    );
    await db.exec(
      `UPDATE messages SET ts_ms = created_at_ms WHERE (ts_ms IS NULL OR ts_ms = 0) AND created_at_ms IS NOT NULL AND created_at_ms > 0`,
    );
    await db.run(
      `UPDATE messages SET ts_ms = ?, created_at_ms = ? WHERE (ts_ms IS NULL OR ts_ms = 0) AND (created_at_ms IS NULL OR created_at_ms = 0)`,
      [n, n],
    );
  } else if (await hasColumn("messages", "ts_ms")) {
    await db.run(
      `UPDATE messages SET ts_ms = ? WHERE ts_ms IS NULL OR ts_ms = 0`,
      [n],
    );
  } else if (await hasColumn("messages", "created_at_ms")) {
    await db.run(
      `UPDATE messages SET created_at_ms = ? WHERE created_at_ms IS NULL OR created_at_ms = 0`,
      [n],
    );
  }

  await ensureIndex(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_client_topics_thread ON client_topics(thread_id)`,
  );
  await ensureIndex(
    `CREATE INDEX IF NOT EXISTS idx_sessions_client_active ON sessions(client_id, is_active, session_id)`,
  );
  await ensureIndex(
    `CREATE INDEX IF NOT EXISTS idx_messages_client_session_time ON messages(client_id, session_id, created_at_ms, id)`,
  );
};

const openIndex = async () => {
  if (db) return db;
  ensureDirForFile(DB_PATH);
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await createBaseTables();
  await migrate();
  return db;
};

const getClientTopic = async (clientId) => {
  await openIndex();
  const row = await db.get(
    `SELECT thread_id AS threadId, title FROM client_topics WHERE client_id = ?`,
    [Number(clientId)],
  );
  return row || null;
};

const setClientTopic = async (clientId, threadId, title) => {
  await openIndex();
  const n = nowMs();
  await db.run(
    `INSERT INTO client_topics (client_id, thread_id, title, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       thread_id=excluded.thread_id,
       title=excluded.title,
       updated_at_ms=excluded.updated_at_ms`,
    [Number(clientId), Number(threadId), title || null, n, n],
  );
};

const getClientIdByThread = async (threadId) => {
  await openIndex();
  const row = await db.get(
    `SELECT client_id AS clientId FROM client_topics WHERE thread_id = ?`,
    [Number(threadId)],
  );
  return row ? Number(row.clientId) : null;
};

const upsertClientProfile = async (clientId, user) => {
  await openIndex();
  const u = user || {};
  const n = nowMs();
  await db.run(
    `INSERT INTO client_profiles (client_id, user_id, username, first_name, last_name, language_code, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       user_id=excluded.user_id,
       username=excluded.username,
       first_name=excluded.first_name,
       last_name=excluded.last_name,
       language_code=excluded.language_code,
       updated_at_ms=excluded.updated_at_ms`,
    [
      Number(clientId),
      u.id || null,
      u.username || null,
      u.first_name || null,
      u.last_name || null,
      u.language_code || null,
      n,
      n,
    ],
  );
};

const getClientProfile = async (clientId) => {
  await openIndex();
  const row = await db.get(
    `SELECT * FROM client_profiles WHERE client_id = ?`,
    [Number(clientId)],
  );
  return row || null;
};

const startSession = async (clientId) => {
  await openIndex();
  const n = nowMs();

  await db.run(
    `UPDATE sessions
     SET is_active = 0,
         closed_at_ms = CASE WHEN closed_at_ms = 0 THEN ? ELSE closed_at_ms END,
         updated_at_ms = ?
     WHERE client_id = ? AND is_active = 1`,
    [n, n, Number(clientId)],
  );

  const res = await db.run(
    `INSERT INTO sessions (client_id, is_active, state, created_at_ms, updated_at_ms, closed_at_ms)
     VALUES (?, 1, ?, ?, ?, 0)`,
    [Number(clientId), "CATEGORY", n, n],
  );
  return res.lastID;
};

const getActiveSession = async (clientId) => {
  await openIndex();
  const row = await db.get(
    `SELECT * FROM sessions
     WHERE client_id = ? AND is_active = 1
     ORDER BY session_id DESC
     LIMIT 1`,
    [Number(clientId)],
  );
  return row || null;
};

const getSessionById = async (clientId, sessionId) => {
  await openIndex();
  const row = await db.get(
    `SELECT * FROM sessions WHERE client_id = ? AND session_id = ?`,
    [Number(clientId), Number(sessionId)],
  );
  return row || null;
};

const updateSession = async (clientId, sessionId, patch) => {
  await openIndex();
  const allowed = [
    "state",
    "category_key",
    "category_label",
    "display_name",
    "mood_key",
    "mood_label",
    "mood_q1",
    "mood_q2",
    "mood_q3",
    "is_active",
    "closed_at_ms",
  ];

  const sets = [];
  const vals = [];

  for (const k of allowed) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
      sets.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }

  sets.push(`updated_at_ms = ?`);
  vals.push(nowMs());

  vals.push(Number(clientId));
  vals.push(Number(sessionId));

  await db.run(
    `UPDATE sessions SET ${sets.join(", ")} WHERE client_id = ? AND session_id = ?`,
    vals,
  );
};

const setSessionState = async (clientId, sessionId, state) => {
  await updateSession(clientId, sessionId, { state: String(state || "") });
};

const finishSession = async (clientId, sessionId) => {
  const n = nowMs();
  await updateSession(clientId, sessionId, { is_active: 0, closed_at_ms: n });
};

const logMessage = async (clientId, sessionId, data) => {
  await openIndex();

  const cols = await tableColumns("messages");
  const n = nowMs();
  const d = data || {};

  const payloadJson =
    d.payload === undefined || d.payload === null
      ? null
      : JSON.stringify(d.payload);

  const row = {
    client_id: Number(clientId),
    session_id:
      sessionId === undefined || sessionId === null ? null : Number(sessionId),
    role: d.role || null,
    direction: d.direction || null,
    msg_type: d.msg_type || null,
    text: d.text === undefined ? null : d.text,
    src_chat_id: d.src_chat_id === undefined ? null : d.src_chat_id,
    src_thread_id: d.src_thread_id === undefined ? null : d.src_thread_id,
    src_message_id: d.src_message_id === undefined ? null : d.src_message_id,
    dst_chat_id: d.dst_chat_id === undefined ? null : d.dst_chat_id,
    dst_message_id: d.dst_message_id === undefined ? null : d.dst_message_id,
    ts_ms: n,
    created_at_ms: n,
    payload_json: payloadJson,
  };

  const insCols = [];
  const insVals = [];

  for (const [k, v] of Object.entries(row)) {
    if (!cols.includes(k)) continue;
    insCols.push(k);
    insVals.push(v);
  }

  if (insCols.length === 0) return;

  const placeholders = insCols.map(() => "?").join(", ");
  const sql = `INSERT INTO messages (${insCols.join(", ")}) VALUES (${placeholders})`;

  await db.run(sql, insVals);
};

const getMessagesForSession = async (clientId, sessionId) => {
  await openIndex();
  const cols = await tableColumns("messages");
  const timeCol = cols.includes("created_at_ms")
    ? "created_at_ms"
    : cols.includes("ts_ms")
      ? "ts_ms"
      : "id";
  const rows = await db.all(
    `SELECT * FROM messages
     WHERE client_id = ? AND session_id = ?
     ORDER BY ${timeCol} ASC, id ASC`,
    [Number(clientId), Number(sessionId)],
  );
  return rows || [];
};

const getBotOffset = async () => {
  await openIndex();
  const row = await db.get(`SELECT value FROM bot_meta WHERE key = ?`, [
    "bot_offset",
  ]);
  if (!row) return null;
  const n = Number(row.value);
  if (!Number.isFinite(n)) return null;
  return n;
};

const setBotOffset = async (offset) => {
  await openIndex();
  const n = nowMs();
  await db.run(
    `INSERT INTO bot_meta (key, value, updated_at_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value=excluded.value,
       updated_at_ms=excluded.updated_at_ms`,
    ["bot_offset", String(Number(offset)), n],
  );
};

module.exports = {
  openIndex,
  getClientTopic,
  setClientTopic,
  getClientIdByThread,
  upsertClientProfile,
  getClientProfile,
  startSession,
  getActiveSession,
  getSessionById,
  updateSession,
  setSessionState,
  finishSession,
  logMessage,
  getMessagesForSession,
  getBotOffset,
  setBotOffset,
};
