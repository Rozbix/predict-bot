// لایه‌ی یکسان برای Telegram و Bale (API بله با تلگرام سازگار است)
export const PLATFORMS = ['telegram', 'bale'];

export function api(env, platform, meter) {
  const token = platform === 'bale' ? env.BALE_BOT_TOKEN : env.TELEGRAM_BOT_TOKEN;
  const base = platform === 'bale' ? `https://tapi.bale.ai/bot${token}` : `https://api.telegram.org/bot${token}`;

  async function call(method, body) {
    if (meter) meter.n++;
    try {
      const r = await fetch(`${base}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      const j = await r.json().catch(() => null);
      return j || { ok: false, error_code: r.status, description: 'bad response' };
    } catch (e) {
      return { ok: false, error_code: 0, description: String(e.message || e) };
    }
  }
  const markup = (buttons) => (buttons ? { reply_markup: buttons } : {});

  return {
    call,
    sendMessage: (chat_id, text, buttons) => call('sendMessage', { chat_id, text, disable_web_page_preview: true, ...markup(buttons) }),
    editMessage: (chat_id, message_id, text, buttons) =>
      call('editMessageText', { chat_id, message_id, text, disable_web_page_preview: true, ...markup(buttons) }),
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }),
    async sendPhoto(chat_id, bytes, caption, buttons) {
      if (meter) meter.n++;
      const fd = new FormData();
      fd.append('chat_id', String(chat_id));
      fd.append('photo', new Blob([bytes], { type: 'image/png' }), 'card.png');
      if (caption) fd.append('caption', caption);
      if (buttons) fd.append('reply_markup', JSON.stringify(buttons));
      try {
        const r = await fetch(`${base}/sendPhoto`, { method: 'POST', body: fd });
        return (await r.json().catch(() => null)) || { ok: false, description: 'bad response' };
      } catch (e) { return { ok: false, description: String(e.message || e) }; }
    },
    async isChannelMember(channel, userId) {
      const r = await call('getChatMember', { chat_id: channel, user_id: Number(userId) });
      if (!r.ok) return null; // نامشخص (ربات ادمین نیست/کانال اشتباه) ⇒ fail-open
      return ['creator', 'administrator', 'member', 'restricted'].includes(r.result.status);
    },
    // آواتار به صورت data-URI (برای کارت). خطا ⇒ null
    async avatarDataUri(userId) {
      try {
        const p = await call('getUserProfilePhotos', { user_id: Number(userId), limit: 1 });
        const sizes = p.ok && p.result.photos?.[0];
        if (!sizes) return null;
        const small = sizes.find((s) => s.width >= 100) || sizes[sizes.length - 1];
        const f = await call('getFile', { file_id: small.file_id });
        if (!f.ok) return null;
        if (meter) meter.n++;
        const url = platform === 'bale'
          ? `https://tapi.bale.ai/file/bot${token}/${f.result.file_path}`
          : `https://api.telegram.org/file/bot${token}/${f.result.file_path}`;
        const img = await fetch(url);
        if (!img.ok) return null;
        const buf = new Uint8Array(await img.arrayBuffer());
        if (buf.length > 300000) return null;
        let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return 'data:image/jpeg;base64,' + btoa(bin);
      } catch { return null; }
    },
  };
}

export const kb = {
  inline: (rows) => ({ inline_keyboard: rows }),
  reply: (rows) => ({ keyboard: rows, resize_keyboard: true, is_persistent: true }),
};
