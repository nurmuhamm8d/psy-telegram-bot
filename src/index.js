require("dotenv").config();

const {
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
} = require("./config");

const tg = require("./telegram");
const db = require("./db");
const { exportSessionXlsx } = require("./excel");

const isOperator = (id) => OPERATOR_IDS.includes(Number(id));

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const safeUserLabel = (u, clientId) => {
  const uname = u?.username ? `@${u.username}` : "";
  const fn = u?.first_name || "";
  const ln = u?.last_name || "";
  const name = `${fn} ${ln}`.trim();
  const p = [uname, name].filter(Boolean).join(" ");
  return `${p}${p ? " | " : ""}id:${clientId}`;
};

const twoColRows = (arr) => {
  const rows = [];
  for (let i = 0; i < arr.length; i += 2) {
    const row = [arr[i]];
    if (arr[i + 1]) row.push(arr[i + 1]);
    rows.push(row);
  }
  return rows;
};

const replyKeyboard2Col = (items) => ({
  reply_markup: {
    keyboard: twoColRows(items.map((x) => ({ text: x }))),
    resize_keyboard: true,
    one_time_keyboard: true,
  },
});

const removeKeyboard = () => ({
  reply_markup: { remove_keyboard: true },
});

const categoryButtons = () => CATEGORIES.map((c) => `${c.emoji} ${c.label}`);
const moodButtons = () => MOODS.map((m) => `${m.emoji} ${m.label}`);

const matchChoice = (text, items) => {
  const t = String(text || "").trim();
  if (!t) return null;

  for (const it of items) {
    const btn = `${it.emoji} ${it.label}`.trim();
    if (t === btn) return it;
    if (t === it.label.trim()) return it;
  }
  return null;
};

const detectMsgType = (m) => {
  if (m.text) return { type: "text", text: m.text };
  if (m.voice) return { type: "voice", text: "[voice]" };
  if (m.video) return { type: "video", text: "[video]" };
  if (m.photo) return { type: "photo", text: "[photo]" };
  if (m.document) return { type: "document", text: "[document]" };
  if (m.sticker) return { type: "sticker", text: "[sticker]" };
  if (m.audio) return { type: "audio", text: "[audio]" };
  if (m.animation) return { type: "animation", text: "[animation]" };
  if (m.video_note) return { type: "video_note", text: "[video_note]" };
  return { type: "unknown", text: "[unknown]" };
};

const TOPIC_CACHE = new Map();
const TOPIC_CACHE_TTL_MS = 10 * 60 * 1000;

const nowMs = () => Date.now();

const makeTopicTitle = (clientId) => `client_${Number(clientId)}`;

const safeDelete = async (message_id) => {
  try {
    if (!message_id) return;
    await tg.deleteMessage({ chat_id: ADMIN_GROUP_ID, message_id });
  } catch {}
};

const sendToThreadStrict = async (threadId, text, extra) => {
  const tid = toInt(threadId);
  if (!Number.isFinite(tid) || tid <= 0) throw new Error("Invalid threadId");

  const res = await tg.sendMessage({
    chat_id: ADMIN_GROUP_ID,
    message_thread_id: tid,
    text,
    reply_markup: extra?.reply_markup,
    disable_notification: extra?.disable_notification,
  });

  const got = toInt(res?.message_thread_id);
  if (got !== tid) {
    await safeDelete(res?.message_id);
    throw new Error(`Misrouted message want=${tid} got=${String(got)}`);
  }

  return res;
};

const sendDocumentToThreadStrict = async (threadId, filePath, filename) => {
  const tid = toInt(threadId);
  if (!Number.isFinite(tid) || tid <= 0) throw new Error("Invalid threadId");

  const res = await tg.sendDocument({
    chat_id: ADMIN_GROUP_ID,
    message_thread_id: tid,
    filePath,
    filename,
    disable_notification: true,
  });

  const got = toInt(res?.message_thread_id);
  if (got !== tid) {
    await safeDelete(res?.message_id);
    throw new Error(`Misrouted document want=${tid} got=${String(got)}`);
  }

  return res;
};

const probeThread = async (threadId) => {
  try {
    const res = await sendToThreadStrict(threadId, "·", {
      disable_notification: true,
    });
    await safeDelete(res?.message_id);
    return true;
  } catch {
    return false;
  }
};

