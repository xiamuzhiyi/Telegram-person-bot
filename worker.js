// ==================== 默认配置兜底 ====================
const DEFAULT_OWNER_ID = '8913877802';
const DEFAULT_OWNER_GROUP_IDS = '';
const DEFAULT_SECRET_PATH = '/xiagefei120';

function getToken(env) {
  return env.BOT_TOKEN || env.TOKEN || '';
}

function getSecretPath(env) {
  let path = env.SECRET_PATH || DEFAULT_SECRET_PATH;
  if (!path.startsWith('/')) path = '/' + path;
  return path;
}

// Webhook 防伪造密钥（建议在 Worker 环境变量配置 WEBHOOK_SECRET）
function getWebhookSecret(env) {
  return env.WEBHOOK_SECRET || env.SECRET_TOKEN || '';
}

function getAuthorizedGroups(env) {
  const raw = env.OWNER_GROUP_IDS || DEFAULT_OWNER_GROUP_IDS || '';
  return raw
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);
}

function isAuthorizedAdmin(userId, chatId, env, boundGroupId) {
  const ownerId = String(env.OWNER_ID || DEFAULT_OWNER_ID);
  const authorizedGroups = getAuthorizedGroups(env);
  const uId = String(userId);
  const cId = String(chatId);

  return (ownerId && uId === ownerId) || (boundGroupId && cId === boundGroupId) || authorizedGroups.includes(cId);
}

