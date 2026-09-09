// ==================== 默认配置兜底 ====================
// 优先从 env 环境变量中读取；若未配置环境变量，则回退使用下方定义
const DEFAULT_OWNER_ID = ''; 
const DEFAULT_OWNER_GROUP_IDS = ''; 
const DEFAULT_SECRET_PATH = ''; 

// ==================== 工具函数：解析多群组列表 ====================
function getAuthorizedGroups(env) {
  const raw = env.OWNER_GROUP_IDS || DEFAULT_OWNER_GROUP_IDS;
  return raw
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);
}

// ==================== 广告过滤规则 ====================
function isSpamMessage(message) {
  const content = (message.text || message.caption || '').toLowerCase();

  // 1. 常见垃圾营销与灰产词库
  const spamKeywords = [
    /usdt/i, /trx/i, /博彩/, /网赌/, /兼职/, /代开/, /发票/, 
    /色粉/, /引流/, /原味/, /接单/, /包养/, /外围/, /双向机器人制作/,
    /买粉/, /刷量/, /代实名/
  ];

  for (const reg of spamKeywords) {
    if (reg.test(content)) {
      return { isSpam: true, reason: '包含违规商业/广告关键词' };
    }
  }

  // 2. 陌生人禁止发送 Telegram 频道/群聊推广引流链接
  if (/t\.me\/[a-zA-Z0-9_]+/i.test(content)) {
    return { isSpam: true, reason: '禁止发送 Telegram 推广链接' };
  }

  // 3. 拦截第三方批量转发引流（广告机常用手段）
  if (message.forward_origin || message.forward_from || message.forward_from_chat) {
    return { isSpam: true, reason: '禁止转发第三方消息引流' };
  }

  return { isSpam: false };
}

// ==================== 字符转义工具 ====================
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ==================== 生成管理面板 ====================
async function getAdminPanelMarkup(env) {
  let isPaused = false;
  if (env.BOT_DB) {
    const status = await env.BOT_DB.get('bot_status');
    isPaused = status === 'off';
  }

  const toggleBtn = isPaused
    ? { text: "🔴 机器人已暂停 (点击开启)", callback_data: "toggle_bot_on" }
    : { text: "🟢 机器人运行中 (点击关闭)", callback_data: "toggle_bot_off" };

  const keyboard = {
    inline_keyboard: [
      [toggleBtn],
      [{ text: "📋 点击管理黑名单", callback_data: "manage_start" }]
    ]
  };

  const statusText = isPaused 
    ? "⏸️ <b>当前状态：已暂停服务</b>（陌生人来信将被拦截并提示免打扰）" 
    : "▶️ <b>当前状态：正常运行中</b>（可正常接收与中继私信）";

  const messageText = `👨‍💻 <b>管理后台！这里是您的专属控制面板。</b>\n\n${statusText}\n\n您可以随时点击下方按钮进行切换或管理黑名单：`;

  return { messageText, keyboard };
}

// ==================== 主入口 (ES Modules) ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secretPath = env.SECRET_PATH || DEFAULT_SECRET_PATH;
    const token = env.BOT_TOKEN;

    // 路径暗号门禁拦截
    if (url.pathname !== secretPath) {
      return new Response('禁止访问 (Access Denied)', { status: 403 }); 
    }

    // 浏览器 GET 请求健康自检
    if (request.method === 'GET') {
      const groups = getAuthorizedGroups(env);
      const ownerId = String(env.OWNER_ID || DEFAULT_OWNER_ID);
      const kvStatus = env.BOT_DB ? '已成功绑定 ✅' : '未绑定 ❌ (会导致状态与映射失效)';
      const tokenStatus = token ? '已配置 ✅' : '未配置 ❌ (必须在 Settings 中配置 BOT_TOKEN)';
      return new Response(`Worker 多群组版运行正常！\nToken 状态: ${tokenStatus}\nKV 状态: ${kvStatus}\n超管个人ID: ${ownerId}\n已授权管理群组 (${groups.length}个): ${groups.join(', ') || '未配置'}`, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // 处理 Telegram Webhook 推送
    if (request.method === 'POST') {
      if (!token) {
        console.error("未配置 BOT_TOKEN 环境变量！");
        return new Response('Missing Token', { status: 500 });
      }

      try {
        const update = await request.json();
        await handleUpdate(update, env, token);
      } catch (e) {
        console.error("处理更新异常:", e.message, e.stack);
      }
    }
    return new Response('OK');
  }
};

