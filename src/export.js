const path = require("path");
const tg = require("./telegram");
const { ADMIN_GROUP_ID, SEND_EXCEL_TO_TELEGRAM } = require("./config");
const { exportSessionXlsx } = require("./excel");

const running = new Set();
const pending = new Map();

const keyOf = (clientId, sessionId) =>
  `${Number(clientId)}:${Number(sessionId)}`;

const runOnce = async (clientId, sessionId, threadId, tag) => {
  if (!SEND_EXCEL_TO_TELEGRAM) return;
  if (!ADMIN_GROUP_ID || !threadId) return;

  const filePath = await exportSessionXlsx(clientId, sessionId, tag || "live");
  const base = path.basename(filePath);

  await tg.sendDocument({
    chat_id: ADMIN_GROUP_ID,
    message_thread_id: threadId,
    filePath,
    filename: base,
  });
};

const pump = async (k) => {
  if (running.has(k)) return;
  running.add(k);
  try {
    for (;;) {
      const item = pending.get(k);
      if (!item) break;
      pending.delete(k);
      await runOnce(item.clientId, item.sessionId, item.threadId, item.tag);
    }
  } finally {
    running.delete(k);
  }
};

const scheduleExport = (clientId, sessionId, threadId, tag) => {
  const k = keyOf(clientId, sessionId);
  pending.set(k, {
    clientId: Number(clientId),
    sessionId: Number(sessionId),
    threadId: Number(threadId),
    tag: tag || "live",
  });
  queueMicrotask(() => pump(k));
};

module.exports = { scheduleExport };