// KV list 带游标全量分页（修复 1000 条截断问题）
async function listAllKeys(db, prefix) {
  const names = [];
  let cursor;
  do {
    const page = cursor ? await db.list({ prefix, cursor }) : await db.list({ prefix });
    page.keys.forEach(k => names.push(k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

// ==================== 广告与违规规则过滤 ====================
function isSpamMessage(message) {
  const content = (message.text || message.caption || '').toLowerCase();

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

  if (/t\.me\/[a-zA-Z0-9_]+/i.test(content)) {
    return { isSpam: true, reason: '禁止发送 Telegram 推广链接' };
  }

  if (message.forward_origin || message.forward_from || message.forward_from_chat) {
    return { isSpam: true, reason: '禁止转发第三方消息引流' };
  }

  return { isSpam: false };
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 安全解析 KV 中的 JSON（损坏数据兜底，防止中断主流程）
function safeParseJson(str, fallback = {}) {
  try {
    const obj = JSON.parse(str);
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch (e) {
    return fallback;
  }
}

// ==================== 管理后台控制面板 ====================
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
      [{ text: "🎭 切换模拟陌生人测试", callback_data: "toggle_test_mode" }],
      [{ text: "📋 点击管理黑名单", callback_data: "manage_banlist_start" }]
    ]
  };

  const statusText = isPaused
    ? "⏸️ <b>当前状态：已暂停服务</b>（访客来信将被拦截并提示免打扰）"
    : "▶️ <b>当前状态：正常运行中</b>（可正常接收并建立接待室）";

  const messageText = `👨‍💻 <b>管理员您好！这里是全局控制台。</b>\n\n${statusText}\n\n💡 提示：输入 <code>/test on</code> 可随时切换为陌生人测试模式。`;
  return { messageText, keyboard };
}

// ==================== 主入口 (ES Modules 规范) ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secretPath = getSecretPath(env);
    const token = getToken(env);
    const webhookSecret = getWebhookSecret(env);

    // 🚀 一键配置 Webhook（仅允许 GET，注入 secret_token 防伪造）
    if (url.pathname === '/setup') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      if (!token) return new Response('Missing BOT_TOKEN in Environment Variables', { status: 500 });
      const webhookUrl = `${url.origin}${secretPath}`;
      const payload = {
        url: webhookUrl,
        allowed_updates: ["message", "callback_query", "message_reaction"],
        drop_pending_updates: true
      };
      if (webhookSecret) payload.secret_token = webhookSecret;
      const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      return new Response(JSON.stringify(json, null, 2), { headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
    }

    // 门禁拦截
    if (url.pathname !== secretPath) {
      return new Response('Access Denied (暗号不匹配)', { status: 403 });
    }

    // GET 健康自检（不再回显超管个人 ID）
    if (request.method === 'GET') {
      let boundGroupId = env.BOT_DB ? await env.BOT_DB.get('OWNER_GROUP_ID') : null;
      if (!boundGroupId && env.OWNER_GROUP_IDS) boundGroupId = env.OWNER_GROUP_IDS.split(',')[0].trim();

      return new Response(`Worker 话题工单增强版运行正常！\nToken 状态: ${token ? '已配置 ✅' : '缺失 ❌'}\nKV 状态: ${env.BOT_DB ? '已绑定 ✅' : '未绑定 ❌'}\nWebhook 防伪造: ${webhookSecret ? '已启用 ✅' : '未配置 ⚠️ (建议设置 WEBHOOK_SECRET)'}\n接待大本营群组: ${boundGroupId || '未绑定 (请在群内发送 /bind)'}`, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // POST 消息分发
    if (request.method === 'POST') {
      if (!token) return new Response('Missing Token', { status: 500 });

      // 🛡️ 校验 Telegram 官方 secret_token，防伪造 update 冒充管理员
      if (webhookSecret && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== webhookSecret) {
        return new Response('Forbidden (secret token mismatch)', { status: 403 });
      }

      try {
        const update = await request.json();
        await handleUpdate(update, env, token);
      } catch (e) {
        console.error("处理 Update 异常:", e.message, e.stack);
      }
    }
    return new Response('OK');
  }
};

// ==================== 消息事件核心路由 ====================
async function handleUpdate(update, env, token) {
  const ownerId = String(env.OWNER_ID || DEFAULT_OWNER_ID);

  let boundGroupId = env.BOT_DB ? await env.BOT_DB.get('OWNER_GROUP_ID') : null;
  if (!boundGroupId && env.OWNER_GROUP_IDS) {
    boundGroupId = env.OWNER_GROUP_IDS.split(',')[0].trim();
  }

  // ⚔️ 【霸王级隐私特权】原生 👎 反应秒级双向粉碎（双向对称反查）
  if (update.message_reaction) {
    const reaction = update.message_reaction;
    const chatId = String(reaction.chat.id);
    const userId = String(reaction.user?.id || '');

    if (isAuthorizedAdmin(userId, chatId, env, boundGroupId) && env.BOT_DB) {
      const hasThumbsDown = reaction.new_reaction?.some(r => r.type === 'emoji' && r.emoji === '👎');
      if (hasThumbsDown) {
        // 命名空间已隔离：grp_ = 群侧消息映射，g_ = 访客私聊侧消息映射
        let ownKey = null, counterpartKey = null, targetChatId = null, targetMsgId = null;

        const grpMap = await env.BOT_DB.get(`msg_map_grp_${reaction.message_id}`);
        if (grpMap) {
          const [tUser, tMsg] = grpMap.split('_');
          ownKey = `msg_map_grp_${reaction.message_id}`;
          targetChatId = tUser;
          targetMsgId = tMsg;
          counterpartKey = `msg_map_g_${tMsg}`;
        } else {
          const gMap = await env.BOT_DB.get(`msg_map_g_${reaction.message_id}`);
          if (gMap) {
            const [tChat, tMsg] = gMap.split('_');
            ownKey = `msg_map_g_${reaction.message_id}`;
            targetChatId = tChat;
            targetMsgId = tMsg;
            counterpartKey = `msg_map_grp_${tMsg}`;
          }
        }

        if (ownKey) {
          await deleteMessage(token, targetChatId, targetMsgId);
          await deleteMessage(token, reaction.chat.id, reaction.message_id);
          await env.BOT_DB.delete(ownKey);
          await env.BOT_DB.delete(counterpartKey);
        }
      }
    }
    return;
  }

  // 🖱️ 内联按钮回调
  if (update.callback_query) {
    return await handleCallbackQuery(update.callback_query, env, token, ownerId, boundGroupId);
  }

  // ✏️ edited_message 不再订阅也不再处理，杜绝编辑消息导致重复投递
  const message = update.message;
  if (!message) return;

  const chatId = String(message.chat.id);
  const fromId = String(message.from.id);
  const text = message.text ? message.text.trim() : '';

  // 📱 超管专属模式控制
  if (message.chat.type === 'private' && fromId === ownerId) {
    if (text === '/test on') {
      if (env.BOT_DB) {
        await env.BOT_DB.put(`mock_guest_${ownerId}`, 'true');
        await env.BOT_DB.delete(`verified_${ownerId}`);
      }
      await sendMessage(token, chatId, "🎭 <b>已开启【模拟陌生人测试模式】</b>！\n接下来您在私聊发送的消息将被当作真实访客处理，会触发验证并在接待大本营生成工单。\n\n退出测试请随时发送：<code>/test off</code>");
      return;
    }
    if (text === '/test off') {
      if (env.BOT_DB) {
        await env.BOT_DB.delete(`mock_guest_${ownerId}`);
        await env.BOT_DB.delete(`verified_${ownerId}`);
      }
      await sendMessage(token, chatId, "👑 <b>已退出测试模式</b>，恢复超级管理员控制台身份。输入 /start 呼出管理菜单。");
      return;
    }

    const isMockGuest = env.BOT_DB ? (await env.BOT_DB.get(`mock_guest_${ownerId}`) === 'true') : false;
    if (!isMockGuest && text.startsWith('/start')) {
      const { messageText, keyboard } = await getAdminPanelMarkup(env);
      await sendMessageWithKeyboard(token, chatId, messageText, keyboard);
      return;
    }
  }

  // 🔗 大本营超级群绑定指令
  if (message.chat.type === 'supergroup' && fromId === ownerId && text === '/bind') {
    if (env.BOT_DB) {
      await env.BOT_DB.put('OWNER_GROUP_ID', chatId);
      await sendMessage(token, chatId, "✅ <b>绑定成功！</b>\n当前群组已设为「工单大本营」。\n新访客的私聊将自动以独立房间的形式发送到这里。");
    } else {
      await sendMessage(token, chatId, "⚠️ 绑定失败：未检测到绑定的 KV 数据库。");
    }
    return;
  }

  // 💬 管理员在工单话题房间内回复访客 / 备注 / 救援绑定
  const isGroupAdminReply = (boundGroupId && chatId === boundGroupId && message.message_thread_id) ||
                            (getAuthorizedGroups(env).includes(chatId) && message.message_thread_id);

  if (isGroupAdminReply) {
    if (!isAuthorizedAdmin(fromId, chatId, env, boundGroupId)) return;

    const threadId = message.message_thread_id;

    // 🛠️ 救援指令：强制手动绑定当前房间到任意用户 ID
    if (text.startsWith('/binduser')) {
      const parts = text.split(/\s+/);
      const manualUserId = parts[1];
      if (!manualUserId || !/^\d+$/.test(manualUserId)) {
        await sendMessage(token, chatId, "⚠️ 格式错误！请指定目标用户的纯数字 ID，例如：<code>/binduser 123456789</code>", threadId);
        return;
      }
      if (env.BOT_DB) {
        // 🧹 清理旧映射：解绑原用户，避免自愈反查把旧 ID 绑回来
        const oldUserId = await env.BOT_DB.get(`user_for_${threadId}`);
        if (oldUserId && oldUserId !== manualUserId) {
          await env.BOT_DB.delete(`topic_for_${oldUserId}`);
        }
        await env.BOT_DB.put(`user_for_${threadId}`, manualUserId);
        await env.BOT_DB.put(`topic_for_${manualUserId}`, String(threadId));
      }
      await deleteMessage(token, chatId, message.message_id);

      // 发送单行置顶并置顶
      const pinnedLineText = await buildPinnedSingleLine(env, manualUserId);
      const pinnedRes = await sendMessage(token, chatId, pinnedLineText, threadId);
      if (pinnedRes && pinnedRes.ok) {
        if (env.BOT_DB) await env.BOT_DB.put(`pinned_line_msg_${threadId}`, String(pinnedRes.result.message_id));
        await fetch(`https://api.telegram.org/bot${token}/pinChatMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: pinnedRes.result.message_id })
        });
      }

      // 发送底部交互卡片
      const panelRes = await sendPanel(token, env, chatId, threadId, manualUserId);
      if (panelRes && panelRes.ok) {
        if (env.BOT_DB) await env.BOT_DB.put(`panel_msg_${threadId}`, String(panelRes.result.message_id));
      }

      await sendMessage(token, chatId, `✅ <b>应急绑定成功！</b>\n当前房间已成功强行绑定至用户：<code>${manualUserId}</code>，现在可正常打字回复。`, threadId);
      return;
    }

    let targetUserId = env.BOT_DB ? await env.BOT_DB.get(`user_for_${threadId}`) : null;

    // 🔍 自动反向溯源自愈
    if (!targetUserId && env.BOT_DB) {
      try {
        const topicNames = await listAllKeys(env.BOT_DB, 'topic_for_');
        for (const name of topicNames) {
          const val = await env.BOT_DB.get(name);
          if (val === String(threadId)) {
            targetUserId = name.replace('topic_for_', '');
            await env.BOT_DB.put(`user_for_${threadId}`, targetUserId);
            break;
          }
        }
      } catch (e) {}
    }

    if (!targetUserId) {
      await sendMessage(token, chatId, `⚠️ <b>发送中断：该房间未关联到访客 ID</b>\n\n📌 <b>快速解决方案</b>：\n如果您知道访客的数字 ID，可直接在此房间发送：\n<code>/binduser 访客ID</code> 进行一键强制绑定！`, threadId);
      return;
    }

    // 接收输入的备注文本并瞬间吞噬字迹
    const currentState = env.BOT_DB ? await env.BOT_DB.get(`state_${threadId}`) : null;
    if (currentState && currentState.startsWith('waiting_for_note:')) {
      const expectedAdminId = currentState.split(':')[1];
      if (fromId === expectedAdminId) {
        await deleteMessage(token, chatId, message.message_id);

        // ✏️ 备注模式仅接受文本，媒体消息不再误写为「已备注」
        if (!message.text) {
          await sendMessage(token, chatId, "✏️ 备注模式仅支持文本，请直接打字发送新备注（发送 /cancel 可取消）。", threadId);
          return;
        }

        if (text === '/cancel') {
          await env.BOT_DB.delete(`state_${threadId}`);
          await sendMessage(token, chatId, "↩️ 已取消修改备注。", threadId);
          return;
        }

        const newNote = text || "已备注";
        await env.BOT_DB.put(`note_for_${targetUserId}`, newNote);
        await env.BOT_DB.delete(`state_${threadId}`);

        const userInfoStr = await env.BOT_DB.get(`info_for_${targetUserId}`);
        const userInfo = userInfoStr ? safeParseJson(userInfoStr, { first_name: "访客" }) : { first_name: "访客" };
        const fullName = (userInfo.first_name || '') + (userInfo.last_name ? ' ' + userInfo.last_name : '');

        const safeTitle = `👤 [${newNote}]：${fullName}`.slice(0, 128);
        await editTopicName(token, chatId, threadId, safeTitle);
        if (env.BOT_DB) await env.BOT_DB.put(`topic_name_${threadId}`, safeTitle);

        await refreshTopicDisplays(token, env, targetUserId, threadId, chatId);
        return;
      }
    }

    // 正常打字回复：智能中继
    const replyRes = await safeReplyToUser(token, targetUserId, chatId, message, env);
    if (!replyRes.ok) {
      const desc = replyRes.error || '未知原因';
      if (desc.includes('blocked') || desc.includes('deactivated')) {
        await sendMessage(token, chatId, `⚠️ 发送失败：访客已主动拉黑或注销了账号。`, threadId);
      } else if (desc.includes('chat not found')) {
        await sendMessage(token, chatId, `⚠️ 发送失败：目标用户从未在私聊启动过本机器人。`, threadId);
      } else {
        await sendMessage(token, chatId, `⚠️ 发送失败：Telegram 接口报错: <code>${escapeHtml(desc)}</code>`, threadId);
      }
    }
    return;
  }

  // 📨 外部客户私聊入口
  const isMockGuestActive = (fromId === ownerId) && (env.BOT_DB ? (await env.BOT_DB.get(`mock_guest_${ownerId}`) === 'true') : false);
  const shouldProcessAsGuest = (message.chat.type === 'private') && (fromId !== ownerId || isMockGuestActive);

  if (shouldProcessAsGuest) {
    if (env.BOT_DB && await env.BOT_DB.get(`ban_${fromId}`)) return;

    // 免打扰拦截
    if (env.BOT_DB) {
      const botStatus = await env.BOT_DB.get('bot_status');
      if (botStatus === 'off') {
        const pauseKey = `pause_notified_${fromId}`;
        if (!await env.BOT_DB.get(pauseKey)) {
          await sendMessage(token, chatId, "😴 <b>主人当前处于免打扰状态</b>，机器人已暂停转接私信，请稍后再次联系～");
          await env.BOT_DB.put(pauseKey, 'true', { expirationTtl: 7200 });
        }
        return;
      }
    }

    // 广告过滤：首次警告、再犯封禁（修复误杀一刀切）
    const spamCheck = isSpamMessage(message);
    if (spamCheck.isSpam) {
      if (env.BOT_DB) {
        const warned = await env.BOT_DB.get(`warn_${fromId}`);
        if (warned) {
          await env.BOT_DB.put(`ban_${fromId}`, 'true');
          await sendMessage(token, chatId, `🚫 <b>再次发送违规内容，您的账号已被系统永久封禁。</b>\n原因：${spamCheck.reason}`);
        } else {
          await env.BOT_DB.put(`warn_${fromId}`, spamCheck.reason, { expirationTtl: 86400 });
          await sendMessage(token, chatId, `⚠️ <b>消息被系统拦截</b>：${spamCheck.reason}。\n此为一次警告（24小时内有效），再次发送将被封禁。`);
        }
      } else {
        await sendMessage(token, chatId, `⚠️ <b>消息被系统拦截</b>：${spamCheck.reason}。`);
      }
      return;
    }

    // 🛡️ 动态算术人机验证
    let isVerified = false;
    if (env.BOT_DB) {
      isVerified = (await env.BOT_DB.get(`verified_${fromId}`)) === 'true';
    }
    if (!isVerified) {
      const keyboard = { inline_keyboard: [[ { text: "🛡️ 启动安全验证", callback_data: "verify_start" } ]] };
      await sendMessageWithKeyboard(token, chatId, "🔒 <b>安全拦截</b>\n检测到新会话，请先完成真人验证。", keyboard);
      return;
    }

    if (text === '/start') {
      await sendMessage(token, chatId, "✅ <b>验证成功！</b>\n\n您可以直接发送任何消息（文字、图片、语音、视频等）。\n这是完全私密的双向聊天～");
      return;
    }

    if (!boundGroupId) {
      await sendMessage(token, ownerId, `⚠️ 有客户发消息，但您还没绑定接待室！\n请新建超级群拉机器人进群并发送 /bind`);
      return;
    }

    // 🕵️ 案底流水追踪
    const currentName = (message.from.first_name || '') + (message.from.last_name ? ' ' + message.from.last_name : '');
    let nameHistory = [];
    if (env.BOT_DB) {
      try {
        const historyStr = await env.BOT_DB.get(`history_names_${fromId}`);
        if (historyStr) {
          const parsed = JSON.parse(historyStr);
          if (Array.isArray(parsed)) nameHistory = parsed;
        }
      } catch (e) {}

      if (!nameHistory.includes(currentName)) {
        nameHistory.push(currentName);
        await env.BOT_DB.put(`history_names_${fromId}`, JSON.stringify(nameHistory));
      }
      await env.BOT_DB.put(`info_for_${fromId}`, JSON.stringify(message.from));
    }

    // 获取或创建独立话题
    let threadId = await getOrCreateTopic(token, env, fromId, message.from, boundGroupId);

    if (!threadId) return;

    // 转发消息至话题房间
    let forwardRes = await forwardMessage(token, boundGroupId, fromId, message.message_id, threadId);
    if (!forwardRes || !forwardRes.ok) {
      await env.BOT_DB.delete(`topic_for_${fromId}`);
      threadId = await getOrCreateTopic(token, env, fromId, message.from, boundGroupId);
      if (threadId) {
        forwardRes = await forwardMessage(token, boundGroupId, fromId, message.message_id, threadId);
      }
    }

    if (forwardRes && forwardRes.ok) {
      const groupMsgId = forwardRes.result.message_id;
      // 双向对称映射绑定（命名空间隔离：grp_=群侧，g_=私聊侧），任一端贴 👎 均可触发粉碎
      await env.BOT_DB.put(`msg_map_grp_${groupMsgId}`, `${fromId}_${message.message_id}`, { expirationTtl: 2592000 });
      await env.BOT_DB.put(`msg_map_g_${message.message_id}`, `${boundGroupId}_${groupMsgId}`, { expirationTtl: 2592000 });
    }
  }
}

// 智能降级中继：无条件接管 copyMessage 限制并建立对称映射
async function safeReplyToUser(token, targetUserId, chatId, message, env) {
  if (!env.BOT_DB) return { ok: false, error: 'KV 数据库未绑定，无法建立消息映射' };

  // 1. 如果是纯文字，直接调用 sendMessage 直发（原文必须 HTML 转义，避免 parse 报错丢消息）
  if (message.text && !message.caption) {
    const sendRes = await sendMessage(token, targetUserId, escapeHtml(message.text));
    if (sendRes && sendRes.ok) {
      const userMsgId = sendRes.result.message_id;
      await env.BOT_DB.put(`msg_map_grp_${message.message_id}`, `${targetUserId}_${userMsgId}`, { expirationTtl: 2592000 });
      await env.BOT_DB.put(`msg_map_g_${userMsgId}`, `${chatId}_${message.message_id}`, { expirationTtl: 2592000 });
      return { ok: true, directText: true };
    }
    return { ok: false, error: sendRes && sendRes.description ? sendRes.description : '纯文字直发失败' };
  }

  // 2. 多媒体尝试 copyMessage
  const copyRes = await copyMessage(token, targetUserId, chatId, message.message_id);
  if (copyRes && copyRes.ok) {
    const userMsgId = copyRes.result.message_id;
    await env.BOT_DB.put(`msg_map_grp_${message.message_id}`, `${targetUserId}_${userMsgId}`, { expirationTtl: 2592000 });
    await env.BOT_DB.put(`msg_map_g_${userMsgId}`, `${chatId}_${message.message_id}`, { expirationTtl: 2592000 });
    return { ok: true };
  }

  // 3. 多媒体附带说明文本时的优雅降级（caption 同样转义）
  const textContent = message.caption || '';
  if (textContent.trim()) {
    const sendRes = await sendMessage(token, targetUserId, escapeHtml(textContent));
    if (sendRes && sendRes.ok) {
      const userMsgId = sendRes.result.message_id;
      await env.BOT_DB.put(`msg_map_grp_${message.message_id}`, `${targetUserId}_${userMsgId}`, { expirationTtl: 2592000 });
      await env.BOT_DB.put(`msg_map_g_${userMsgId}`, `${chatId}_${message.message_id}`, { expirationTtl: 2592000 });
      return { ok: true, fallback: true };
    }
  }

  return {
    ok: false,
    error: copyRes && copyRes.description ? copyRes.description : '该多媒体消息受限，请在群设置中关闭“限制保存内容”'
  };
}

// ==================== 按钮回调事件处理 ====================
async function handleCallbackQuery(cb, env, token, ownerId, boundGroupId) {
  // 消息过旧时 Telegram 可能不下发 message 字段，兜底防止异常
  if (!cb.message) {
    await answerCallbackQuery(token, cb.id, "⚠️ 按钮已过期，请重新操作。", true);
    return;
  }

  const data = cb.data;
  const fromId = String(cb.from.id);
  const chatId = String(cb.message.chat.id);
  const messageId = cb.message.message_id;

  // 管理员分支
  if (isAuthorizedAdmin(fromId, chatId, env, boundGroupId)) {
    if (data === 'toggle_bot_off') {
      if (env.BOT_DB) await env.BOT_DB.put('bot_status', 'off');
      await answerCallbackQuery(token, cb.id, "⏸️ 机器人已暂停服务（开启免打扰）");
      const { messageText, keyboard } = await getAdminPanelMarkup(env);
      await editMessageTextWithKeyboard(token, chatId, messageId, messageText, keyboard);
      return;
    }
    else if (data === 'toggle_bot_on') {
      if (env.BOT_DB) await env.BOT_DB.put('bot_status', 'on');
      await answerCallbackQuery(token, cb.id, "▶️ 机器人已恢复正常接收");
      const { messageText, keyboard } = await getAdminPanelMarkup(env);
      await editMessageTextWithKeyboard(token, chatId, messageId, messageText, keyboard);
      return;
    }
    else if (data === 'toggle_test_mode') {
      const isMock = env.BOT_DB ? (await env.BOT_DB.get(`mock_guest_${ownerId}`) === 'true') : false;
      if (isMock) {
        if (env.BOT_DB) {
          await env.BOT_DB.delete(`mock_guest_${ownerId}`);
          await env.BOT_DB.delete(`verified_${ownerId}`);
        }
        await answerCallbackQuery(token, cb.id, "👑 已切换回超级管理员模式");
      } else {
        if (env.BOT_DB) {
          await env.BOT_DB.put(`mock_guest_${ownerId}`, 'true');
          await env.BOT_DB.delete(`verified_${ownerId}`);
        }
        await answerCallbackQuery(token, cb.id, "🎭 已切换为模拟陌生人！请直接在私聊发消息测试，退出发 /test off", true);
      }
      return;
    }
    else if (data.startsWith('ban_')) {
      const targetId = data.split('_')[1];
      if (env.BOT_DB) {
        await env.BOT_DB.put(`ban_${targetId}`, 'true');
        await env.BOT_DB.delete(`verified_${targetId}`); // 彻底清理会话态
      }
      await answerCallbackQuery(token, cb.id, `🚫 已封禁该用户`, true);
      const threadId = cb.message.message_thread_id;
      if (threadId) {
        const userInfoStr = env.BOT_DB ? await env.BOT_DB.get(`info_for_${targetId}`) : null;
        const info = userInfoStr ? safeParseJson(userInfoStr) : {};
        const name = (info.first_name || '') + (info.last_name ? ' ' + info.last_name : '');
        const safeTitle = `🚫 [已封禁]：${name}`.slice(0, 128);
        await editTopicName(token, chatId, threadId, safeTitle);
        // 同步话题名缓存，避免与 getOrCreateTopic 的比对逻辑打架
        if (env.BOT_DB) await env.BOT_DB.put(`topic_name_${threadId}`, safeTitle);
      }
      return;
    }
    else if (data.startsWith('note_')) {
      const threadId = cb.message.message_thread_id;
      if (threadId && env.BOT_DB) {
        await env.BOT_DB.put(`state_${threadId}`, `waiting_for_note:${fromId}`, { expirationTtl: 300 });
        await answerCallbackQuery(token, cb.id, "💡 已开启备注模式：\n请直接打字发送新备注！发送 /cancel 取消。\n(机器人会瞬间吞噬字迹，绝对不外发)", true);
      }
      return;
    }
    else if (data.startsWith('manage_banlist_')) {
      const origin = data.split('_')[2];
      const banNames = env.BOT_DB ? await listAllKeys(env.BOT_DB, 'ban_') : [];
      if (banNames.length === 0) {
        const kb = { inline_keyboard: [[{ text: "🔙 返回", callback_data: `back_${origin}` }]] };
        await editMessageTextWithKeyboard(token, chatId, messageId, "🟢 <b>目前黑名单为空</b>，没有被封禁的用户。", kb);
      } else {
        const kb = { inline_keyboard: [] };
        banNames.forEach(name => {
          const id = name.split('_')[1];
          kb.inline_keyboard.push([{ text: `🔓 解除封禁: ${id}`, callback_data: `unban_${id}_${origin}` }]);
        });
        kb.inline_keyboard.push([{ text: "🔙 返回", callback_data: `back_${origin}` }]);
        await editMessageTextWithKeyboard(token, chatId, messageId, "<b>🚫 黑名单管理列表</b>\n\n👇 点击下方对应按钮即可一键解封：", kb);
      }
      return;
    }
    else if (data.startsWith('unban_')) {
      const targetId = data.split('_')[1];
      const origin = data.split('_')[2];
      if (env.BOT_DB) {
        await env.BOT_DB.delete(`ban_${targetId}`);
        await env.BOT_DB.delete(`warn_${targetId}`); // 同步清掉反垃圾警告，避免解封后被旧警告直接升级封禁
      }
      await answerCallbackQuery(token, cb.id, `✅ 成功解封！`);

      const banNames = env.BOT_DB ? await listAllKeys(env.BOT_DB, 'ban_') : [];
      if (banNames.length === 0) {
        const kb = { inline_keyboard: [[{ text: "🔙 返回", callback_data: `back_${origin}` }]] };
        await editMessageTextWithKeyboard(token, chatId, messageId, `✅ 已解封 ${targetId}。\n🟢 <b>目前黑名单已空</b>。`, kb);
      } else {
        const kb = { inline_keyboard: [] };
        banNames.forEach(name => {
          const id = name.split('_')[1];
          kb.inline_keyboard.push([{ text: `🔓 解除封禁: ${id}`, callback_data: `unban_${id}_${origin}` }]);
        });
        kb.inline_keyboard.push([{ text: "🔙 返回", callback_data: `back_${origin}` }]);
        await editMessageTextWithKeyboard(token, chatId, messageId, `✅ 刚刚解封了 ${targetId}\n<b>🚫 黑名单列表</b>：`, kb);
      }
      return;
    }
    else if (data.startsWith('back_')) {
      const origin = data.split('_')[1];
      if (origin === 'start') {
        const { messageText, keyboard } = await getAdminPanelMarkup(env);
        await editMessageTextWithKeyboard(token, chatId, messageId, messageText, keyboard);
      } else {
        const panelData = await buildPanelData(env, origin);
        await editMessageTextWithKeyboard(token, chatId, messageId, panelData.text, panelData.keyboard);
      }
      return;
    }
  }

  // 🛡️ 访客算术验证
  if (data === 'verify_start') {
    const a = Math.floor(Math.random() * 9) + 1;
    const b = Math.floor(Math.random() * 9) + 1;
    const correctAns = a + b;

    if (env.BOT_DB) {
      await env.BOT_DB.put(`captcha_${fromId}`, correctAns.toString(), { expirationTtl: 300 });
      await env.BOT_DB.delete(`captcha_tries_${fromId}`); // 新一轮验证，清空错误计数
    }

    let answers = new Set([correctAns]);
    while (answers.size < 4) {
      let wrong = correctAns + Math.floor(Math.random() * 8) - 3;
      if (wrong !== correctAns && wrong > 0) answers.add(wrong);
    }
    let ansArray = Array.from(answers).sort(() => Math.random() - 0.5);

    const row = ansArray.map(num => ({ text: num.toString(), callback_data: `verify_ans_${num}` }));
    const keyboard = { inline_keyboard: [ row ] };

    await editMessageTextWithKeyboard(token, chatId, messageId, `🤖 <b>真人身份验证：</b>\n请问：<b>${a} ➕ ${b} ＝ ❓</b>`, keyboard);
    await answerCallbackQuery(token, cb.id, "");
  }
  else if (data.startsWith('verify_ans_')) {
    const selected = data.split('_')[2];
    const correct = env.BOT_DB ? await env.BOT_DB.get(`captcha_${fromId}`) : null;

    if (!correct) {
      await answerCallbackQuery(token, cb.id, "⚠️ 验证已超时，请重新发消息触发验证", true);
      return;
    }

    if (selected === correct) {
      if (env.BOT_DB) {
        await env.BOT_DB.put(`verified_${fromId}`, 'true');
        await env.BOT_DB.delete(`captcha_${fromId}`);
        await env.BOT_DB.delete(`captcha_tries_${fromId}`);
      }
      await answerCallbackQuery(token, cb.id, "✅ 验证通过！您现在可以发送消息了。", false);
      await editMessageTextWithKeyboard(token, chatId, messageId, "✅ <b>验证通过！</b>\n频道已解锁，请直接发送您的消息。", { inline_keyboard: [] });
    } else {
      // 🛡️ 错误次数上限 5 次，防止暴力枚举
      if (env.BOT_DB) {
        const tries = parseInt((await env.BOT_DB.get(`captcha_tries_${fromId}`)) || '0', 10) + 1;
        if (tries >= 5) {
          await env.BOT_DB.delete(`captcha_${fromId}`);
          await env.BOT_DB.delete(`captcha_tries_${fromId}`);
          await answerCallbackQuery(token, cb.id, "❌ 错误次数过多，验证已重置。请重新发送任意消息触发验证。", true);
          return;
        }
        await env.BOT_DB.put(`captcha_tries_${fromId}`, String(tries), { expirationTtl: 300 });
      }
      await answerCallbackQuery(token, cb.id, "❌ 回答错误，请重新选择正确的答案！", true);
    }
  }
}

// ==================== 话题工单与分级展示核心 ====================
async function getOrCreateTopic(token, env, userId, userInfo, groupId) {
  let threadId = env.BOT_DB ? await env.BOT_DB.get(`topic_for_${userId}`) : null;
  const note = env.BOT_DB ? await env.BOT_DB.get(`note_for_${userId}`) : null;
  const fullName = (userInfo.first_name || '') + (userInfo.last_name ? ' ' + userInfo.last_name : '');
  const safeName = fullName || '访客';
  const topicName = (note ? `👤 [${note}]：${safeName}` : `👤 ${safeName}`).slice(0, 128);

  // 话题已存在：精准比对是否真正更名，避免高频调用触发 Telegram 429 限流
  if (threadId) {
    if (env.BOT_DB && !(await env.BOT_DB.get(`user_for_${threadId}`))) {
      await env.BOT_DB.put(`user_for_${threadId}`, String(userId));
    }

    const lastTopicName = env.BOT_DB ? await env.BOT_DB.get(`topic_name_${threadId}`) : null;
    if (lastTopicName !== topicName) {
      await editTopicName(token, groupId, threadId, topicName);
      if (env.BOT_DB) await env.BOT_DB.put(`topic_name_${threadId}`, topicName);
      await refreshTopicDisplays(token, env, userId, threadId, groupId);
    }
    return threadId;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: groupId, name: topicName })
    });
    const json = await res.json();

    if (json.ok) {
      threadId = json.result.message_thread_id;
      if (env.BOT_DB) {
        await env.BOT_DB.put(`topic_for_${userId}`, String(threadId));
        await env.BOT_DB.put(`user_for_${threadId}`, String(userId));
        await env.BOT_DB.put(`topic_name_${threadId}`, topicName);
      }

      // 1. 发送【屏幕最上方固定的置顶栏】(单行极限压缩) 并置顶
      const pinnedLineText = await buildPinnedSingleLine(env, userId);
      const pinnedRes = await sendMessage(token, groupId, pinnedLineText, threadId);
      if (pinnedRes && pinnedRes.ok) {
        const pinnedMsgId = pinnedRes.result.message_id;
        if (env.BOT_DB) await env.BOT_DB.put(`pinned_line_msg_${threadId}`, String(pinnedMsgId));
        await fetch(`https://api.telegram.org/bot${token}/pinChatMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: groupId, message_id: pinnedMsgId })
        });
      }

      // 2. 发送【底部专属情报全底大卡片】
      const panelRes = await sendPanel(token, env, groupId, threadId, userId);
      if (panelRes && panelRes.ok) {
        if (env.BOT_DB) await env.BOT_DB.put(`panel_msg_${threadId}`, String(panelRes.result.message_id));
      }

      return threadId;
    } else {
      const errReason = json.description || '未知异常';
      console.error("创建话题失败:", errReason);
      await sendMessage(token, userId, `⚠️ <b>建房被拒绝</b>：<code>${escapeHtml(errReason)}</code>\n（群ID: <code>${groupId}</code>）`);
      return null;
    }
  } catch (err) {
    console.error("调用 createForumTopic 异常:", err);
    await sendMessage(token, userId, `⚠️ <b>网络请求异常</b>：${escapeHtml(err.message)}`);
    return null;
  }
}

// 刷新置顶单行栏与底部卡片
async function refreshTopicDisplays(token, env, userId, threadId, chatId) {
  if (!env.BOT_DB) return;

  const pinnedMsgId = await env.BOT_DB.get(`pinned_line_msg_${threadId}`);
  if (pinnedMsgId) {
    const singleLine = await buildPinnedSingleLine(env, userId);
    await editMessageText(token, chatId, pinnedMsgId, singleLine);
  }

  const panelMsgId = await env.BOT_DB.get(`panel_msg_${threadId}`);
  if (panelMsgId) {
    const panelData = await buildPanelData(env, userId);
    await editMessageTextWithKeyboard(token, chatId, panelMsgId, panelData.text, panelData.keyboard);
  }
}

// 📌 【屏幕最上方固定的置顶栏】极限单行压缩版（置顶看原形）
async function buildPinnedSingleLine(env, userId) {
  const infoStr = env.BOT_DB ? await env.BOT_DB.get(`info_for_${userId}`) : null;
  const info = infoStr ? safeParseJson(infoStr) : {};
  const currentName = escapeHtml((info.first_name || '') + (info.last_name ? ' ' + info.last_name : '')) || '访客';
  const username = info.username ? `@${escapeHtml(info.username)}` : '无';

  let nameHistory = [];
  if (env.BOT_DB) {
    try {
      const historyStr = await env.BOT_DB.get(`history_names_${userId}`);
      if (historyStr) {
        const parsed = JSON.parse(historyStr);
        if (Array.isArray(parsed)) nameHistory = parsed;
      }
    } catch (e) {}
  }

  const customNote = env.BOT_DB ? await env.BOT_DB.get(`note_for_${userId}`) : null;
  const noteDisplay = customNote ? escapeHtml(customNote) : '无';

  let originalNote = '';
  if (nameHistory.length > 1) {
    originalNote = ` (原:${escapeHtml(nameHistory[0])})`;
  }

  return `📌 昵称: ${currentName} | 备注: ${noteDisplay}${originalNote} | ✈️ ${username} | 🆔 <code>${userId}</code>`;
}

// 📐 【卡片查全底】全角对齐 + 曾用名案底流水展现
async function buildPanelData(env, userId) {
  const infoStr = env.BOT_DB ? await env.BOT_DB.get(`info_for_${userId}`) : null;
  const info = infoStr ? safeParseJson(infoStr) : {};
  const currentName = escapeHtml((info.first_name || '') + (info.last_name ? ' ' + info.last_name : ''));
  const username = info.username ? `@${escapeHtml(info.username)}` : '未设置';

  let nameHistory = [];
  if (env.BOT_DB) {
    try {
      const historyStr = await env.BOT_DB.get(`history_names_${userId}`);
      if (historyStr) {
        const parsed = JSON.parse(historyStr);
        if (Array.isArray(parsed)) nameHistory = parsed;
      }
    } catch (e) {}
  }

  const customNote = env.BOT_DB ? await env.BOT_DB.get(`note_for_${userId}`) : null;
  const noteDisplay = customNote ? escapeHtml(customNote) : '未设置';

  let historySection = '';
  if (nameHistory.length > 1) {
    const trajectory = nameHistory.map(n => escapeHtml(n)).join(' ➔ ');
    historySection = `\n⚠️ <b>曾用案底</b>：${trajectory}`;
  }

  const text = `╭━━━ 👤 <b>访客专属情报</b> ━━━╮
🏷️ <b>备 注</b>：${noteDisplay}
👤 <b>昵 称</b>：${currentName}
✈️ <b>用户名</b>：${username}
🆔 <b>Ｉ Ｄ</b>：<code>${userId}</code>${historySection}
╰━━━━━━━━━━━━━━━╯
💡 <b>操作</b>：右键发错的消息贴 👎(踩) 表情，可瞬间双向强制删除！`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🚫 一键封禁", callback_data: `ban_${userId}` },
        { text: "✏️ 修改备注", callback_data: `note_${userId}` },
        { text: "📋 管理黑名单", callback_data: `manage_banlist_${userId}` }
      ]
    ]
  };
  return { text, keyboard };
}