const recreateClientTopic = async (clientId, user) => {
  const title = makeTopicTitle(clientId);

  const created = await tg.createForumTopic({
    chat_id: ADMIN_GROUP_ID,
    name: title,
  });

  const threadId = toInt(created?.message_thread_id);
  if (!Number.isFinite(threadId) || threadId <= 0)
    throw new Error("createForumTopic returned invalid message_thread_id");

  await db.setClientTopic(clientId, threadId, title);

  TOPIC_CACHE.set(Number(clientId), {
    threadId,
    okUntilMs: nowMs() + TOPIC_CACHE_TTL_MS,
  });

  await sendToThreadStrict(
    threadId,
    `🆕 Жаңа клиент: ${safeUserLabel(user, clientId)}`,
  );

  return threadId;
};

const ensureClientTopic = async (clientId, user) => {
  await db.openIndex();

  const cid = Number(clientId);
  const cached = TOPIC_CACHE.get(cid);
  if (cached && cached.okUntilMs > nowMs()) return cached.threadId;

  const current = await db.getClientTopic(cid);
  const currentTid = toInt(current?.threadId);

  if (Number.isFinite(currentTid) && currentTid > 0) {
    const ok = await probeThread(currentTid);
    if (ok) {
      TOPIC_CACHE.set(cid, {
        threadId: currentTid,
        okUntilMs: nowMs() + TOPIC_CACHE_TTL_MS,
      });
      return currentTid;
    }

    console.log(
      `[TOPIC_RELINK] client=${cid} stored_thread=${currentTid} is not routable -> recreate`,
    );
  }

  return recreateClientTopic(cid, user);
};

const sendToClientTopic = async (clientId, user, text, extra) => {
  const tid = await ensureClientTopic(clientId, user);
  try {
    return await sendToThreadStrict(tid, text, extra);
  } catch {
    const tid2 = await recreateClientTopic(clientId, user);
    return await sendToThreadStrict(tid2, text, extra);
  }
};

const sendSurveyExcelToClientTopic = async (
  clientId,
  user,
  threadId,
  sessionId,
) => {
  if (!SEND_EXCEL_TO_TELEGRAM) return;

  const filePath = await exportSessionXlsx(clientId, sessionId, "survey");
  const filename = `survey_${clientId}_${sessionId}.xlsx`;

  try {
    await sendDocumentToThreadStrict(threadId, filePath, filename);
  } catch {
    const tid2 = await recreateClientTopic(clientId, user);
    await sendDocumentToThreadStrict(tid2, filePath, filename);
  }
};

const sendBotToClient = async (
  clientId,
  sessionId,
  threadId,
  text,
  extra,
  mirrorToTopic,
  payloadExtra,
) => {
  const sent = await tg.sendMessage({
    chat_id: clientId,
    text,
    reply_markup: extra?.reply_markup,
  });

  await db.logMessage(clientId, sessionId, {
    role: "bot",
    direction: "out",
    msg_type: "text",
    text,
    src_chat_id: clientId,
    dst_chat_id: clientId,
    src_message_id: sent?.message_id || null,
    payload: payloadExtra || null,
  });

  if (mirrorToTopic) {
    await sendToClientTopic(clientId, { id: clientId }, `❓ ${text}`);
  }

  return sent;
};

const sendSurveyQuestionWithOptions = async (
  clientId,
  sessionId,
  threadId,
  questionText,
  optionsList,
  user,
) => {
  const topicText = [
    "🧾 ОПРОС",
    `❓ ${questionText}`,
    "",
    ...optionsList.map((x) => `• ${x}`),
  ].join("\n");

  const topicMsg = await sendToClientTopic(clientId, user, topicText);

  const sent = await tg.sendMessage({
    chat_id: clientId,
    text: questionText,
    reply_markup: replyKeyboard2Col(optionsList).reply_markup,
  });

  await db.logMessage(clientId, sessionId, {
    role: "bot",
    direction: "out",
    msg_type: "text",
    text: questionText,
    src_chat_id: clientId,
    dst_chat_id: clientId,
    src_message_id: sent?.message_id || null,
    payload: {
      options: optionsList,
      mirror: {
        chat_id: ADMIN_GROUP_ID,
        thread_id: threadId,
        message_id: topicMsg?.message_id || null,
      },
    },
  });

  return sent;
};

const logSurveyAnswer = async (
  clientId,
  sessionId,
  threadId,
  question,
  answer,
  user,
) => {
  await sendToClientTopic(
    clientId,
    user,
    `✅ Жауап\n❓ ${question}\n👤 ${answer}`,
  );

  await db.logMessage(clientId, sessionId, {
    role: "client",
    direction: "in",
    msg_type: "text",
    text: answer,
    src_chat_id: clientId,
    dst_chat_id: clientId,
    payload: { question },
  });
};

