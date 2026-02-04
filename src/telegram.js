const fs = require("fs/promises");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseRetryAfter = (json) => {
  const ra = Number(json?.parameters?.retry_after);
  if (Number.isFinite(ra) && ra > 0) return ra;
  const d = json?.description ? String(json.description) : "";
  const m = /retry after\s+(\d+)/i.exec(d);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
};

const callRaw = async (method, params, isMultipart) => {
  const url = `${API}/${method}`;

  for (let i = 0; i < 12; i++) {
    let res = null;
    let json = null;

    try {
      if (isMultipart) {
        res = await fetch(url, { method: "POST", body: params });
      } else {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params || {}),
        });
      }
      json = await res.json().catch(() => null);
    } catch (e) {
      if (i >= 11) throw e;
      await sleep(300 + i * 200);
      continue;
    }

    if (json && json.ok === true) return json.result;

    const code = Number(json?.error_code);
    const retryAfter = code === 429 ? parseRetryAfter(json) : null;

    if (retryAfter !== null) {
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    const desc = json?.description
      ? String(json.description)
      : "Telegram API error";
    throw new Error(`${method}: ${desc}`);
  }

  throw new Error(`${method}: Telegram API error`);
};

const sendMessage = async (params) => callRaw("sendMessage", params, false);

const copyMessage = async (params) => callRaw("copyMessage", params, false);

const forwardMessage = async (params) =>
  callRaw("forwardMessage", params, false);

const createForumTopic = async (params) =>
  callRaw("createForumTopic", params, false);

const sendChatAction = async (params) =>
  callRaw("sendChatAction", params, false);

const deleteMessage = async (params) => callRaw("deleteMessage", params, false);

const getUpdates = async (params) => callRaw("getUpdates", params, false);

const deleteWebhook = async (params) => callRaw("deleteWebhook", params, false);

const getMe = async () => callRaw("getMe", {}, false);

const getChat = async (chat_id) => callRaw("getChat", { chat_id }, false);

const sendDocument = async ({
  chat_id,
  message_thread_id,
  filePath,
  filename,
  caption,
}) => {
  const abs = path.resolve(filePath);
  const buf = await fs.readFile(abs);
  const blob = new Blob([buf]);

  const form = new FormData();
  form.append("chat_id", String(chat_id));
  if (message_thread_id !== undefined && message_thread_id !== null) {
    form.append("message_thread_id", String(message_thread_id));
  }
  if (caption) form.append("caption", String(caption));
  form.append("document", blob, filename || path.basename(abs));

  return callRaw("sendDocument", form, true);
};

module.exports = {
  callRaw,
  sendMessage,
  copyMessage,
  forwardMessage,
  createForumTopic,
  sendChatAction,
  deleteMessage,
  getUpdates,
  deleteWebhook,
  getMe,
  getChat,
  sendDocument,
};