// ==================== 消息事件分发 ====================
async function handleUpdate(update, env, token) {
  const authorizedGroups = getAuthorizedGroups(env);
  const ownerId = String(env.OWNER_ID || DEFAULT_OWNER_ID);

  if (update.callback_query) {
    return await handleCallbackQuery(update.callback_query, env, token, authorizedGroups, ownerId);
  }

  const message = update.message || update.edited_message;
  if (!message) return;

  const chatId = String(message.chat.id);
  const fromId = String(message.from.id);
  const text = message.text ? message.text.trim() : '';

  // ----------------------------------------------------
  // 1. 已授权管理群内的消息处理逻辑（群管理员操作）
  // ----------------------------------------------------
  if (authorizedGroups.includes(chatId)) {
    // 群内触发 /start，呼出管理总控面板
    if (text.startsWith('/start')) {
      const { messageText, keyboard } = await getAdminPanelMarkup(env);
      await sendMessageWithKeyboard(token, chatId, messageText, keyboard);
      return;
    }

    // 管理员长按 / 右键引用回复
    if (message.reply_to_message) {
      const replyMsg = message.reply_to_message;
      let targetUserId = null;

      // 1. 优先从 KV 查询该消息关联的访客 ID
      if (env.BOT_DB) {
        try { targetUserId = await env.BOT_DB.get(`msg_${replyMsg.message_id}`); } catch (e) {}
      }

      // 2. 备用正则与原始转发提取
      if (!targetUserId && replyMsg.forward_from) {
        targetUserId = replyMsg.forward_from.id;
      } else if (!targetUserId && replyMsg.text) {
        const match = replyMsg.text.match(/用户ID:\s*(\d+)/);
        if (match) targetUserId = match[1];
      }

      if (targetUserId) {
        await forwardToUser(token, targetUserId, chatId, message);
      } else {
        await sendMessage(token, chatId, "⚠️ 回复失败：未能识别到对应的目标用户 ID。请确保您是对准【访客原消息】或【下方信息卡】进行的引用回复。");
      }
    }
    return;
  }

  // ----------------------------------------------------
  // 2. 私聊交互逻辑（区分超管个人与陌生访客）
  // ----------------------------------------------------
  if (message.chat.type === 'private') {
    // --- 超管个人私聊使用 ---
    if (fromId === ownerId) {
      if (text.startsWith('/start')) {
        const { messageText, keyboard } = await getAdminPanelMarkup(env);
        await sendMessageWithKeyboard(token, chatId, messageText, keyboard);
        return;
      }

      // 超管个人在私聊中直接回复
      if (message.reply_to_message) {
        const replyMsg = message.reply_to_message;
        let targetUserId = null;

        if (env.BOT_DB) {
          try { targetUserId = await env.BOT_DB.get(`msg_${replyMsg.message_id}`); } catch (e) {}
        }

        if (!targetUserId && replyMsg.forward_from) {
          targetUserId = replyMsg.forward_from.id;
        } else if (!targetUserId && replyMsg.text) {
          const match = replyMsg.text.match(/用户ID:\s*(\d+)/);
          if (match) targetUserId = match[1];
        }

        if (targetUserId) {
          await forwardToUser(token, targetUserId, chatId, message);
        } else {
          await sendMessage(token, chatId, "⚠️ 回复失败：未能识别到对应的目标用户 ID。");
        }
        return;
      }
    }

    // --- 陌生访客私聊 ---
    // 触发 /start 命令响应
    if (text.startsWith('/start')) {
      const keyboard = { inline_keyboard: [[{ text: "ℹ️ 关于我", callback_data: "about_me" }]] };
      await sendMessageWithKeyboard(token, chatId, "您好！我是私聊客服助手。🐰\n\n您可以直接发送任何消息（文字、图片、文件等），消息将实时转达给管理员～", keyboard);
      return;
    }

    // 🛡️ 陌生人黑名单检查
    let isBanned = false;
    if (env.BOT_DB) {
      try { isBanned = await env.BOT_DB.get(`ban_${fromId}`); } catch (e) {}
    }
    if (isBanned) return; 

    // 🛑 全局开关检查（免打扰拦截）
    if (env.BOT_DB) {
      const botStatus = await env.BOT_DB.get('bot_status');
      if (botStatus === 'off') {
        const pauseSessionKey = `pause_notified_${fromId}`;
        const hasNotified = await env.BOT_DB.get(pauseSessionKey);

        // 2 小时内仅提示一次免打扰
        if (!hasNotified) {
          await sendMessage(token, chatId, "😴 <b>管理员当前开启了免打扰模式</b>，机器人已暂停接收私信，请稍后再试～");
          await env.BOT_DB.put(pauseSessionKey, 'true', { expirationTtl: 7200 });
        }
        return; 
      }
    }

    // 🚫 广告与引流行为拦截
    const spamCheck = isSpamMessage(message);
    if (spamCheck.isSpam) {
      console.warn(`[拦截垃圾信息] 用户: ${fromId}, 原因: ${spamCheck.reason}`);
      
      if (env.BOT_DB) {
        try { await env.BOT_DB.put(`ban_${fromId}`, 'true'); } catch (e) {}
      }
      await sendMessage(token, chatId, `⚠️ <b>消息被系统拦截</b>：${spamCheck.reason}。\n您的账号已被系统记录并限制继续发送。`);
      return;
    }

    // 💬 首条欢迎语（带 2 小时冷却）
    if (env.BOT_DB) {
      try {
        const sessionKey = `welcome_${fromId}`;
        const hasWelcomed = await env.BOT_DB.get(sessionKey);

        if (!hasWelcomed) {
          const welcomeText = 
            "👋 <b>您的消息已成功送达！</b>\n\n" +
            "我是私聊助理，留言已实时同步至后台。\n" +
            "管理员看到后会在此处回复您，请耐心等待～";
          
          await sendMessage(token, chatId, welcomeText);
          await env.BOT_DB.put(sessionKey, 'true', { expirationTtl: 7200 });
        }
      } catch (e) {
        console.error("首条欢迎语发送异常:", e);
      }
    }

    // 广播转发给所有已授权群组
    await broadcastToGroups(token, message, chatId, message.from, authorizedGroups, env);
  }
}