const forwardClientMessageToTopic = async (
  clientId,
  sessionId,
  threadId,
  m,
  user,
) => {
  const t = detectMsgType(m);
  const label = safeUserLabel(user, clientId);

  if (t.type === "text") {
    const topicMsg = await sendToClientTopic(
      clientId,
      user,
      `👤 ${label}\n${t.text}`,
    );
    await db.logMessage(clientId, sessionId, {
      role: "client",
      direction: "in",
      msg_type: "text",
      text: t.text,
      src_chat_id: clientId,
      src_message_id: m.message_id,
      dst_chat_id: clientId,
      payload: {
        mirror: {
          chat_id: ADMIN_GROUP_ID,
          thread_id: threadId,
          message_id: topicMsg?.message_id || null,
        },
      },
    });
    return;
  }

  const tid = await ensureClientTopic(clientId, user);

  let forwarded = null;
  try {
    forwarded = await tg.forwardMessage({
      chat_id: ADMIN_GROUP_ID,
      from_chat_id: clientId,
      message_id: m.message_id,
      message_thread_id: tid,
      disable_notification: true,
    });

    const got = toInt(forwarded?.message_thread_id);
    if (got !== toInt(tid)) {
      await safeDelete(forwarded?.message_id);
      throw new Error("misroute");
    }
  } catch {
    const tid2 = await recreateClientTopic(clientId, user);
    forwarded = await tg.forwardMessage({
      chat_id: ADMIN_GROUP_ID,
      from_chat_id: clientId,
      message_id: m.message_id,
      message_thread_id: tid2,
      disable_notification: true,
    });

    const got2 = toInt(forwarded?.message_thread_id);
    if (got2 !== toInt(tid2)) {
      await safeDelete(forwarded?.message_id);
      throw new Error("Forward misrouted twice");
    }
  }

  await db.logMessage(clientId, sessionId, {
    role: "client",
    direction: "in",
    msg_type: t.type,
    text: t.text,
    src_chat_id: clientId,
    src_message_id: m.message_id,
    dst_chat_id: clientId,
    payload: {
      mirror: {
        chat_id: ADMIN_GROUP_ID,
        thread_id: tid,
        message_id: forwarded?.message_id || null,
      },
    },
  });
};

const startNewSessionFlow = async (clientId, user) => {
  await db.upsertClientProfile(clientId, user);

  const threadId = await ensureClientTopic(clientId, user);
  const sessionId = await db.startSession(clientId);

  await sendToClientTopic(
    clientId,
    user,
    `▶️ Сессия басталды. session_id=${sessionId}`,
  );

  await sendBotToClient(
    clientId,
    sessionId,
    threadId,
    BOT_DESCRIPTION,
    null,
    true,
    null,
  );

  await sendSurveyQuestionWithOptions(
    clientId,
    sessionId,
    threadId,
    SURVEY_Q_CATEGORY,
    categoryButtons(),
    user,
  );

  await db.setSessionState(clientId, sessionId, "CATEGORY");

  return { threadId, sessionId };
};

