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
const { scheduleExport } = require("./export");

const isOperator = (id) => OPERATOR_IDS.includes(Number(id));

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

const nowMs = () => Date.now();

const topicCache = new Map();
const TOPIC_CACHE_TTL_MS = 10 * 60 * 1000;

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const isGeneralThread = (threadId) => toInt(threadId) === 1;

const tryDelete = async (chat_id, message_id) => {
  try {
    if (!chat_id || !message_id) return;
    await tg.deleteMessage({ chat_id, message_id });
  } catch {}
};

const sendToTopicChecked = async (threadId, text, extra) => {
  const tid = toInt(threadId);
  const res = await tg.sendMessage({
    chat_id: ADMIN_GROUP_ID,
    message_thread_id: tid,
    text,
    ...(extra || {}),
  });

  const got = toInt(res?.message_thread_id);
  if (got !== tid) {
    await tryDelete(ADMIN_GROUP_ID, res?.message_id);
    const gotStr = Number.isFinite(got) ? String(got) : "none";
    throw new Error(
      `Topic routing failed. want=${tid} got=${gotStr} (likely fallback to General)`,
    );
  }

  return res;
};

const probeThreadRouting = async (threadId) => {
  const tid = toInt(threadId);
  if (!Number.isFinite(tid) || tid <= 1) return false;

  let msg = null;
  try {
    msg = await tg.sendMessage({
      chat_id: ADMIN_GROUP_ID,
      message_thread_id: tid,
      text: "·",
      disable_notification: true,
    });
  } catch {
    return false;
  } finally {
    if (msg?.message_id) await tryDelete(ADMIN_GROUP_ID, msg.message_id);
  }

  const got = toInt(msg?.message_thread_id);
  return got === tid;
};

const makeTopicTitle = (clientId) => `client_${Number(clientId)}`;

const recreateClientTopic = async (clientId, user) => {
  const title = makeTopicTitle(clientId);

  const created = await tg.createForumTopic({
    chat_id: ADMIN_GROUP_ID,
    name: title,
  });

  const threadId = toInt(created?.message_thread_id);
  if (!Number.isFinite(threadId) || threadId <= 1)
    throw new Error("createForumTopic returned invalid message_thread_id");

  await db.setClientTopic(clientId, threadId, title);

  topicCache.set(Number(clientId), {
    threadId,
    okUntilMs: nowMs() + TOPIC_CACHE_TTL_MS,
  });

  await sendToTopicChecked(
    threadId,
    `🆕 Жаңа клиент: ${safeUserLabel(user, clientId)}`,
  );

  return threadId;
};