// ==================== 回调事件处理 (内联按钮) ====================
async function handleCallbackQuery(callbackQuery, env, token, authorizedGroups, ownerId) {
  const data = callbackQuery.data;
  const chatId = String(callbackQuery.message.chat.id);
  const fromId = String(callbackQuery.from.id);
  const messageId = callbackQuery.message.message_id;

  if (data === 'about_me') {
    await answerCallbackQuery(token, callbackQuery.id, "这是一个基于 Cloudflare 构建的多群组私密中继客服机器人！", true);
    return;
  }

  // 权限校验：操作者必须在授权群组中，或是超管个人 ID
  const isAuthorized = authorizedGroups.includes(chatId) || fromId === ownerId;
  if (!isAuthorized) {
    await answerCallbackQuery(token, callbackQuery.id, "⚠️ 只有授权管理员才有权操作此面板", true);
    return;
  }

  // --- 切换启动/暂停状态 ---
  if (data === 'toggle_bot_off') {
    if (env.BOT_DB) await env.BOT_DB.put('bot_status', 'off');
    await answerCallbackQuery(token, callbackQuery.id, "⏸️ 机器人已暂停接收消息（开启免打扰）", false);
    const { messageText, keyboard } = await getAdminPanelMarkup(env);
    await editMessageTextWithKeyboard(token, chatId, messageId, messageText, keyboard);
  }
  else if (data === 'toggle_bot_on') {
    if (env.BOT_DB) await env.BOT_DB.put('bot_status', 'on');
    await answerCallbackQuery(token, callbackQuery.id, "▶️ 机器人已恢复正常接收消息", false);
    const { messageText, keyboard } = await getAdminPanelMarkup(env);
    await editMessageTextWithKeyboard(token, chatId, messageId, messageText, keyboard);
  }
  // --- 单个用户封禁 ---
  else if (data.startsWith('ban_')) {
    const targetId = data.split('_')[1];
    if (env.BOT_DB) await env.BOT_DB.put(`ban_${targetId}`, 'true'); 
    await answerCallbackQuery(token, callbackQuery.id, `🚫 已封禁用户 ${targetId}`, false);
    
    const keyboard = { inline_keyboard: [[{ text: "📋 管理黑名单", callback_data: `manage_${targetId}` }]] };
    await editMessageTextWithKeyboard(token, chatId, messageId, `<b>[ 🚫 该用户已被封禁 ]</b>\n用户ID: <code>${targetId}</code>`, keyboard);
  }
  // --- 黑名单列表展开 ---
  else if (data.startsWith('manage_')) {
    const origin = data.split('_')[1];
    
    if (!env.BOT_DB) {
      return await answerCallbackQuery(token, callbackQuery.id, "未绑定 KV 数据库", true);
    }

    try {
      const list = await env.BOT_DB.list({ prefix: 'ban_' });
      if (list.keys.length === 0) {
        const keyboard = { inline_keyboard: [[{ text: "🔙 收起面板", callback_data: `close_${origin}` }]] };
        await editMessageTextWithKeyboard(token, chatId, messageId, "🟢 <b>目前黑名单为空</b>，没有被封禁的用户。", keyboard);
      } else {
        const inline_keyboard = [];
        list.keys.forEach(key => {
          const id = key.name.split('_')[1];
          inline_keyboard.push([{ text: `🔓 解除封禁: ${id}`, callback_data: `unban_${id}_${origin}` }]);
        });
        inline_keyboard.push([{ text: "🔙 收起面板", callback_data: `close_${origin}` }]);
        await editMessageTextWithKeyboard(token, chatId, messageId, "<b>🚫 黑名单管理列表</b>\n\n点击对应 ID 即可解封：", { inline_keyboard });
      }
    } catch (e) {
      await answerCallbackQuery(token, callbackQuery.id, "读取失败，请检查 KV 配置", true);
    }
  }
  // --- 解除封禁 ---
  else if (data.startsWith('unban_')) {
    const parts = data.split('_');
    const targetId = parts[1]; 
    const origin = parts[2];   
    
    if (env.BOT_DB) await env.BOT_DB.delete(`ban_${targetId}`); 
    await answerCallbackQuery(token, callbackQuery.id, `✅ 成功解封！`, false);
    
    if (!env.BOT_DB) return;
    const list = await env.BOT_DB.list({ prefix: 'ban_' });
    if (list.keys.length === 0) {
      const keyboard = { inline_keyboard: [[{ text: "🔙 收起面板", callback_data: `close_${origin}` }]] };
      await editMessageTextWithKeyboard(token, chatId, messageId, `✅ 刚刚已解封 ${targetId}。\n🟢 <b>目前黑名单已清空</b>。`, keyboard);
    } else {
      const inline_keyboard = [];
      list.keys.forEach(key => {
        const id = key.name.split('_')[1];
        inline_keyboard.push([{ text: `🔓 解除封禁: ${id}`, callback_data: `unban_${id}_${origin}` }]);
      });
      inline_keyboard.push([{ text: "🔙 收起面板", callback_data: `close_${origin}` }]);
      await editMessageTextWithKeyboard(token, chatId, messageId, `<b>🚫 黑名单管理列表</b>\n\n✅ 刚刚解封了 ${targetId}：`, { inline_keyboard });
    }
  }
  // --- 收起面板返回上一级 ---
  else if (data.startsWith('close_')) {
    const origin = data.split('_')[1];
    
    if (origin === 'start') {
      const { messageText, keyboard } = await getAdminPanelMarkup(env);
      await editMessageTextWithKeyboard(token, chatId, messageId, messageText, keyboard);
    } else {
      let isBanned = false;
      if (env.BOT_DB) isBanned = await env.BOT_DB.get(`ban_${origin}`);
      
      if (isBanned) {
        const keyboard = { inline_keyboard: [[{ text: "📋 管理黑名单", callback_data: `manage_${origin}` }]] };
        await editMessageTextWithKeyboard(token, chatId, messageId, `<b>[ 🚫 该用户已被封禁 ]</b>\n用户ID: <code>${origin}</code>`, keyboard);
      } else {
        const keyboard = {
          inline_keyboard: [[
            { text: "🚫 一键封禁", callback_data: `ban_${origin}` },
            { text: "📋 黑名单", callback_data: `manage_${origin}` }
          ]]
        };
        await editMessageTextWithKeyboard(token, chatId, messageId, `👆 <b>消息处理菜单</b>\n用户ID: <code>${origin}</code>`, keyboard);
      }
    }
  }
}