const handlePrivateMessage = async (m) => {
  const clientId = m.chat.id;
  const user = m.from || {};

  await db.openIndex();
  await db.upsertClientProfile(clientId, user);

  const threadId = await ensureClientTopic(clientId, user);

  const isStart = m.text && String(m.text).trim() === "/start";
  if (isStart) {
    await startNewSessionFlow(clientId, user);
    return;
  }

  let session = await db.getActiveSession(clientId);
  if (!session) {
    await startNewSessionFlow(clientId, user);
    session = await db.getActiveSession(clientId);
  }

  const sessionId = session.session_id;

  if (session.state === "CATEGORY") {
    const choice = matchChoice(m.text, CATEGORIES);
    if (!choice) {
      await forwardClientMessageToTopic(clientId, sessionId, threadId, m, user);
      await sendSurveyQuestionWithOptions(
        clientId,
        sessionId,
        threadId,
        SURVEY_Q_CATEGORY,
        categoryButtons(),
        user,
      );
      return;
    }

    await db.updateSession(clientId, sessionId, {
      category_key: choice.key,
      category_label: choice.label,
    });

    await logSurveyAnswer(
      clientId,
      sessionId,
      threadId,
      SURVEY_Q_CATEGORY,
      `${choice.emoji} ${choice.label}`,
      user,
    );

    await sendBotToClient(
      clientId,
      sessionId,
      threadId,
      SURVEY_Q_NAME,
      removeKeyboard(),
      true,
      null,
    );

    await db.setSessionState(clientId, sessionId, "NAME");
    return;
  }

  if (session.state === "NAME") {
    const name = String(m.text || "").trim();
    if (!name) {
      await forwardClientMessageToTopic(clientId, sessionId, threadId, m, user);
      await sendBotToClient(
        clientId,
        sessionId,
        threadId,
        SURVEY_Q_NAME,
        null,
        true,
        null,
      );
      return;
    }

    await db.updateSession(clientId, sessionId, { display_name: name });

    await logSurveyAnswer(
      clientId,
      sessionId,
      threadId,
      SURVEY_Q_NAME_SHORT,
      name,
      user,
    );

    await sendSurveyQuestionWithOptions(
      clientId,
      sessionId,
      threadId,
      SURVEY_Q_MOOD,
      moodButtons(),
      user,
    );

    await db.setSessionState(clientId, sessionId, "MOOD");
    return;
  }

  if (session.state === "MOOD") {
    const mood = matchChoice(m.text, MOODS);
    if (!mood) {
      await forwardClientMessageToTopic(clientId, sessionId, threadId, m, user);
      await sendSurveyQuestionWithOptions(
        clientId,
        sessionId,
        threadId,
        SURVEY_Q_MOOD,
        moodButtons(),
        user,
      );
      return;
    }

    await db.updateSession(clientId, sessionId, {
      mood_key: mood.key,
      mood_label: mood.label,
    });

    await logSurveyAnswer(
      clientId,
      sessionId,
      threadId,
      SURVEY_Q_MOOD,
      `${mood.emoji} ${mood.label}`,
      user,
    );

    const qs = MOOD_QUESTIONS[mood.key] || [];
    const q1 = qs[0] || "";
    const q2 = qs[1] || "";
    const q3 = qs[2] || "";

    await sendToClientTopic(
      clientId,
      user,
      `🧾 3 СҰРАҚ (кезекпен)\n1) ${q1}\n2) ${q2}\n3) ${q3}`,
    );

    await sendBotToClient(
      clientId,
      sessionId,
      threadId,
      q1,
      removeKeyboard(),
      true,
      null,
    );
    await db.setSessionState(clientId, sessionId, "MOOD_Q1");
    return;
  }

  if (
    session.state === "MOOD_Q1" ||
    session.state === "MOOD_Q2" ||
    session.state === "MOOD_Q3"
  ) {
    const moodKey = session.mood_key;
    const qs = MOOD_QUESTIONS[moodKey] || [];
    const answer = String(m.text || "").trim();

    const step =
      session.state === "MOOD_Q1" ? 1 : session.state === "MOOD_Q2" ? 2 : 3;
    const question = qs[step - 1] || "";

    await logSurveyAnswer(
      clientId,
      sessionId,
      threadId,
      question,
      answer,
      user,
    );

    if (step === 1)
      await db.updateSession(clientId, sessionId, { mood_q1: answer });
    if (step === 2)
      await db.updateSession(clientId, sessionId, { mood_q2: answer });
    if (step === 3)
      await db.updateSession(clientId, sessionId, { mood_q3: answer });

    if (step < 3) {
      const nextQ = qs[step] || "";
      await sendBotToClient(
        clientId,
        sessionId,
        threadId,
        nextQ,
        null,
        true,
        null,
      );
      await db.setSessionState(
        clientId,
        sessionId,
        step === 1 ? "MOOD_Q2" : "MOOD_Q3",
      );
      return;
    }

    await db.setSessionState(clientId, sessionId, "CHAT");

    await sendBotToClient(
      clientId,
      sessionId,
      threadId,
      "Рахмет😊 Енді психологпен сөйлесуді бастай аласыз.",
      removeKeyboard(),
      true,
      null,
    );

    const tid = await ensureClientTopic(clientId, user);
    await sendSurveyExcelToClientTopic(clientId, user, tid, sessionId);

    await sendToClientTopic(
      clientId,
      user,
      "ℹ️ Еркін chat басталды. Психологтар осы тақырыпта жазады. /finish — аяқтау.",
    );

    return;
  }

  await forwardClientMessageToTopic(clientId, sessionId, threadId, m, user);
};