async function sendPanel(token, env, groupId, threadId, userId) {
  const data = await buildPanelData(env, userId);
  return await sendMessageWithKeyboard(token, groupId, data.text, data.keyboard, threadId);
}

// ==================== 底层 Telegram 原生 API ====================
async function sendMessage(token, chatId, text, threadId = null) {
  const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
  if (threadId) payload.message_thread_id = threadId;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return await res.json();
}

async function sendMessageWithKeyboard(token, chatId, text, keyboard, threadId = null) {
  const payload = { chat_id: chatId, text: text, parse_mode: 'HTML', reply_markup: keyboard };
  if (threadId) payload.message_thread_id = threadId;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return await res.json();
}

async function answerCallbackQuery(token, cbId, text = "", showAlert = false) {
  const payload = { callback_query_id: cbId };
  if (text) {
    payload.text = text;
    payload.show_alert = showAlert;
  }
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function editMessageText(token, chatId, messageId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' })
    });
    const json = await res.json();
    if (!json.ok && !json.description?.includes('message is not modified')) {
      console.warn("editMessageText 警告:", json.description);
    }
  } catch (e) {}
}

async function editMessageTextWithKeyboard(token, chatId, messageId, text, keyboard) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML', reply_markup: keyboard })
    });
    const json = await res.json();
    if (!json.ok && !json.description?.includes('message is not modified')) {
      console.warn("editMessageTextWithKeyboard 警告:", json.description);
    }
  } catch (e) {}
}

async function copyMessage(token, targetChatId, fromChatId, messageId, threadId = null) {
  const payload = { chat_id: targetChatId, from_chat_id: fromChatId, message_id: messageId };
  if (threadId) payload.message_thread_id = threadId;
  const res = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return await res.json();
}

async function forwardMessage(token, targetChatId, fromChatId, messageId, threadId = null) {
  const payload = { chat_id: targetChatId, from_chat_id: fromChatId, message_id: messageId };
  if (threadId) payload.message_thread_id = threadId;
  const res = await fetch(`https://api.telegram.org/bot${token}/forwardMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return await res.json();
}

async function deleteMessage(token, chatId, messageId) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) });
  } catch (e) {}
}

async function editTopicName(token, chatId, threadId, name) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/editForumTopic`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_thread_id: threadId, name: name.slice(0, 128) }) });
  } catch (e) {}
}