// ==================== 消息广播与中继 ====================
async function broadcastToGroups(token, message, userChatId, userInfo, groups, env) {
  if (!groups || groups.length === 0) {
    console.error("未配置任何 OWNER_GROUP_IDS 群组，无法转发");
    return;
  }

  const rawName = (userInfo.first_name || '') + (userInfo.last_name ? ' ' + userInfo.last_name : '');
  const safeName = escapeHtml(rawName || '未知用户');
  const usernameText = userInfo.username ? `\n用户名: @${escapeHtml(userInfo.username)}` : ''; 
  const infoText = `👆 收到来自 <b>${safeName}</b> 的私聊\n用户ID: <code>${userChatId}</code>${usernameText}`;
  
  const keyboard = {
    inline_keyboard: [[
      { text: "🚫 一键封禁", callback_data: `ban_${userChatId}` },
      { text: "📋 黑名单", callback_data: `manage_${userChatId}` }
    ]]
  };

  for (const groupId of groups) {
    try {
      // 1. 转发访客原始消息
      const forwardUrl = `https://api.telegram.org/bot${token}/forwardMessage`;
      const response = await fetch(forwardUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: groupId, from_chat_id: userChatId, message_id: message.message_id })
      });

      const resJson = await response.json();
      if (resJson.ok && env.BOT_DB) {
        // 保存转发消息 ID 映射（30 天有效）
        await env.BOT_DB.put(`msg_${resJson.result.message_id}`, userChatId.toString(), { expirationTtl: 2592000 });
      }

      // 2. 发送快捷管理卡片
      const cardRes = await sendMessageWithKeyboard(token, groupId, infoText, keyboard);
      if (cardRes && cardRes.ok && env.BOT_DB) {
        // 卡片 ID 同样映射，支持直接长按回复卡片
        await env.BOT_DB.put(`msg_${cardRes.result.message_id}`, userChatId.toString(), { expirationTtl: 2592000 });
      }
    } catch (err) {
      console.error(`向群组 ${groupId} 转发失败:`, err);
    }
  }
}

async function forwardToUser(token, userId, fromChatId, message) {
  const url = `https://api.telegram.org/bot${token}/copyMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: userId, from_chat_id: fromChatId, message_id: message.message_id })
  });
  
  const result = await response.json();
  if (!result.ok) {
    if (result.error_code === 403) {
      await sendMessage(token, fromChatId, `⚠️ 发送失败：该用户已拉黑或删除了机器人。`);
    } else {
      await sendMessage(token, fromChatId, `⚠️ 发送失败：${result.description}`);
    }
  }
}

// ==================== 原生 API 封装 ====================
async function sendMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' }) });
  return await res.json();
}

async function sendMessageWithKeyboard(token, chatId, text, keyboard) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', reply_markup: keyboard }) });
  return await res.json();
}

async function answerCallbackQuery(token, callbackQueryId, text, showAlert = false) {
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQueryId, text: text, show_alert: showAlert }) });
}

async function editMessageTextWithKeyboard(token, chatId, messageId, text, keyboard) {
  const url = `https://api.telegram.org/bot${token}/editMessageText`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML', reply_markup: keyboard }) });
  return await res.json();
}