const handleGroupMessage = async (m) => {
  if (!m.chat || m.chat.id !== ADMIN_GROUP_ID) return;

  const threadId = toInt(m.message_thread_id);
  if (!Number.isFinite(threadId) || threadId <= 1) return;

  if (!isOperator(m.from?.id)) return;

  const clientId = await db.getClientIdByThread(threadId);
  if (!clientId) return;

  let session = await db.getActiveSession(clientId);
  if (!session) {
    const sid = await db.startSession(clientId);
    session = await db.getActiveSession(clientId);
    await sendToThreadStrict(
      threadId,
      `▶️ Авto-сессия басталды. session_id=${sid}`,
    );
  }

  const sessionId = session.session_id;

  const text = m.text ? String(m.text).trim() : "";
  const cmd = text ? text.split(/\s+/)[0] : "";

  if (cmd === "/finish" || cmd.startsWith("/finish@")) {
    await db.finishSession(clientId, sessionId);

    await tg.sendMessage({
      chat_id: clientId,
      text: "Рахмет. Сессия аяқталды.",
    });
    await sendToThreadStrict(threadId, "⛔ Сессия аяқталды.");

    await db.logMessage(clientId, sessionId, {
      role: "operator",
      direction: "out",
      msg_type: "text",
      text: cmd,
      src_chat_id: ADMIN_GROUP_ID,
      src_thread_id: threadId,
      src_message_id: m.message_id,
      dst_chat_id: clientId,
      payload: { action: "finish" },
    });

    await db.logMessage(clientId, sessionId, {
      role: "bot",
      direction: "out",
      msg_type: "text",
      text: "Рахмет. Сессия аяқталды.",
      src_chat_id: clientId,
      dst_chat_id: clientId,
    });

    return;
  }

  const t = detectMsgType(m);

  const copied = await tg.copyMessage({
    chat_id: clientId,
    from_chat_id: ADMIN_GROUP_ID,
    message_id: m.message_id,
  });

  await db.logMessage(clientId, sessionId, {
    role: "operator",
    direction: "out",
    msg_type: t.type,
    text: t.text,
    src_chat_id: ADMIN_GROUP_ID,
    src_thread_id: threadId,
    src_message_id: m.message_id,
    dst_chat_id: clientId,
    dst_message_id: copied?.message_id || null,
  });
};

const main = async () => {
  await db.openIndex();

  if (DROP_PENDING_UPDATES) {
    await tg.deleteWebhook(true);
  }

  await tg.getMe();

  const chat = await tg.getChat(ADMIN_GROUP_ID);
  if (!chat || chat.type !== "supergroup" || chat.is_forum !== true) {
    throw new Error(
      "ADMIN_GROUP_ID must be a forum supergroup with topics enabled",
    );
  }

  let offset = 0;
  const saved = await db.getBotOffset();

  if (saved !== null && saved !== undefined && String(saved).trim() !== "") {
    const n = Number(saved);
    if (Number.isFinite(n) && n >= 0) offset = n;
  } else {
    const snap = await tg.getUpdates({
      offset: 0,
      timeout: 0,
      limit: 100,
      allowed_updates: ["message"],
    });
    if (Array.isArray(snap) && snap.length > 0) {
      offset = snap[snap.length - 1].update_id + 1;
    }
    await db.setBotOffset(offset);
  }

  for (;;) {
    const updates = await tg.getUpdates({
      offset,
      timeout: 25,
      limit: 50,
      allowed_updates: ["message"],
    });

    for (const u of updates) {
      offset = u.update_id + 1;
      await db.setBotOffset(offset);

      if (!u.message) continue;
      const m = u.message;

      if (m.chat?.type === "private") {
        try {
          await handlePrivateMessage(m);
        } catch (e) {
          console.error("[PRIVATE_HANDLER_ERROR]", e && e.stack ? e.stack : e);
          try {
            await tg.sendMessage({
              chat_id: m.chat.id,
              text: "⚠️ Техникалық қате. Кейінірек қайталап көріңіз.",
            });
          } catch {}
        }
        continue;
      }

      if (m.chat?.type === "supergroup" && m.chat.id === ADMIN_GROUP_ID) {
        try {
          await handleGroupMessage(m);
        } catch (e) {
          console.error("[GROUP_HANDLER_ERROR]", e && e.stack ? e.stack : e);
        }
      }
    }
  }
};

process.on("unhandledRejection", (e) =>
  console.error("[UNHANDLED_REJECTION]", e),
);
process.on("uncaughtException", (e) =>
  console.error("[UNCAUGHT_EXCEPTION]", e),
);

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