const ensureClientTopic = async (clientId, user) => {
  await db.openIndex();

  const cid = Number(clientId);
  const cached = topicCache.get(cid);
  if (
    cached &&
    Number.isFinite(cached.threadId) &&
    cached.okUntilMs > nowMs() &&
    !isGeneralThread(cached.threadId)
  ) {
    return cached.threadId;
  }

  const current = await db.getClientTopic(cid);
  const currentTid = toInt(current?.threadId);

  if (
    Number.isFinite(currentTid) &&
    currentTid > 1 &&
    !isGeneralThread(currentTid)
  ) {
    const ok = await probeThreadRouting(currentTid);
    if (ok) {
      topicCache.set(cid, {
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
    ...(extra || {}),
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
    await sendToTopicChecked(threadId, `❓ ${text}`);
  }

  return sent;
};

const sendSurveyQuestionWithOptions = async (
  clientId,
  sessionId,
  threadId,
  questionText,
  optionsList,
) => {
  const topicText = [
    "🧾 ОПРОС",
    `❓ ${questionText}`,
    "",
    ...optionsList.map((x) => `• ${x}`),
  ].join("\n");

  const topicMsg = await sendToTopicChecked(threadId, topicText);

  const sent = await tg.sendMessage({
    chat_id: clientId,
    text: questionText,
    ...replyKeyboard2Col(optionsList),
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
) => {
  await sendToTopicChecked(threadId, `✅ Жауап\n❓ ${question}\n👤 ${answer}`);
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
    const topicMsg = await sendToTopicChecked(
      threadId,
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

  await sendToTopicChecked(threadId, `👤 ${label}\n${t.text}`);

  const forwarded = await tg.forwardMessage({
    chat_id: ADMIN_GROUP_ID,
    from_chat_id: clientId,
    message_id: m.message_id,
    message_thread_id: threadId,
    disable_notification: true,
  });

  const got = toInt(forwarded?.message_thread_id);
  if (got !== toInt(threadId)) {
    await tryDelete(ADMIN_GROUP_ID, forwarded?.message_id);
    throw new Error(
      `Forward routing failed. want=${threadId} got=${Number.isFinite(got) ? got : "none"}`,
    );
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
        thread_id: threadId,
        message_id: forwarded?.message_id || null,
      },
    },
  });
};

const startNewSessionFlow = async (clientId, user) => {
  await db.upsertClientProfile(clientId, user);

  const threadId = await ensureClientTopic(clientId, user);
  const sessionId = await db.startSession(clientId);

  await sendToTopicChecked(
    threadId,
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
    );

    scheduleExport(clientId, sessionId, threadId, "live");

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
    );

    scheduleExport(clientId, sessionId, threadId, "live");

    await sendSurveyQuestionWithOptions(
      clientId,
      sessionId,
      threadId,
      SURVEY_Q_MOOD,
      moodButtons(),
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
    );

    scheduleExport(clientId, sessionId, threadId, "live");

    const qs = MOOD_QUESTIONS[mood.key] || [];
    const q1 = qs[0] || "";
    const q2 = qs[1] || "";
    const q3 = qs[2] || "";

    await sendToTopicChecked(
      threadId,
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

    await logSurveyAnswer(clientId, sessionId, threadId, question, answer);

    if (step === 1)
      await db.updateSession(clientId, sessionId, { mood_q1: answer });
    if (step === 2)
      await db.updateSession(clientId, sessionId, { mood_q2: answer });
    if (step === 3)
      await db.updateSession(clientId, sessionId, { mood_q3: answer });

    scheduleExport(clientId, sessionId, threadId, "live");

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

    const startFile = await exportSessionXlsx(clientId, sessionId, "start");
    if (SEND_EXCEL_TO_TELEGRAM) {
      const doc = await tg.sendDocument({
        chat_id: ADMIN_GROUP_ID,
        message_thread_id: threadId,
        filePath: startFile,
        filename: `start_${clientId}_${sessionId}.xlsx`,
      });

      const got = toInt(doc?.message_thread_id);
      if (got !== toInt(threadId)) {
        await tryDelete(ADMIN_GROUP_ID, doc?.message_id);
        throw new Error(
          `Document routing failed. want=${threadId} got=${Number.isFinite(got) ? got : "none"}`,
        );
      }
    }

    await sendToTopicChecked(
      threadId,
      "ℹ️ Еркін chat басталды. Психологтар осы тақырыпта жазады. /finish — аяқтау.",
    );

    return;
  }

  await forwardClientMessageToTopic(clientId, sessionId, threadId, m, user);
};

const handleGroupMessage = async (m) => {
  if (!m.chat || m.chat.id !== ADMIN_GROUP_ID) return;
  if (!m.message_thread_id) return;

  const threadId = toInt(m.message_thread_id);
  if (!Number.isFinite(threadId)) return;

  if (!isOperator(m.from?.id)) return;

  const clientId = await db.getClientIdByThread(threadId);
  if (!clientId) return;

  let session = await db.getActiveSession(clientId);
  if (!session) {
    const sid = await db.startSession(clientId);
    session = await db.getActiveSession(clientId);
    await sendToTopicChecked(
      threadId,
      `▶️ Авto-сессия басталды. session_id=${sid}`,
    );
  }

  const sessionId = session.session_id;

  const text = m.text ? String(m.text).trim() : "";
  const cmd = text ? text.split(/\s+/)[0] : "";

  if (cmd === "/finish" || cmd.startsWith("/finish@")) {
    await db.finishSession(clientId, sessionId);

    const endFile = await exportSessionXlsx(clientId, sessionId, "end");
    if (SEND_EXCEL_TO_TELEGRAM) {
      const doc = await tg.sendDocument({
        chat_id: ADMIN_GROUP_ID,
        message_thread_id: threadId,
        filePath: endFile,
        filename: `end_${clientId}_${sessionId}.xlsx`,
      });

      const got = toInt(doc?.message_thread_id);
      if (got !== toInt(threadId)) {
        await tryDelete(ADMIN_GROUP_ID, doc?.message_id);
        throw new Error(
          `Document routing failed. want=${threadId} got=${Number.isFinite(got) ? got : "none"}`,
        );
      }
    }

    await tg.sendMessage({
      chat_id: clientId,
      text: "Рахмет. Сессия аяқталды.",
    });

    await sendToTopicChecked(threadId, "⛔ Сессия аяқталды.");

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
    await tg.deleteWebhook({ drop_pending_updates: true });
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
