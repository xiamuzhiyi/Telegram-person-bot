/**
 * 🐰 话题工单增强版（三源融合版）
 *
 * 以「话题工单增强版」为主代码骨架（KV 架构），先后融合：
 *   【流氓兔私聊大厅工单系统 6.0】：
 *   - safeApiCall 统一防崩通讯层 / 满级验证码引擎（加减混合/30秒限时/自动换题/3次错临时封禁/消息暂存无痕补发/并发锁）
 *   - 建房并发锁 / 黑名单瞬时索引+分页 / 封禁按钮智能切换 / 备注按钮三态切换
 *   - 转发降级链（forward → 重建话题 → copy → 终极防丢私聊警报）
 *   - 系统服务消息自动清理 / 置顶栏与卡片丢失自动重建 / 全角对齐排版引擎
 *   【双向bot源码（D1 版）】：
 *   - 双向消息编辑同步（访客编辑→话题通知；管理员编辑回复→用户通知，含原/新内容与时间对比）
 *   - 管理员多媒体直发降级（图片/视频/语音/贴纸/GIF/文件按 file_id 直发）
 *   - 关键词自动回复规则管理 / 可配置屏蔽关键词+计数阈值自动封禁
 *   - 8 类内容按类型过滤开关（用户/群组/频道转发、音频语音、贴纸GIF、媒体、链接、纯文本）
 *   - 群发系统（/broadcast 文本·复制·带说明媒体四模式 + /broadcast_status + /broadcast_retry_failed 失败重试 + 429 限速重试 + 自动标记拉黑）
 *   - 静音通知 / 资料卡「查看用户资料」按钮（隐私受限自动降级）/ 📌 置顶卡片
 *   - 消息备份群组 / 验证模式切换（算术题⇄一键按钮）/ 可配置欢迎语 / 协管员授权白名单 / 用户资料卡汇总话题
 *
 * ⚠️ 【机器人权限必读】请务必给机器人在大本营群组中授予 100% 管理员权限：
 *    【管理主题 Manage Topics】、【删除消息 Delete Messages】、【置顶消息 Pin Messages】
 *
 * 🛠️ 环境变量设置（全部在 CF 后台 [设置] -> [变量和机密] 中配置，代码内不写任何密码）：
 *    - BOT_TOKEN（或 TOKEN）：机器人 Token
 *    - OWNER_ID：超管纯数字 ID
 *    - SECRET_PATH（或 PASSWORD）：Webhook 暗号路径（默认 /xiagefei120）
 *    - WEBHOOK_SECRET（建议）：Webhook 防伪造密钥
 *    - OWNER_GROUP_IDS（可选）：备用授权群组，逗号分隔
 *    - KV 绑定：变量名 BOT_DB（必须全大写）
 *
 * 🚀 部署后访问 https://你的Worker域名/setup 一键激活 Webhook（需重新执行以订阅 edited_message），
 *    然后新建开启「话题」的超级群，拉入机器人并发送 /bind 绑定大本营。
 *    私聊机器人发送 /start 呼出控制台，控制台内可进入 ⚙️ 系统配置。
 */

// ==================== 默认配置兜底 ====================
const DEFAULT_OWNER_ID = '8913877802';
const DEFAULT_OWNER_GROUP_IDS = '';
const DEFAULT_SECRET_PATH = '/xiagefei120';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getToken(env) {
  return env.BOT_TOKEN || env.TOKEN || '';
}

// 暗号路径：兼容 SECRET_PATH 与流氓兔版的 PASSWORD 两种环境变量
function getSecretPath(env) {
  let path = env.SECRET_PATH || env.PASSWORD || DEFAULT_SECRET_PATH;
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

// ==================== 系统配置读写（KV 版 getConfig） ====================
async function getCfg(env, key, defaultValue) {
  if (env.BOT_DB) {
    const v = await env.BOT_DB.get(`cfg:${key}`);
    if (v !== null && v !== undefined) return v;
  }
  return defaultValue;
}

async function setCfg(env, key, value) {
  if (env.BOT_DB) await env.BOT_DB.put(`cfg:${key}`, String(value));
}

async function getJsonCfg(env, key, fallback) {
  const raw = await getCfg(env, key, null);
  if (raw === null) return fallback;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : fallback;
  } catch (e) {
    return fallback;
  }
}

// 协管员授权白名单（融合自双向bot源码）
async function getAuthorizedAdmins(env) {
  return await getJsonCfg(env, 'authorized_admins', []);
}

// 8 类内容过滤开关（转发来源类默认屏蔽，保持主代码反引流基调；其余默认允许）
async function getForwardFilters(env) {
  const bool = async (k, d) => (await getCfg(env, k, d)) === 'true';
  return {
    user_forward: await bool('enable_user_forwarding', 'false'),
    group_forward: await bool('enable_group_forwarding', 'false'),
    channel_forward: await bool('enable_channel_forwarding', 'false'),
    audio_voice: await bool('enable_audio_forwarding', 'true'),
    sticker_gif: await bool('enable_sticker_forwarding', 'true'),
    media: await bool('enable_image_forwarding', 'true'),
    link: await bool('enable_link_forwarding', 'true'),
    text: await bool('enable_text_forwarding', 'true')
  };
}

function isAuthorizedAdminSync(userId, chatId, env, boundGroupId) {
  const ownerId = String(env.OWNER_ID || DEFAULT_OWNER_ID);
  const authorizedGroups = getAuthorizedGroups(env);
  const uId = String(userId);
  const cId = String(chatId);

  return (ownerId && uId === ownerId) || (boundGroupId && cId === boundGroupId) || authorizedGroups.includes(cId);
}

// 管理员判定：超管 / 绑定群成员 / 备用授权群 / 协管员白名单
async function isAuthorizedAdmin(userId, chatId, env, boundGroupId) {
  if (isAuthorizedAdminSync(userId, chatId, env, boundGroupId)) return true;
  const admins = await getAuthorizedAdmins(env);
  return admins.includes(String(userId));
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

// ==================== 黑名单瞬时索引（解决 KV list() 全局同步延迟） ====================
async function getBanIndex(env) {
  if (!env.BOT_DB) return [];
  const str = await env.BOT_DB.get('banlist_index');
  if (str !== null) {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr)) return arr;
    } catch (e) {}
  }
  const keys = await listAllKeys(env.BOT_DB, 'ban_');
  const ids = keys.map(k => k.split('_')[1]).filter(Boolean);
  await setBanIndex(env, ids);
  return ids;
}

async function setBanIndex(env, arr) {
  if (env.BOT_DB) await env.BOT_DB.put('banlist_index', JSON.stringify(arr));
}

async function syncBanIndex(env, targetId, isBanning) {
  let banIndex = await getBanIndex(env);
  if (isBanning) {
    if (!banIndex.includes(targetId)) {
      banIndex.push(targetId);
      await setBanIndex(env, banIndex);
    }
  } else {
    banIndex = banIndex.filter(id => id !== targetId);
    await setBanIndex(env, banIndex);
  }
}

// ==================== 广告与违规规则过滤 ====================
// forwardToggles：三类转发来源开关全关时保持原「警告→封禁」严格策略；任一开启时交由细粒度过滤器提示
function isSpamMessage(message, forwardToggles = { user_forward: false, group_forward: false, channel_forward: false }) {
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
    const anyForwardAllowed = forwardToggles.user_forward || forwardToggles.group_forward || forwardToggles.channel_forward;
    if (!anyForwardAllowed) {
      return { isSpam: true, reason: '禁止转发第三方消息引流' };
    }
  }

  return { isSpam: false };
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

// 格式化 Unix 秒级时间戳（融合自双向bot源码）
function formatTimestamp(timestamp) {
  if (!timestamp) return '时间未知';
  try {
    return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
  } catch (e) {
    return String(timestamp);
  }
}

// ==================== 全角对齐排版引擎（悬垂缩进曾用名展示） ====================
function getCjkWidth(str) {
  let w = 0;
  for (let i = 0; i < str.length; i++) w += str.charCodeAt(i) > 255 ? 1 : 0.55;
  return Math.round(w);
}

function formatHangingIndentEscaped(namesRaw, prefixRaw, suffixRaw) {
  let result = escapeHtml(prefixRaw);
  const padLen = 6 + getCjkWidth(prefixRaw);
  const padStr = '　'.repeat(padLen);
  const maxLineLen = 22;
  let currentW = 6 + getCjkWidth(prefixRaw);

  for (let i = 0; i < namesRaw.length; i++) {
    const isLast = (i === namesRaw.length - 1);
    const additionRaw = namesRaw[i] + (isLast ? '' : '、');
    const additionEsc = escapeHtml(namesRaw[i]) + (isLast ? '' : '、');
    const addW = getCjkWidth(additionRaw);

    if (currentW + addW > maxLineLen && currentW > padLen) {
      result += '\n' + padStr + additionEsc;
      currentW = padLen + addW;
    } else {
      result += additionEsc;
      currentW += addW;
    }
  }
  return result + escapeHtml(suffixRaw);
}

// ==================== 管理后台控制面板 ====================
async function getAdminPanelMarkup(env) {
  let isPaused = false;
  if (env.BOT_DB) {
    const status = await env.BOT_DB.get('bot_status');
    isPaused = status === 'off';
  }

  const toggleBtn = isPaused
    ? { text: "🟡 机器人已暂停 (点击开启)", callback_data: "toggle_bot_on" }
    : { text: "🟢 机器人运行中 (点击关闭)", callback_data: "toggle_bot_off" };

  const keyboard = {
    inline_keyboard: [
      [toggleBtn],
      [{ text: "🎭 切换模拟陌生人测试", callback_data: "toggle_test_mode" }],
      [{ text: "📋 点击管理黑名单", callback_data: "manage_banlist_start_0" }],
      [{ text: "⚙️ 系统配置", callback_data: "config:menu" }],
      [{ text: "📣 群发助手", callback_data: "config:broadcast_help" }]
    ]
  };

  const statusText = isPaused
    ? "🌙 <b>当前状态：已暂停服务</b>（访客来信将被拦截并提示免打扰）"
    : "🚀 <b>当前状态：正常运行中</b>（可正常接收并建立接待室）";

  const messageText = `👨‍💻 <b>管理员您好！这里是全局控制台。</b>\n\n${statusText}\n\n💡 提示：输入 <code>/test on</code> 可随时切换为陌生人测试模式；<code>/broadcast</code> 可群发消息。`;
  return { messageText, keyboard };
}

// ==================== 主入口 (ES Modules 规范) ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secretPath = getSecretPath(env);
    const token = getToken(env);
    const webhookSecret = getWebhookSecret(env);

    // 🚀 一键配置 Webhook（仅允许 GET，注入 secret_token 防伪造；订阅 edited_message 支持双向编辑同步）
    if (url.pathname === '/setup') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      if (!token) return new Response('Missing BOT_TOKEN in Environment Variables', { status: 500 });
      const webhookUrl = `${url.origin}${secretPath}`;
      const payload = {
        url: webhookUrl,
        allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"],
        drop_pending_updates: true
      };
      if (webhookSecret) payload.secret_token = webhookSecret;
      const res = await safeApiCall(token, 'setWebhook', payload);
      return new Response(JSON.stringify(res, null, 2), { headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
    }

    // 门禁拦截
    if (url.pathname !== secretPath) {
      return new Response('Access Denied (暗号不匹配)', { status: 403 });
    }

    // GET 健康自检（不再回显超管个人 ID）
    if (request.method === 'GET') {
      let boundGroupId = env.BOT_DB ? await env.BOT_DB.get('OWNER_GROUP_ID') : null;
      if (!boundGroupId && env.OWNER_GROUP_IDS) boundGroupId = env.OWNER_GROUP_IDS.split(',')[0].trim();

      return new Response(`Worker 话题工单融合版运行正常！\nToken 状态: ${token ? '已配置 ✅' : '缺失 ❌'}\nKV 状态: ${env.BOT_DB ? '已绑定 ✅' : '未绑定 ❌'}\nWebhook 防伪造: ${webhookSecret ? '已启用 ✅' : '未配置 ⚠️ (建议设置 WEBHOOK_SECRET)'}\n接待大本营群组: ${boundGroupId || '未绑定 (请在群内发送 /bind)'}`, {
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

  // 👎【霸王级隐私特权】原生 👎 反应秒级双向粉碎（双向对称反查）
  if (update.message_reaction) {
    const reaction = update.message_reaction;
    const chatId = String(reaction.chat.id);
    const userId = String(reaction.user?.id || '');

    if (await isAuthorizedAdmin(userId, chatId, env, boundGroupId) && env.BOT_DB) {
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

  // 🔘 内联按钮回调
  if (update.callback_query) {
    return await handleCallbackQuery(update.callback_query, env, token, ownerId, boundGroupId);
  }

  // ✏️ 双向编辑同步：访客编辑消息 → 话题通知；管理员编辑回复 → 用户通知（融合自双向bot源码）
  if (update.edited_message) {
    const em = update.edited_message;
    if (!em.from) return;
    const emChatId = String(em.chat.id);
    const emFromId = String(em.from.id);

    if (em.chat.type === 'private') {
      const isMockGuestActive = (emFromId === ownerId) && (env.BOT_DB ? (await env.BOT_DB.get(`mock_guest_${ownerId}`) === 'true') : false);
      if (emFromId !== ownerId || isMockGuestActive) {
        await handleGuestEditedMessage(token, env, em, emFromId, boundGroupId);
      }
    } else if (boundGroupId && emChatId === boundGroupId && em.is_topic_message && em.message_thread_id) {
      await handleAdminEditedReply(token, env, em, boundGroupId);
    }
    return;
  }

  // 🚫 edited_message 之外的其他非 message 更新一律忽略
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = String(message.chat.id);
  const fromId = String(message.from.id);
  const text = message.text ? message.text.trim() : '';

  // 🧹 自动清理置顶与修改主题产生的系统提示消息（避免大本营被服务消息刷屏）
  if (message.pinned_message || message.forum_topic_edited) {
    if (boundGroupId && chatId === boundGroupId && message.message_thread_id) {
      await deleteMessage(token, chatId, message.message_id);
      return;
    }
  }

  // 🧪 超管专属模式控制
  if (message.chat.type === 'private' && fromId === ownerId) {
    // 📣 群发系统（融合自双向bot源码，仅超管可用）
    if (text === '/broadcast' || text.startsWith('/broadcast ')) {
      await handleBroadcastCommand(token, env, message, chatId);
      return;
    }
    if (text === '/broadcast_status') {
      const report = await loadBroadcastLastReport(env);
      await sendMessage(token, chatId, report ? buildBroadcastStatusText(report) : "📭 暂无最近一次群发报告，请先执行 <code>/broadcast</code>。");
      return;
    }
    if (text === '/broadcast_retry_failed') {
      await handleBroadcastRetryFailed(token, env, chatId);
      return;
    }

    // ⚙️ 系统配置输入态（等待管理员输入配置值）
    if (env.BOT_DB) {
      const adminStateStr = await env.BOT_DB.get(`admin_state_${ownerId}`);
      if (adminStateStr) {
        await handleAdminConfigInput(token, env, chatId, text, adminStateStr);
        return;
      }
    }

    if (text === '/test on') {
      if (env.BOT_DB) {
        await env.BOT_DB.put(`mock_guest_${ownerId}`, 'true');
        await env.BOT_DB.delete(`verified_${ownerId}`);
      }
      await sendMessage(token, chatId, "🧪 <b>已开启【模拟陌生人测试模式】</b>！\n接下来您在私聊发送的消息将被当作真实访客处理，会触发验证并在接待大本营生成工单。\n\n退出测试请随时发送：<code>/test off</code>");
      return;
    }
    if (text === '/test off') {
      if (env.BOT_DB) {
        await env.BOT_DB.delete(`mock_guest_${ownerId}`);
        await env.BOT_DB.delete(`verified_${ownerId}`);
      }
      await sendMessage(token, chatId, "🛡️ <b>已退出测试模式</b>，恢复超级管理员控制台身份。输入 /start 呼出管理菜单。");
      return;
    }

    const isMockGuest = env.BOT_DB ? (await env.BOT_DB.get(`mock_guest_${ownerId}`) === 'true') : false;
    if (!isMockGuest && text.startsWith('/start')) {
      const { messageText, keyboard } = await getAdminPanelMarkup(env);
      await sendMessage(token, chatId, messageText, null, keyboard);
      return;
    }
  }

  // 🏠 大本营超级群绑定指令
  if (message.chat.type === 'supergroup' && fromId === ownerId && text === '/bind') {
    if (env.BOT_DB) {
      await env.BOT_DB.put('OWNER_GROUP_ID', chatId);
      await sendMessage(token, chatId, "✅ <b>绑定成功！</b>\n当前群组已设为「工单大本营」。\n新访客的私聊将自动以独立房间的形式发送到这里。");
    } else {
      await sendMessage(token, chatId, "❌ 绑定失败：未检测到绑定的 KV 数据库。");
    }
    return;
  }

  // 🌟 主人在大本营大厅直呼总控制台（话题外发送 /start）
  if (boundGroupId && chatId === boundGroupId && fromId === ownerId && text === '/start' && !message.message_thread_id) {
    const { messageText, keyboard } = await getAdminPanelMarkup(env);
    await sendMessage(token, chatId, messageText, null, keyboard);
    return;
  }

  // 💬 管理员在工单话题房间内回复访客 / 备注 / 救援绑定
  const isGroupAdminReply = (boundGroupId && chatId === boundGroupId && message.message_thread_id) ||
                            (getAuthorizedGroups(env).includes(chatId) && message.message_thread_id);

  if (isGroupAdminReply) {
    if (!(await isAuthorizedAdmin(fromId, chatId, env, boundGroupId))) return;

    const threadId = message.message_thread_id;

    // 🚑 救援指令：强制手动绑定当前房间到任意用户 ID
    if (text.startsWith('/binduser')) {
      const parts = text.split(/\s+/);
      const manualUserId = parts[1];
      if (!manualUserId || !/^\d+$/.test(manualUserId)) {
        await sendMessage(token, chatId, "❌ 格式错误！请指定目标用户的纯数字 ID，例如：<code>/binduser 123456789</code>", threadId);
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
        await safeApiCall(token, 'pinChatMessage', { chat_id: Number(chatId), message_id: Number(pinnedRes.result.message_id) });
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

    // 🔄 自动反向溯源自愈
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
      await sendMessage(token, chatId, `⛔ <b>发送中断：该房间未关联到访客 ID</b>\n\n🚑 <b>快速解决方案</b>：\n如果您知道访客的数字 ID，可直接在此房间发送：\n<code>/binduser 访客ID</code> 进行一键强制绑定！`, threadId);
      return;
    }

    // 接收输入的备注文本并瞬间吞噬字迹
    const currentState = env.BOT_DB ? await env.BOT_DB.get(`state_${threadId}`) : null;
    if (currentState && currentState.startsWith('waiting_for_note:')) {
      const expectedAdminId = currentState.split(':')[1];
      if (fromId === expectedAdminId) {
        await deleteMessage(token, chatId, message.message_id);

        // 📝 备注模式仅接受文本，媒体消息不再误写为「已备注」
        if (!message.text) {
          await sendMessage(token, chatId, "⚠️ 备注模式仅支持文本，请直接打字发送新备注（发送 /cancel 可取消）。", threadId);
          return;
        }

        if (text === '/cancel') {
          await env.BOT_DB.delete(`state_${threadId}`);
          await cleanupNotePrompt(token, env, chatId, threadId);
          await sendMessage(token, chatId, "✅ 已取消修改备注。", threadId);
          await updateTopicAndPanel(token, env, targetUserId, threadId, chatId);
          return;
        }

        const newNote = text || "已备注";
        await env.BOT_DB.put(`note_for_${targetUserId}`, newNote);
        await env.BOT_DB.delete(`state_${threadId}`);
        await cleanupNotePrompt(token, env, chatId, threadId);

        await updateTopicAndPanel(token, env, targetUserId, threadId, chatId);
        return;
      }
    }

    // 正常打字回复：智能中继
    const replyRes = await safeReplyToUser(token, targetUserId, chatId, message, env);
    if (!replyRes.ok) {
      const desc = replyRes.error || '未知原因';
      if (desc.includes('blocked') || desc.includes('deactivated')) {
        await sendMessage(token, chatId, `🚫 发送失败：访客已主动拉黑或注销了账号。`, threadId);
      } else if (desc.includes('chat not found')) {
        await sendMessage(token, chatId, `🚫 发送失败：目标用户从未在私聊启动过本机器人。`, threadId);
      } else if (desc.includes("can't be copied") || desc.includes('限制保存内容')) {
        await sendMessage(token, chatId, `⚠️ <b>发送失败</b>：大本营开启了「限制保存内容」，且该消息没有文字/备注，无法强行提取发送。\n👉 请在群设置中关闭“限制保存内容”选项。`, threadId);
      } else {
        await sendMessage(token, chatId, `❌ 发送失败：Telegram 接口报错: <code>${escapeHtml(desc)}</code>`, threadId);
      }
    }
    return;
  }

  // 📨 外部客户私聊入口
  const isMockGuestActive = (fromId === ownerId) && (env.BOT_DB ? (await env.BOT_DB.get(`mock_guest_${ownerId}`) === 'true') : false);
  const shouldProcessAsGuest = (message.chat.type === 'private') && (fromId !== ownerId || isMockGuestActive);

  if (shouldProcessAsGuest) {
    const forwardToggles = await getForwardFilters(env);

    if (env.BOT_DB && await env.BOT_DB.get(`ban_${fromId}`)) return;

    // 免打扰拦截
    if (env.BOT_DB) {
      const botStatus = await env.BOT_DB.get('bot_status');
      if (botStatus === 'off') {
        const pauseKey = `pause_notified_${fromId}`;
        if (!await env.BOT_DB.get(pauseKey)) {
          await sendMessage(token, chatId, "🌙 <b>主人当前处于免打扰状态</b>，机器人已暂停转接私信，请稍后再次联系～");
          await env.BOT_DB.put(pauseKey, 'true', { expirationTtl: 7200 });
        }
        return;
      }
    }

    // 广告过滤：首次警告、再犯封禁（修复误杀一刀切；转发来源开关任一开启时交由细粒度过滤器处理）
    const spamCheck = isSpamMessage(message, forwardToggles);
    if (spamCheck.isSpam) {
      if (env.BOT_DB) {
        const warned = await env.BOT_DB.get(`warn_${fromId}`);
        if (warned) {
          await env.BOT_DB.put(`ban_${fromId}`, 'true');
          await syncBanIndex(env, fromId, true);
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

    // 🚫 临时防滥用封禁检查（验证连续答错 3 次触发，5 分钟冷却）
    if (env.BOT_DB) {
      const tempBanEnd = await env.BOT_DB.get(`temp_ban_${fromId}`);
      if (tempBanEnd) {
        const timeLeft = Math.ceil((parseInt(tempBanEnd, 10) - Date.now()) / 1000);
        if (timeLeft > 0) {
          const min = Math.floor(timeLeft / 60);
          const sec = timeLeft % 60;
          await sendMessage(token, chatId, `🚫 <b>防滥用系统生效中！</b>\n\n您已被限制，请在 <b>${min}分${sec}秒</b> 后重新触发验证。`);
          return;
        }
        await env.BOT_DB.delete(`temp_ban_${fromId}`);
        await env.BOT_DB.delete(`strikes_${fromId}`);
      }
    }

    // 🔐 满级动态算术人机验证（未验证消息暂存，验证通过后无痕补发；支持一键按钮/算术题双模式）
    let isVerified = false;
    if (env.BOT_DB) {
      isVerified = (await env.BOT_DB.get(`verified_${fromId}`)) === 'true';
      // 🧑‍💻 协管员白名单自动绕过验证（融合自双向bot源码：管理员私聊免验证）
      if (!isVerified) {
        const coAdmins = await getAuthorizedAdmins(env);
        if (coAdmins.includes(fromId)) {
          await env.BOT_DB.put(`verified_${fromId}`, 'true');
          isVerified = true;
        }
      }
    }
    if (!isVerified) {
      if (env.BOT_DB) {
        // 暂存未验证客户的首条消息（5 分钟有效）
        if (text !== '/start') {
          await env.BOT_DB.put(`pending_msg_${fromId}`, JSON.stringify(message), { expirationTtl: 300 });
        }

        // 🛡️ 并发锁：防止连续发图/多条消息触发多次验证（媒体组按组锁定）
        const lockKey = message.media_group_id ? `lock_mg_${message.media_group_id}` : `lock_captcha_${fromId}`;
        const isLocked = await env.BOT_DB.get(lockKey);
        if (!isLocked) {
          await env.BOT_DB.put(lockKey, '1', { expirationTtl: 60 });
          const welcomeMsg = escapeHtml(await getCfg(env, 'welcome_msg', '检测到新会话，请先完成真人验证。'));
          const verifyMode = await getCfg(env, 'verification_mode', 'math');
          let keyboard;
          if (verifyMode === 'button') {
            keyboard = { inline_keyboard: [[{ text: "✅ 点击这里验证身份", callback_data: "verify_button" }]] };
          } else {
            keyboard = { inline_keyboard: [[{ text: "🔐 启动安全验证", callback_data: "verify_start" }]] };
          }
          await sendMessage(token, chatId, `🔒 <b>安全拦截</b>\n${welcomeMsg}`, null, keyboard);
        }
      } else {
        const keyboard = { inline_keyboard: [[{ text: "🔐 启动安全验证", callback_data: "verify_start" }]] };
        await sendMessage(token, chatId, "🔒 <b>安全拦截</b>\n检测到新会话，请先完成真人验证。", null, keyboard);
      }
      return;
    }

    if (text === '/start') {
      await sendMessage(token, chatId, "✅ <b>验证成功！</b>\n\n您可以直接发送任何消息（文字、图片、语音、视频等）。\n这是完全私密的双向聊天～");
      return;
    }

    // 🔗 按类型过滤检查（融合自双向bot源码：用户/群组/频道转发、音频语音、贴纸GIF、媒体、链接、纯文本）
    if (await checkForwardTypeFilters(token, env, message, chatId, forwardToggles)) return;

    // 🚫 可配置屏蔽关键词计数检查（达阈值自动封禁，融合自双向bot源码）
    if (await checkBlockKeywords(token, env, fromId, text, chatId)) return;

    // 🤖 关键词自动回复规则（命中即自动回复，不再转发，融合自双向bot源码）
    if (await checkAutoReplyRules(token, env, fromId, text, chatId)) return;

    if (!boundGroupId) {
      await sendMessage(token, ownerId, `⚠️ 有客户发消息，但您还没绑定接待室！\n请新建超级群拉机器人进群并发送 /bind`);
      return;
    }

    // 🔕 静音状态（静音后转发的消息在群内静默，不提醒管理员）
    const isMuted = env.BOT_DB ? (await env.BOT_DB.get(`mute_${fromId}`)) === 'true' : false;

    // 📇 案底流水追踪（改名自动去重并移至队尾）
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

      if (nameHistory.length === 0) {
        nameHistory.push(currentName);
        await env.BOT_DB.put(`history_names_${fromId}`, JSON.stringify(nameHistory));
      } else if (nameHistory[nameHistory.length - 1] !== currentName) {
        nameHistory = nameHistory.filter(n => n !== currentName);
        nameHistory.push(currentName);
        await env.BOT_DB.put(`history_names_${fromId}`, JSON.stringify(nameHistory));
      }
      await env.BOT_DB.put(`info_for_${fromId}`, JSON.stringify(message.from));
    }

    // 获取或创建独立话题（内含建房并发锁）
    let threadId = await getOrCreateTopic(token, env, fromId, message.from, boundGroupId);

    // 改名后即时刷新话题标题与情报面板
    if (threadId && env.BOT_DB) {
      const lastTopicName = await env.BOT_DB.get(`topic_name_${threadId}`);
      const expected = await buildTopicTitle(env, fromId);
      if (lastTopicName !== expected) {
        await updateTopicAndPanel(token, env, fromId, threadId, boundGroupId);
      }
    }

    if (!threadId) return;

    // 📨 转发消息至话题房间（转发降级链：forward → 重建话题 → copy；静音用户静默投递）
    let forwardRes = await forwardMessage(token, boundGroupId, fromId, message.message_id, threadId, { disable_notification: isMuted });
    if (!forwardRes || !forwardRes.ok) {
      const desc = forwardRes ? (forwardRes.description || '') : '';
      if (desc.includes('thread not found')) {
        await env.BOT_DB.delete(`topic_for_${fromId}`);
        threadId = await getOrCreateTopic(token, env, fromId, message.from, boundGroupId);
        if (threadId) forwardRes = await forwardMessage(token, boundGroupId, fromId, message.message_id, threadId, { disable_notification: isMuted });
      }
      if (!forwardRes || !forwardRes.ok) {
        forwardRes = await copyMessage(token, boundGroupId, fromId, message.message_id, threadId, { disable_notification: isMuted });
      }
    }

    if (forwardRes && forwardRes.ok) {
      const groupMsgId = forwardRes.result.message_id;
      // 双向对称映射绑定（命名空间隔离：grp_=群侧，g_=私聊侧），任一端贴 👎 均可触发粉碎
      await env.BOT_DB.put(`msg_map_grp_${groupMsgId}`, `${fromId}_${message.message_id}`, { expirationTtl: 2592000 });
      await env.BOT_DB.put(`msg_map_g_${message.message_id}`, `${boundGroupId}_${groupMsgId}`, { expirationTtl: 2592000 });

      // ✏️ 存储访客消息原文（供访客编辑消息时做内容对比）
      if (message.text || message.caption) {
        await env.BOT_DB.put(`msg_text_g_${fromId}_${message.message_id}`, JSON.stringify({ text: message.text || message.caption, date: message.date }), { expirationTtl: 2592000 });
      }

      // 💾 消息备份群组（融合自双向bot源码）
      await backupGuestMessage(token, env, message, fromId, currentName);
    } else {
      // 🚨【终极防丢消息警报】：绕过大厅，直接向主人私聊报警！
      const errDesc = forwardRes ? (forwardRes.description || '未知网络或接口拦截') : '未知网络或接口拦截';
      await sendMessage(token, ownerId, `🔴 <b>【严重警报：客户消息静默丢失】</b>\n\n客户 <b>${escapeHtml(currentName)}</b> (ID: <code>${fromId}</code>) 刚刚发来一条消息，但系统用尽所有方式均无法将其转入大本营！\n\n❌ <b>拦截原因</b>：${escapeHtml(errDesc)}\n👉 <b>可能原因</b>：该消息可能包含受保护的媒体/特殊版权内容，导致无法被转发和复制。\n\n请您直接在私聊界面主动回复该客户。`);
    }
  }
}

// ==================== 按类型过滤 / 屏蔽关键词计数 / 自动回复（融合自双向bot源码） ====================
// 返回 true 表示该消息已被过滤拦截（已向访客提示）
async function checkForwardTypeFilters(token, env, message, chatId, filters) {
  let isForwardable = true;
  let filterReason = '';

  const hasLinks = (msg) => {
    const entities = msg.entities || msg.caption_entities || [];
    return entities.some(entity => entity.type === 'url' || entity.type === 'text_link');
  };

  // 1. 细分转发来源检查
  if (message.forward_from) {
    if (!filters.user_forward) { isForwardable = false; filterReason = '用户转发消息'; }
  } else if (message.forward_from_chat) {
    const type = message.forward_from_chat.type;
    if (type === 'channel') {
      if (!filters.channel_forward) { isForwardable = false; filterReason = '频道转发消息'; }
    } else if (type === 'group' || type === 'supergroup') {
      if (!filters.group_forward) { isForwardable = false; filterReason = '群组转发消息'; }
    }
  }
  // 2. 音频/语音
  else if (message.audio || message.voice) {
    if (!filters.audio_voice) { isForwardable = false; filterReason = '音频或语音消息'; }
  }
  // 3. 贴纸 / GIF
  else if (message.sticker || message.animation) {
    if (!filters.sticker_gif) { isForwardable = false; filterReason = '贴纸或GIF'; }
  }
  // 4. 其他媒体（图片/视频/文件）
  else if (message.photo || message.video || message.document) {
    if (!filters.media) { isForwardable = false; filterReason = '媒体内容（图片/视频/文件）'; }
  }

  // 5. 链接检查（作用于任何包含链接的消息）
  if (isForwardable && hasLinks(message)) {
    if (!filters.link) {
      isForwardable = false;
      filterReason = filterReason ? `${filterReason} (并包含链接)` : '包含链接的内容';
    }
  }

  // 6. 纯文本检查
  const isPureText = message.text &&
    !message.photo && !message.video && !message.document &&
    !message.sticker && !message.audio && !message.voice &&
    !message.forward_from_chat && !message.forward_from && !message.animation;

  if (isForwardable && isPureText) {
    if (!filters.text) { isForwardable = false; filterReason = '纯文本内容'; }
  }

  if (!isForwardable) {
    await sendMessage(token, chatId, `🚷 此消息已被过滤：${filterReason}。根据设置，此类内容不会转发给对方。`);
    return true;
  }
  return false;
}

// 屏蔽关键词计数：命中计数 +1 并提示，达到阈值自动永久封禁；返回 true 表示已拦截
async function checkBlockKeywords(token, env, userId, text, chatId) {
  if (!env.BOT_DB || !text) return false;
  const blockKeywords = await getJsonCfg(env, 'block_keywords', []);
  if (blockKeywords.length === 0) return false;

  const blockThreshold = parseInt(await getCfg(env, 'block_threshold', '5'), 10) || 5;
  let currentCount = parseInt((await env.BOT_DB.get(`blockcnt_${userId}`)) || '0', 10);

  for (const keyword of blockKeywords) {
    try {
      const regex = new RegExp(keyword, 'i');
      if (regex.test(text)) {
        currentCount += 1;
        await env.BOT_DB.put(`blockcnt_${userId}`, String(currentCount));

        if (currentCount >= blockThreshold) {
          await env.BOT_DB.put(`ban_${userId}`, 'true');
          await env.BOT_DB.delete(`verified_${userId}`);
          await syncBanIndex(env, userId, true);
          await sendMessage(token, chatId, `❌ 您已 ${currentCount} 次触发屏蔽关键词，根据设置，您已被自动屏蔽。机器人将不再接收您的任何消息。`);
        } else {
          await sendMessage(token, chatId, `⚠️ 您的消息触发了屏蔽关键词过滤器 (${currentCount}/${blockThreshold} 次)，此消息已被丢弃，不会转发给对方。`);
        }
        return true;
      }
    } catch (e) {
      console.error("无效的屏蔽关键词正则:", keyword, e);
    }
  }
  return false;
}

// 关键词自动回复：命中即回复并终止转发；返回 true 表示已自动回复
async function checkAutoReplyRules(token, env, userId, text, chatId) {
  if (!text) return false;
  const rules = await getJsonCfg(env, 'keyword_responses', []);
  if (rules.length === 0) return false;

  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.keywords, 'i');
      if (regex.test(text)) {
        await sendMessage(token, chatId, "🤖 此消息为自动回复\n\n" + rule.response);
        return true;
      }
    } catch (e) {
      console.error("无效的自动回复正则:", rule.keywords, e);
    }
  }
  return false;
}

// 💾 备份访客消息到备份群组
async function backupGuestMessage(token, env, message, fromId, currentName) {
  try {
    const backupGroupId = String(await getCfg(env, 'backup_group_id', '')).trim();
    if (!backupGroupId || !/^-?\d+$/.test(backupGroupId)) return;

    const header = `<b>--- 备份消息 ---</b>\n👤 <b>来自用户:</b> ${escapeHtml(currentName)} • ID: <code>${fromId}</code>\n------------------`;
    if (message.text) {
      await sendMessage(token, backupGroupId, header + '\n\n' + message.text);
    } else if (message.caption || message.photo || message.video || message.document || message.audio || message.voice || message.sticker || message.animation) {
      await sendMessage(token, backupGroupId, header);
      await copyMessage(token, backupGroupId, fromId, message.message_id);
    }
  } catch (e) {
    console.error("消息备份转发失败:", e);
  }
}

// 智能降级中继：文字直发 → copyMessage → 多媒体 file_id 直发 → caption 文本（多媒体直发融合自双向bot源码）
async function safeReplyToUser(token, targetUserId, chatId, message, env) {
  if (!env.BOT_DB) return { ok: false, error: 'KV 数据库未绑定，无法建立消息映射' };
  const threadId = message.message_thread_id ? String(message.message_thread_id) : null;

  // 1. 如果是纯文字，直接调用 sendMessage 直发（原文必须 HTML 转义，避免 parse 报错丢消息）
  if (message.text && !message.caption) {
    const sendRes = await sendMessage(token, targetUserId, escapeHtml(message.text));
    if (sendRes && sendRes.ok) {
      const userMsgId = sendRes.result.message_id;
      await env.BOT_DB.put(`msg_map_grp_${message.message_id}`, `${targetUserId}_${userMsgId}`, { expirationTtl: 2592000 });
      await env.BOT_DB.put(`msg_map_g_${userMsgId}`, `${chatId}_${message.message_id}`, { expirationTtl: 2592000 });
      // ✏️ 存储管理员回复原文（供管理员编辑回复时做内容对比回传）
      if (threadId) {
        await env.BOT_DB.put(`msg_text_a_${threadId}_${message.message_id}`, JSON.stringify({ text: message.text, date: message.date }), { expirationTtl: 2592000 });
      }
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

  // 3. 多媒体 file_id 直发降级（规避「限制保存内容」对 copyMessage 的拦截）
  const caption = message.caption || '';
  const mediaRes = await sendMediaDirect(token, targetUserId, message, caption);
  if (mediaRes && mediaRes.ok) {
    const userMsgId = mediaRes.result.message_id;
    await env.BOT_DB.put(`msg_map_grp_${message.message_id}`, `${targetUserId}_${userMsgId}`, { expirationTtl: 2592000 });
    await env.BOT_DB.put(`msg_map_g_${userMsgId}`, `${chatId}_${message.message_id}`, { expirationTtl: 2592000 });
    if (threadId && caption) {
      await env.BOT_DB.put(`msg_text_a_${threadId}_${message.message_id}`, JSON.stringify({ text: caption, date: message.date }), { expirationTtl: 2592000 });
    }
    return { ok: true, directMedia: true };
  }

  // 4. 多媒体附带说明文本时的优雅降级（caption 同样转义）
  if (caption.trim()) {
    const sendRes = await sendMessage(token, targetUserId, escapeHtml(caption));
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

// 按消息类型提取 file_id 直发（图片取最高分辨率）
async function sendMediaDirect(token, targetUserId, message, caption) {
  try {
    if (message.photo) {
      return await safeApiCall(token, 'sendPhoto', { chat_id: String(targetUserId), photo: message.photo[message.photo.length - 1].file_id, caption: caption });
    }
    if (message.video) {
      return await safeApiCall(token, 'sendVideo', { chat_id: String(targetUserId), video: message.video.file_id, caption: caption });
    }
    if (message.audio) {
      return await safeApiCall(token, 'sendAudio', { chat_id: String(targetUserId), audio: message.audio.file_id, caption: caption });
    }
    if (message.voice) {
      return await safeApiCall(token, 'sendVoice', { chat_id: String(targetUserId), voice: message.voice.file_id, caption: caption });
    }
    if (message.sticker) {
      return await safeApiCall(token, 'sendSticker', { chat_id: String(targetUserId), sticker: message.sticker.file_id });
    }
    if (message.animation) {
      return await safeApiCall(token, 'sendAnimation', { chat_id: String(targetUserId), animation: message.animation.file_id, caption: caption });
    }
    if (message.document) {
      return await safeApiCall(token, 'sendDocument', { chat_id: String(targetUserId), document: message.document.file_id, caption: caption });
    }
  } catch (e) {
    console.error("多媒体直发异常:", e);
  }
  return null;
}

// ==================== 满级智能验证码引擎 ====================
async function sendOrUpdateCaptcha(token, env, chatId, messageId, fromId, isEdit, prefixText = "🔒 <b>智能安全拦截</b>\n检测到新会话，为防止机器人骚扰，请先完成真人算数验证。\n\n") {
  const isAdd = Math.random() > 0.5;
  let a, b, correctAns, sign;
  if (isAdd) {
    a = Math.floor(Math.random() * 28) + 1;
    b = Math.floor(Math.random() * (30 - a)) + 1;
    correctAns = a + b;
    sign = '➕';
  } else {
    a = Math.floor(Math.random() * 29) + 2;
    b = Math.floor(Math.random() * (a - 1)) + 1;
    correctAns = a - b;
    sign = '➖';
  }

  const expireTimeMs = Date.now() + 30000;
  await env.BOT_DB.put(`captcha_${fromId}`, JSON.stringify({ ans: correctAns, exp: expireTimeMs }), { expirationTtl: 60 });

  let answers = new Set([correctAns]);
  while (answers.size < 4) {
    let wrong = correctAns + Math.floor(Math.random() * 9) - 4;
    if (wrong !== correctAns && wrong > 0 && wrong <= 30) answers.add(wrong);
  }
  const ansArray = Array.from(answers).sort(() => Math.random() - 0.5);
  const row = ansArray.map(num => ({ text: num.toString(), callback_data: `verify_ans_${num}` }));
  const keyboard = { inline_keyboard: [row] };

  const qStr = `${prefixText}🤖 <b>身份安全验证：</b>\n请问：<b>${a} ${sign} ${b} ＝ ❓</b>\n\n⏳ 提示：请在 <b>30秒内</b> 点击下方正确答案。`;

  if (isEdit && messageId) {
    await editMessageText(token, chatId, messageId, qStr, keyboard);
  } else {
    await sendMessage(token, chatId, qStr, null, keyboard);
  }
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
  if (await isAuthorizedAdmin(fromId, chatId, env, boundGroupId)) {
    if (data.startsWith('config:')) {
      await handleConfigCallback(cb, env, token, data, chatId, messageId, fromId, ownerId);
      return;
    }
    else if (data === 'toggle_bot_off') {
      if (env.BOT_DB) await env.BOT_DB.put('bot_status', 'off');
      await answerCallbackQuery(token, cb.id, "🌙 机器人已暂停服务（开启免打扰）");
      const { messageText, keyboard } = await getAdminPanelMarkup(env);
      await editMessageText(token, chatId, messageId, messageText, keyboard);
      return;
    }
    else if (data === 'toggle_bot_on') {
      if (env.BOT_DB) await env.BOT_DB.put('bot_status', 'on');
      await answerCallbackQuery(token, cb.id, "🚀 机器人已恢复正常接收");
      const { messageText, keyboard } = await getAdminPanelMarkup(env);
      await editMessageText(token, chatId, messageId, messageText, keyboard);
      return;
    }
    else if (data === 'toggle_test_mode') {
      const isMock = env.BOT_DB ? (await env.BOT_DB.get(`mock_guest_${ownerId}`) === 'true') : false;
      if (isMock) {
        if (env.BOT_DB) {
          await env.BOT_DB.delete(`mock_guest_${ownerId}`);
          await env.BOT_DB.delete(`verified_${ownerId}`);
        }
        await answerCallbackQuery(token, cb.id, "🛡️ 已切换回超级管理员模式");
      } else {
        if (env.BOT_DB) {
          await env.BOT_DB.put(`mock_guest_${ownerId}`, 'true');
          await env.BOT_DB.delete(`verified_${ownerId}`);
        }
        await answerCallbackQuery(token, cb.id, "🧪 已切换为模拟陌生人！请直接在私聊发消息测试，退出发 /test off", true);
      }
      return;
    }
    else if (data.startsWith('unban_')) {
      const parts = data.split('_');
      const targetId = parts[1];
      const origin = parts[2];
      const page = parseInt(parts[3], 10) || 0;
      if (env.BOT_DB) {
        await env.BOT_DB.delete(`ban_${targetId}`);
        await env.BOT_DB.delete(`warn_${targetId}`); // 同步清掉反垃圾警告，避免解封后被旧警告直接升级封禁
        await env.BOT_DB.delete(`blockcnt_${targetId}`); // 同步清零屏蔽关键词计数
      }
      await syncBanIndex(env, targetId, false);
      await answerCallbackQuery(token, cb.id, `✅ 成功解封！`);

      // 解封后同步刷新该用户话题标题与面板，并重绘黑名单当前页
      const targetThreadId = env.BOT_DB ? await env.BOT_DB.get(`topic_for_${targetId}`) : null;
      if (targetThreadId && boundGroupId) {
        await updateTopicAndPanel(token, env, targetId, targetThreadId, boundGroupId);
      }
      await renderBanlistPage(token, env, chatId, messageId, origin, page);
      return;
    }

    else if (data.startsWith('ban_')) {
      const targetId = data.split('_')[1];
      const isBanned = env.BOT_DB ? await env.BOT_DB.get(`ban_${targetId}`) : null;

      if (isBanned) {
        // 🔓 智能切换：按钮本身已处于封禁态，此次点击为解封
        if (env.BOT_DB) {
          await env.BOT_DB.delete(`ban_${targetId}`);
          await env.BOT_DB.delete(`warn_${targetId}`);
          await env.BOT_DB.delete(`blockcnt_${targetId}`);
        }
        await syncBanIndex(env, targetId, false);
        await answerCallbackQuery(token, cb.id, `✅ 成功解封！`);
      } else {
        // 🚫 封禁：写入标记并同步追加索引，彻底清理会话态
        if (env.BOT_DB) {
          await env.BOT_DB.put(`ban_${targetId}`, 'true');
          await env.BOT_DB.delete(`verified_${targetId}`);
        }
        await syncBanIndex(env, targetId, true);
        await answerCallbackQuery(token, cb.id, `🚫 已封禁该用户`);
      }

      // 🔄 实时刷新话题标题与面板按钮状态
      const threadId = cb.message.message_thread_id || (env.BOT_DB ? await env.BOT_DB.get(`topic_for_${targetId}`) : null);
      if (threadId && boundGroupId) {
        await updateTopicAndPanel(token, env, targetId, threadId, boundGroupId);
      }
      return;
    }
    else if (data.startsWith('mute_')) {
      // 🔕 静音切换（融合自双向bot源码）：静音后该用户来信在群内静默
      const targetId = data.split('_')[1];
      const cur = env.BOT_DB ? await env.BOT_DB.get(`mute_${targetId}`) : null;
      const nowMuted = cur !== 'true';
      if (env.BOT_DB) await env.BOT_DB.put(`mute_${targetId}`, nowMuted ? 'true' : 'false');
      await answerCallbackQuery(token, cb.id, nowMuted ? "🔕 已静音该用户的通知" : "🔔 已恢复通知");
      const threadId = cb.message.message_thread_id;
      if (threadId) {
        const panelData = await buildPanelData(env, targetId);
        await editMessageText(token, chatId, messageId, panelData.panelText, panelData.keyboard);
      }
      return;
    }
    else if (data.startsWith('pin_')) {
      // 📌 置顶当前资料卡（融合自双向bot源码）
      const res = await safeApiCall(token, 'pinChatMessage', { chat_id: Number(chatId), message_id: Number(messageId), disable_notification: true });
      await answerCallbackQuery(token, cb.id, res && res.ok ? "✅ 已置顶该卡片" : `❌ 置顶失败: ${res?.description || '未知错误'}`, !(res && res.ok));
      return;
    }
    else if (data.startsWith('cancel_note_')) {
      const targetUserId = data.split('_')[2];
      const threadId = cb.message.message_thread_id;
      if (threadId && env.BOT_DB) {
        await env.BOT_DB.delete(`state_${threadId}`);
        // 🧹 主动取消时，自动擦除那条独立提示消息
        await cleanupNotePrompt(token, env, chatId, threadId);
        const panelData = await buildPanelData(env, targetUserId);
        await editMessageText(token, chatId, messageId, panelData.panelText, panelData.keyboard);
        await answerCallbackQuery(token, cb.id, "✅ 已取消备注修改", false);
      }
      return;
    }
    else if (data.startsWith('note_')) {
      const targetUserId = data.split('_')[1];
      const threadId = cb.message.message_thread_id;
      if (threadId && env.BOT_DB) {
        await env.BOT_DB.put(`state_${threadId}`, `waiting_for_note:${fromId}`, { expirationTtl: 300 });

        // 🧹 自动清理旧的遗留提示，防止多点堆叠
        await cleanupNotePrompt(token, env, chatId, threadId);

        // 💬 独立发送文字提示，不污染主面板
        const promptRes = await sendMessage(token, chatId, "✏️ <b>当前处于备注修改模式</b>\n请直接在下方聊天栏发送新的备注（发送 /cancel 可取消，机器人会瞬间吞噬字迹，绝对不外发）。", threadId);
        if (promptRes && promptRes.ok) {
          await env.BOT_DB.put(`note_prompt_msg_${threadId}`, String(promptRes.result.message_id));
        }

        // 🔄 刷新面板按钮，将“修改备注”瞬间变为“取消备注”
        const panelData = await buildPanelData(env, targetUserId);
        await editMessageText(token, chatId, messageId, panelData.panelText, panelData.keyboard);
        await answerCallbackQuery(token, cb.id, "✏️ 开启备注模式，请直接输入", false);
      }
      return;
    }
    else if (data.startsWith('manage_banlist_')) {
      const parts = data.split('_');
      const origin = parts[2];
      const page = parseInt(parts[3], 10) || 0;
      await renderBanlistPage(token, env, chatId, messageId, origin, page);
      return;
    }
    else if (data.startsWith('back_')) {
      const origin = data.split('_')[1];
      if (origin === 'start') {
        const { messageText, keyboard } = await getAdminPanelMarkup(env);
        await editMessageText(token, chatId, messageId, messageText, keyboard);
      } else {
        const panelData = await buildPanelData(env, origin);
        await editMessageText(token, chatId, messageId, panelData.panelText, panelData.keyboard);
      }
      return;
    }
  }

  // 🔐 访客满级算术验证 + 一键按钮验证（融合自双向bot源码的按钮模式）
  if (data === 'verify_start') {
    if (env.BOT_DB) await env.BOT_DB.delete(`strikes_${fromId}`); // 新一轮验证，清空累计错误
    await sendOrUpdateCaptcha(token, env, chatId, messageId, fromId, true);
    await answerCallbackQuery(token, cb.id, "");
  }
  else if (data === 'verify_button') {
    if (!env.BOT_DB) return;
    await env.BOT_DB.put(`verified_${fromId}`, 'true');
    await env.BOT_DB.delete(`captcha_${fromId}`);
    await env.BOT_DB.delete(`strikes_${fromId}`);

    // ✅ 验证通过：释放暂存消息，实现无痕对接
    const pendingMsgStr = await env.BOT_DB.get(`pending_msg_${fromId}`);
    if (pendingMsgStr) {
      await answerCallbackQuery(token, cb.id, "✅ 验证通过！您的消息已成功发送，可继续发言。", false);
      await editMessageText(token, chatId, messageId, "✅ <b>已通过验证！通信通道已解锁。</b>\n您刚才的消息已自动发送给主人，您可以继续发言。", { inline_keyboard: [] });

      const pendingMsg = safeParseJson(pendingMsgStr, null);
      await env.BOT_DB.delete(`pending_msg_${fromId}`);
      if (pendingMsg) {
        await handleUpdate({ message: pendingMsg }, env, token).catch(e => console.error("补发暂存消息异常:", e));
      }
    } else {
      await answerCallbackQuery(token, cb.id, "🎉 验证通过！您可以开始发送消息了。", false);
      await editMessageText(token, chatId, messageId, "🎉 <b>验证通过！</b>\n通信通道已解锁，请直接发送您的消息。", { inline_keyboard: [] });
    }
  }
  else if (data.startsWith('verify_ans_')) {
    if (!env.BOT_DB) return;
    const selected = data.split('_')[2];
    const capDataStr = await env.BOT_DB.get(`captcha_${fromId}`);

    // 🔄 题目超时或已作废，自动刷新验证题
    if (!capDataStr) {
      await answerCallbackQuery(token, cb.id, "⚠️ 题目已超时作废，已为您自动换题！", false);
      await sendOrUpdateCaptcha(token, env, chatId, messageId, fromId, true, "⏳ <b>题目已超时，已自动刷新！</b>\n请重新作答：\n\n");
      return;
    }

    const capData = safeParseJson(capDataStr, {});
    if (Date.now() > (capData.exp || 0)) {
      await env.BOT_DB.delete(`captcha_${fromId}`);
      await answerCallbackQuery(token, cb.id, "⚠️ 题目已超时，已为您自动换题！", false);
      await sendOrUpdateCaptcha(token, env, chatId, messageId, fromId, true, "⏳ <b>题目已超时，已自动刷新！</b>\n请重新作答：\n\n");
      return;
    }

    if (selected === String(capData.ans)) {
      await env.BOT_DB.put(`verified_${fromId}`, 'true');
      await env.BOT_DB.delete(`captcha_${fromId}`);
      await env.BOT_DB.delete(`strikes_${fromId}`);

      // ✅ 验证通过：释放暂存消息，实现无痕对接
      const pendingMsgStr = await env.BOT_DB.get(`pending_msg_${fromId}`);
      if (pendingMsgStr) {
        await answerCallbackQuery(token, cb.id, "✅ 验证通过！您的消息已成功发送，可继续发言。", false);
        await editMessageText(token, chatId, messageId, "✅ <b>验证通过！通信通道已解锁。</b>\n您刚才的消息已自动发送给主人，您可以继续发言。", { inline_keyboard: [] });

        const pendingMsg = safeParseJson(pendingMsgStr, null);
        await env.BOT_DB.delete(`pending_msg_${fromId}`);
        if (pendingMsg) {
          await handleUpdate({ message: pendingMsg }, env, token).catch(e => console.error("补发暂存消息异常:", e));
        }
      } else {
        await answerCallbackQuery(token, cb.id, "✅ 验证通过！通信已解锁。", false);
        await editMessageText(token, chatId, messageId, "✅ <b>验证通过！</b>\n通信通道已解锁，请直接发送您的消息。", { inline_keyboard: [] });
      }
    } else {
      await env.BOT_DB.delete(`captcha_${fromId}`);

      // 🚫 累计错 3 次 → 触发 5 分钟临时防滥用封禁
      const strikes = parseInt((await env.BOT_DB.get(`strikes_${fromId}`)) || '0', 10) + 1;
      await env.BOT_DB.put(`strikes_${fromId}`, strikes.toString());

      if (strikes >= 3) {
        const banUntil = Date.now() + 300000;
        await env.BOT_DB.put(`temp_ban_${fromId}`, banUntil.toString(), { expirationTtl: 300 });
        await answerCallbackQuery(token, cb.id, "🚫 连续错3次，已被限制！", true);
        await editMessageText(token, chatId, messageId, `🚫 <b>触发防滥用系统！</b>\n\n您累计已答错 3 次，请在 <b>5分钟</b> 后重新发送消息触发验证。`, { inline_keyboard: [] });
      } else {
        const leftChances = 3 - strikes;
        await answerCallbackQuery(token, cb.id, `❌ 回答错误！还剩 ${leftChances} 次机会`, false);
        // ❌ 答错处理：增加错误次数，并自动刷新题目防恶意猜题
        await sendOrUpdateCaptcha(token, env, chatId, messageId, fromId, true, `❌ <b>答案错误！</b> 您还有 <b>${leftChances}</b> 次机会。\n为防止恶意猜题，已自动刷新题目：\n\n`);
      }
    }
  }
  else {
    // 兜底应答：未匹配任何分支的回调也要回应，避免按钮一直转圈
    await answerCallbackQuery(token, cb.id, "");
  }
}

// ==================== 黑名单分页渲染 ====================
async function renderBanlistPage(token, env, chatId, messageId, origin, page) {
  const banIds = await getBanIndex(env);
  if (banIds.length === 0) {
    const kb = { inline_keyboard: [[{ text: "🔙 返回", callback_data: `back_${origin}` }]] };
    await editMessageText(token, chatId, messageId, "🟢 <b>目前黑名单为空</b>，没有被封禁的用户。", kb);
    return;
  }

  const pageSize = 10;
  const totalPages = Math.ceil(banIds.length / pageSize);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const pageIds = banIds.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const kb = { inline_keyboard: [] };
  pageIds.forEach(id => {
    kb.inline_keyboard.push([{ text: `🔓 解除封禁: ${id}`, callback_data: `unban_${id}_${origin}_${currentPage}` }]);
  });

  const navRow = [];
  if (currentPage > 0) navRow.push({ text: "◀️ 上一页", callback_data: `manage_banlist_${origin}_${currentPage - 1}` });
  navRow.push({ text: "🔙 返回", callback_data: `back_${origin}` });
  if (currentPage < totalPages - 1) navRow.push({ text: "下一页 ▶️", callback_data: `manage_banlist_${origin}_${currentPage + 1}` });
  kb.inline_keyboard.push(navRow);

  const text = `<b>🚫 黑名单管理列表 (第 ${currentPage + 1}/${totalPages} 页)</b>\n\n👇 点击下方对应按钮即可一键解封：`;
  await editMessageText(token, chatId, messageId, text, kb);
}

// 清理备注模式的独立提示消息
async function cleanupNotePrompt(token, env, chatId, threadId) {
  if (!env.BOT_DB) return;
  const promptMsgId = await env.BOT_DB.get(`note_prompt_msg_${threadId}`);
  if (promptMsgId) {
    await deleteMessage(token, chatId, promptMsgId);
    await env.BOT_DB.delete(`note_prompt_msg_${threadId}`);
  }
}

// ==================== ⚙️ 系统配置菜单（融合自双向bot源码，KV 版） ====================
async function sendOrEditMenu(token, chatId, messageId, text, keyboard) {
  if (messageId) {
    const res = await editMessageText(token, chatId, messageId, text, keyboard);
    // 内容未变化（message is not modified）视为成功，避免重复发送新菜单消息
    if (res && (res.ok || (res.description || '').includes('message is not modified'))) return;
  }
  await sendMessage(token, chatId, text, null, keyboard);
}

async function handleAdminConfigMenu(token, env, chatId, messageId) {
  const text = `⚙️ <b>机器人主配置菜单</b>\n\n请选择要管理的配置类别：`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "🔗 按类型过滤管理", callback_data: "config:menu:filter" }],
      [{ text: "🤖 自动回复管理", callback_data: "config:menu:autoreply" }],
      [{ text: "🚫 关键词屏蔽管理", callback_data: "config:menu:keyword" }],
      [{ text: "🧑‍💻 协管员授权设置", callback_data: "config:menu:authorized" }],
      [{ text: "💾 备份群组设置", callback_data: "config:menu:backup" }],
      [{ text: "🔐 验证与欢迎语设置", callback_data: "config:menu:base" }],
      [{ text: "🔙 返回控制台", callback_data: "back_start" }]
    ]
  };
  await sendOrEditMenu(token, chatId, messageId, text, keyboard);
}

async function handleAdminFilterMenu(token, env, chatId, messageId) {
  const f = await getForwardFilters(env);
  const s = (status) => status ? "✅ <b>允许</b>" : "❌ <b>屏蔽</b>";
  const btn = (status) => status ? "✅ 允许" : "❌ 屏蔽";
  const cb = (key, status) => `config:toggle:${key}:${status ? 'false' : 'true'}`;

  const text = `🔗 <b>按类型过滤管理</b>\n点击下方按钮切换状态。\n\n<b>--- 转发来源控制 ---</b>\n1. ${s(f.user_forward)} | 转发消息 (用户)\n2. ${s(f.group_forward)} | 转发消息 (群组)\n3. ${s(f.channel_forward)} | 转发消息 (频道)\n\n<b>--- 媒体类型控制 ---</b>\n4. ${s(f.audio_voice)} | 音频/语音消息\n5. ${s(f.sticker_gif)} | 贴纸/GIF (动画)\n6. ${s(f.media)} | 图片/视频/文件\n\n<b>--- 基础内容控制 ---</b>\n7. ${s(f.link)} | 链接消息\n8. ${s(f.text)} | 纯文本消息`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `1. ${btn(f.user_forward)}`, callback_data: cb('enable_user_forwarding', f.user_forward) },
       { text: `2. ${btn(f.group_forward)}`, callback_data: cb('enable_group_forwarding', f.group_forward) }],
      [{ text: `3. ${btn(f.channel_forward)}`, callback_data: cb('enable_channel_forwarding', f.channel_forward) },
       { text: `4. ${btn(f.audio_voice)}`, callback_data: cb('enable_audio_forwarding', f.audio_voice) }],
      [{ text: `5. ${btn(f.sticker_gif)}`, callback_data: cb('enable_sticker_forwarding', f.sticker_gif) },
       { text: `6. ${btn(f.media)}`, callback_data: cb('enable_image_forwarding', f.media) }],
      [{ text: `7. ${btn(f.link)}`, callback_data: cb('enable_link_forwarding', f.link) },
       { text: `8. ${btn(f.text)}`, callback_data: cb('enable_text_forwarding', f.text) }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }]
    ]
  };
  await sendOrEditMenu(token, chatId, messageId, text, keyboard);
}

async function handleAdminAutoReplyMenu(token, env, chatId, messageId) {
  const rules = await getJsonCfg(env, 'keyword_responses', []);
  const text = `🤖 <b>自动回复管理</b>\n\n当前规则总数：<b>${rules.length}</b> 条。\n规则格式：<code>关键词表达式===回复内容</code>（关键词支持正则）`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "➕ 新增自动回复规则", callback_data: "config:add:keyword_responses" }],
      [{ text: `🗑️ 管理/删除现有规则 (${rules.length}条)`, callback_data: "config:list:keyword_responses" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }]
    ]
  };
  await sendOrEditMenu(token, chatId, messageId, text, keyboard);
}

async function handleAdminKeywordMenu(token, env, chatId, messageId) {
  const blockKeywords = await getJsonCfg(env, 'block_keywords', []);
  const blockThreshold = await getCfg(env, 'block_threshold', '5');
  const text = `🚫 <b>关键词屏蔽管理</b>\n\n当前屏蔽关键词总数：<b>${blockKeywords.length}</b> 个。\n屏蔽次数阈值：<code>${escapeHtml(blockThreshold)}</code> 次（达到阈值自动永久封禁）。\n关键词支持正则表达式。`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "➕ 新增屏蔽关键词", callback_data: "config:add:block_keywords" }],
      [{ text: `🗑️ 管理/删除现有关键词 (${blockKeywords.length}个)`, callback_data: "config:list:block_keywords" }],
      [{ text: `✏️ 修改屏蔽次数阈值 (${blockThreshold}次)`, callback_data: "config:edit:block_threshold" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }]
    ]
  };
  await sendOrEditMenu(token, chatId, messageId, text, keyboard);
}

async function handleAdminAuthorizedMenu(token, env, chatId, messageId) {
  const primaryAdmins = [String(env.OWNER_ID || DEFAULT_OWNER_ID)];
  const authorizedAdmins = await getAuthorizedAdmins(env);
  const allAdmins = [...new Set([...primaryAdmins, ...authorizedAdmins])];

  const text = `🧑‍💻 <b>协管员授权设置</b>\n\n<b>主管理员 (来自 ENV):</b> <code>${escapeHtml(primaryAdmins.join(', '))}</code>\n<b>已授权协管员 (来自 KV):</b> <code>${escapeHtml(authorizedAdmins.join(', ') || '无')}</code>\n<b>总管理员/协管员数量:</b> ${allAdmins.length} 人\n\n<b>注意：</b>\n1. 协管员在大本营话题内回复视同管理员。\n2. 协管员 ID 需为纯数字。`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "✏️ 设置/修改协管员列表", callback_data: "config:edit:authorized_admins" }],
      [{ text: `🗑️ 清空协管员列表 (${authorizedAdmins.length}人)`, callback_data: "config:clear:authorized_admins" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }]
    ]
  };
  await sendOrEditMenu(token, chatId, messageId, text, keyboard);
}

async function handleAdminBackupMenu(token, env, chatId, messageId) {
  const backupGroupId = await getCfg(env, 'backup_group_id', '');
  const statusText = backupGroupId ? `✅ 已设置: <code>${escapeHtml(backupGroupId)}</code>` : "❌ 未设置";
  const text = `💾 <b>消息备份群组设置</b>\n\n<b>当前群组 ID:</b> ${statusText}\n\n<b>注意：</b>\n1. 群组必须是超级群组，且机器人必须是管理员。\n2. 设置后，所有用户消息的副本都会转发到此群组。`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "✏️ 设置/修改备份群组 ID", callback_data: "config:edit:backup_group_id" }],
      [{ text: "🗑️ 清除备份群组 ID", callback_data: "config:clear:backup_group_id" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }]
    ]
  };
  await sendOrEditMenu(token, chatId, messageId, text, keyboard);
}

async function handleAdminBaseMenu(token, env, chatId, messageId) {
  const currentMode = await getCfg(env, 'verification_mode', 'math');
  const modeText = currentMode === 'button' ? "🖱️ 一键点击验证" : "🧮 算术题验证（30秒限时+防暴力枚举）";
  const welcomeMsg = await getCfg(env, 'welcome_msg', '检测到新会话，请先完成真人验证。');

  const text = `🔐 <b>验证与欢迎语设置</b>\n\n<b>当前验证模式:</b> ${modeText}\n\n<b>当前欢迎/提示语:</b>\n${escapeHtml(welcomeMsg).substring(0, 100)}`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "🔄 切换验证模式", callback_data: "config:toggle_mode:verification" }],
      [{ text: "📝 编辑欢迎/提示语", callback_data: "config:edit:welcome_msg" }],
      [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }]
    ]
  };
  await sendOrEditMenu(token, chatId, messageId, text, keyboard);
}

// 规则列表与删除界面（自动回复规则 / 屏蔽关键词）
async function handleAdminRuleList(token, env, chatId, messageId, key) {
  let items = [];
  let title = '';
  let backCallback = '';
  if (key === 'keyword_responses') {
    items = await getJsonCfg(env, 'keyword_responses', []);
    title = `🤖 <b>自动回复规则列表 (${items.length}条)</b>\n规则格式：<code>关键词表达式</code> ➡️ <code>回复内容</code>\n---`;
    backCallback = "config:menu:autoreply";
  } else if (key === 'block_keywords') {
    items = await getJsonCfg(env, 'block_keywords', []);
    title = `🚫 <b>屏蔽关键词列表 (${items.length}个)</b>\n关键词格式：<code>关键词表达式</code>\n---`;
    backCallback = "config:menu:keyword";
  } else {
    return;
  }

  const ruleButtons = [];
  if (items.length === 0) {
    title += "\n\n<i>（列表为空）</i>";
  } else {
    items.forEach((item, index) => {
      let label = '';
      if (key === 'keyword_responses') {
        const keywordsSnippet = String(item.keywords || '').substring(0, 15);
        const responseSnippet = String(item.response || '').substring(0, 20);
        label = `${index + 1}. <code>${escapeHtml(keywordsSnippet)}…</code> ➡️ ${escapeHtml(responseSnippet)}…`;
        ruleButtons.push([{ text: `🗑️ 删除 ${index + 1}`, callback_data: `config:delrule:${item.id}` }]);
      } else {
        const keywordSnippet = String(item).substring(0, 25);
        label = `${index + 1}. <code>${escapeHtml(keywordSnippet)}…</code>`;
        ruleButtons.push([{ text: `🗑️ 删除 ${index + 1}`, callback_data: `config:delkw:${index}` }]);
      }
      title += `\n${label}`;
    });
  }

  const keyboard = { inline_keyboard: [...ruleButtons, [{ text: "⬅️ 返回", callback_data: backCallback }]] };
  await sendOrEditMenu(token, chatId, messageId, title, keyboard);
}

// config:* 回调统一路由（系统配置仅超级管理员可操作；文本输入必须在与机器人的私聊中完成）
async function handleConfigCallback(cb, env, token, data, chatId, messageId, fromId, ownerId) {
  const parts = data.split(':');
  const action = parts[1];
  const key = parts[2];
  const value = parts[3];

  if (action === 'broadcast_help') {
    const text = `📣 <b>群发助手使用说明</b>\n\n请在<b>与机器人的私聊</b>中使用以下命令：\n\n1️⃣ 直接发送文本群发：\n<code>/broadcast 系统维护通知</code>\n\n2️⃣ 回复要群发的消息（图片/视频/语音/文件等）后发送：\n<code>/broadcast</code>\n\n3️⃣ 回复媒体并附加说明文字（≤1024字尽量同条发送）：\n<code>/broadcast 说明文字</code>\n\n📊 查看最近群发报告：<code>/broadcast_status</code>\n🔁 重试上次失败用户：<code>/broadcast_retry_failed</code>`;
    await sendOrEditMenu(token, chatId, messageId, text, { inline_keyboard: [[{ text: "🔙 返回控制台", callback_data: "back_start" }]] });
    await answerCallbackQuery(token, cb.id, "");
    return;
  }

  // 🔒 系统配置仅限超级管理员（协管员的文本输入无法被配置输入态捕获，统一拦截）
  if (fromId !== ownerId) {
    await answerCallbackQuery(token, cb.id, "⛔ 系统配置仅超级管理员可操作", true);
    return;
  }

  if (action === 'menu') {
    if (key === 'filter') await handleAdminFilterMenu(token, env, chatId, messageId);
    else if (key === 'autoreply') await handleAdminAutoReplyMenu(token, env, chatId, messageId);
    else if (key === 'keyword') await handleAdminKeywordMenu(token, env, chatId, messageId);
    else if (key === 'authorized') await handleAdminAuthorizedMenu(token, env, chatId, messageId);
    else if (key === 'backup') await handleAdminBackupMenu(token, env, chatId, messageId);
    else if (key === 'base') await handleAdminBaseMenu(token, env, chatId, messageId);
    else await handleAdminConfigMenu(token, env, chatId, messageId);
    await answerCallbackQuery(token, cb.id, "");
    return;
  }

  if (action === 'toggle' && key && value) {
    await setCfg(env, key, value);
    await answerCallbackQuery(token, cb.id, "✅ 状态已切换");
    await handleAdminFilterMenu(token, env, chatId, messageId);
    return;
  }

  if (action === 'toggle_mode' && key === 'verification') {
    const currentMode = await getCfg(env, 'verification_mode', 'math');
    const newMode = currentMode === 'button' ? 'math' : 'button';
    await setCfg(env, 'verification_mode', newMode);
    await answerCallbackQuery(token, cb.id, `✅ 模式已切换为: ${newMode === 'button' ? '一键点击验证' : '算术题验证'}`);
    await handleAdminBaseMenu(token, env, chatId, messageId);
    return;
  }

  if (action === 'edit' && key) {
    await setAdminState(env, fromId, key);
    let prompt = `请发送新的 <code>${escapeHtml(key)}</code> 值：`;
    if (key === 'welcome_msg') { prompt = "📝 请发送<b>新的欢迎/提示语</b>："; }
    else if (key === 'block_threshold') { prompt = "✏️ 请发送<b>新的屏蔽次数阈值（数字）</b>："; }
    else if (key === 'backup_group_id') { prompt = "💾 请发送<b>新的备份群组 ID</b>（-100 开头）："; }
    else if (key === 'authorized_admins') { prompt = "🧑‍💻 请发送<b>协管员 ID 列表</b>（多个用英文逗号分隔）："; }
    const promptText = `${prompt}\n\n发送 <code>/cancel</code> 或点击下方按钮取消。`;
    const cancelKb = { inline_keyboard: [[{ text: "❌ 取消编辑", callback_data: `config:cancel_input:${key}` }]] };

    // 配置输入只能在大本营超管与机器人的私聊中完成；群内打开的菜单则把输入提示转发到私聊
    if (chatId !== ownerId) {
      await sendMessage(token, ownerId, promptText, null, cancelKb);
      await answerCallbackQuery(token, cb.id, "📤 已将输入提示发送到您的私聊，请在私聊中发送配置内容", true);
    } else {
      await sendOrEditMenu(token, chatId, messageId, promptText, cancelKb);
      await answerCallbackQuery(token, cb.id, "");
    }
    return;
  }

  if (action === 'clear' && key) {
    if (key === 'authorized_admins') {
      await setCfg(env, 'authorized_admins', '[]');
      await answerCallbackQuery(token, cb.id, "✅ 协管员列表已清除");
      await handleAdminAuthorizedMenu(token, env, chatId, messageId);
    } else if (key === 'backup_group_id') {
      await setCfg(env, 'backup_group_id', '');
      await answerCallbackQuery(token, cb.id, "✅ 备份群组 ID 已清除");
      await handleAdminBackupMenu(token, env, chatId, messageId);
    }
    return;
  }

  if (action === 'add' && key) {
    const stateKey = key + '_add';
    await setAdminState(env, fromId, stateKey);
    let prompt = '';
    if (key === 'keyword_responses') { prompt = "➕ 请发送新的自动回复规则，格式：<code>关键词表达式===回复内容</code>"; }
    else if (key === 'block_keywords') { prompt = "➕ 请发送新的屏蔽关键词表达式（支持正则）："; }
    const promptText = `${prompt}\n\n发送 <code>/cancel</code> 或点击下方按钮取消。`;
    const cancelKb = { inline_keyboard: [[{ text: "❌ 取消添加", callback_data: `config:cancel_input:${stateKey}` }]] };

    if (chatId !== ownerId) {
      await sendMessage(token, ownerId, promptText, null, cancelKb);
      await answerCallbackQuery(token, cb.id, "📤 已将输入提示发送到您的私聊，请在私聊中发送内容", true);
    } else {
      await sendOrEditMenu(token, chatId, messageId, promptText, cancelKb);
      await answerCallbackQuery(token, cb.id, "");
    }
    return;
  }

  // ❌ 取消输入：清除输入态并跳回对应菜单（防止状态残留吞掉后续私聊文本）
  if (action === 'cancel_input') {
    await clearAdminState(env, fromId);
    await answerCallbackQuery(token, cb.id, "❌ 已取消输入");
    if (key === 'block_keywords_add' || key === 'block_threshold') await handleAdminKeywordMenu(token, env, chatId, messageId);
    else if (key === 'keyword_responses_add') await handleAdminAutoReplyMenu(token, env, chatId, messageId);
    else if (key === 'welcome_msg') await handleAdminBaseMenu(token, env, chatId, messageId);
    else if (key === 'backup_group_id') await handleAdminBackupMenu(token, env, chatId, messageId);
    else if (key === 'authorized_admins') await handleAdminAuthorizedMenu(token, env, chatId, messageId);
    else await handleAdminConfigMenu(token, env, chatId, messageId);
    return;
  }

  if (action === 'list' && key) {
    await handleAdminRuleList(token, env, chatId, messageId, key);
    await answerCallbackQuery(token, cb.id, "");
    return;
  }

  if (action === 'delrule' && key) {
    const rules = await getJsonCfg(env, 'keyword_responses', []);
    const newRules = rules.filter(rule => String(rule.id) !== String(key));
    await setCfg(env, 'keyword_responses', JSON.stringify(newRules));
    await answerCallbackQuery(token, cb.id, "✅ 自动回复规则已删除");
    await handleAdminRuleList(token, env, chatId, messageId, 'keyword_responses');
    return;
  }

  if (action === 'delkw' && key !== undefined) {
    const kws = await getJsonCfg(env, 'block_keywords', []);
    const idx = parseInt(key, 10);
    if (idx >= 0 && idx < kws.length) {
      kws.splice(idx, 1);
      await setCfg(env, 'block_keywords', JSON.stringify(kws));
      await answerCallbackQuery(token, cb.id, "✅ 屏蔽关键词已删除");
    } else {
      await answerCallbackQuery(token, cb.id, "⚠️ 索引无效，请刷新列表");
    }
    await handleAdminRuleList(token, env, chatId, messageId, 'block_keywords');
    return;
  }

  await answerCallbackQuery(token, cb.id, "");
}

// 管理员配置输入态管理
async function setAdminState(env, userId, key) {
  if (env.BOT_DB) {
    await env.BOT_DB.put(`admin_state_${userId}`, JSON.stringify({ action: 'awaiting_input', key: key }), { expirationTtl: 900 });
  }
}

async function clearAdminState(env, userId) {
  if (env.BOT_DB) await env.BOT_DB.delete(`admin_state_${userId}`);
}

// 处理主管理员在配置输入态发送的文本
async function handleAdminConfigInput(token, env, userId, text, adminStateJson) {
  const state = safeParseJson(adminStateJson, {});
  const key = state.key || '';
  if (!key) {
    await clearAdminState(env, userId);
    await sendMessage(token, userId, "⚠️ 状态错误，已重置。请重新使用 /start 访问菜单。");
    return;
  }

  if (text.trim() === '/cancel') {
    await clearAdminState(env, userId);
    await sendMessage(token, userId, "❌ 已取消输入。");
    if (key === 'block_keywords_add') await handleAdminKeywordMenu(token, env, userId, 0);
    else if (key === 'keyword_responses_add') await handleAdminAutoReplyMenu(token, env, userId, 0);
    else if (key === 'welcome_msg') await handleAdminBaseMenu(token, env, userId, 0);
    else if (key === 'block_threshold') await handleAdminKeywordMenu(token, env, userId, 0);
    else if (key === 'backup_group_id') await handleAdminBackupMenu(token, env, userId, 0);
    else if (key === 'authorized_admins') await handleAdminAuthorizedMenu(token, env, userId, 0);
    else await handleAdminConfigMenu(token, env, userId, 0);
    return;
  }

  // 新增自动回复规则：格式 关键词===回复内容
  if (key === 'keyword_responses_add') {
    const rules = await getJsonCfg(env, 'keyword_responses', []);
    const idx = text.indexOf('===');
    if (idx > 0 && text.slice(0, idx).trim() && text.slice(idx + 3).trim()) {
      const newRule = { keywords: text.slice(0, idx).trim(), response: text.slice(idx + 3).trim(), id: Date.now() };
      rules.push(newRule);
      await setCfg(env, 'keyword_responses', JSON.stringify(rules));
      await sendMessage(token, userId, `✅ 自动回复规则已添加。关键词: <code>${escapeHtml(newRule.keywords)}</code>`);
    } else {
      await sendMessage(token, userId, "⚠️ 自动回复规则未添加。请确保格式正确：<code>关键词表达式===回复内容</code>");
    }
    await clearAdminState(env, userId);
    await handleAdminAutoReplyMenu(token, env, userId, 0);
    return;
  }

  // 新增屏蔽关键词
  if (key === 'block_keywords_add') {
    const blockKeywords = await getJsonCfg(env, 'block_keywords', []);
    const newKeyword = text.trim();
    if (newKeyword && !blockKeywords.includes(newKeyword)) {
      blockKeywords.push(newKeyword);
      await setCfg(env, 'block_keywords', JSON.stringify(blockKeywords));
      await sendMessage(token, userId, `✅ 屏蔽关键词 <code>${escapeHtml(newKeyword)}</code> 已添加。`);
    } else {
      await sendMessage(token, userId, "⚠️ 屏蔽关键词未添加，内容为空或已存在。");
    }
    await clearAdminState(env, userId);
    await handleAdminKeywordMenu(token, env, userId, 0);
    return;
  }

  // 协管员列表（逗号分隔 → JSON 数组）
  if (key === 'authorized_admins') {
    const adminList = text.split(/[,，]/).map(id => id.trim()).filter(id => /^\d+$/.test(id));
    await setCfg(env, 'authorized_admins', JSON.stringify(adminList));
    await sendMessage(token, userId, `✅ 协管员列表已更新，共 ${adminList.length} 人。`);
    await clearAdminState(env, userId);
    await handleAdminAuthorizedMenu(token, env, userId, 0);
    return;
  }

  // 屏蔽次数阈值（数字校验）
  if (key === 'block_threshold') {
    const val = text.trim();
    if (!/^\d+$/.test(val) || parseInt(val, 10) < 1) {
      await sendMessage(token, userId, "⚠️ 请发送大于 0 的纯数字阈值。");
      return;
    }
    await setCfg(env, 'block_threshold', val);
    await sendMessage(token, userId, `✅ 屏蔽次数阈值已更新为 ${val} 次。`);
    await clearAdminState(env, userId);
    await handleAdminKeywordMenu(token, env, userId, 0);
    return;
  }

  // 欢迎语
  if (key === 'welcome_msg') {
    await setCfg(env, 'welcome_msg', text.trim());
    await sendMessage(token, userId, "✅ 欢迎/提示语已更新。");
    await clearAdminState(env, userId);
    await handleAdminBaseMenu(token, env, userId, 0);
    return;
  }

  // 备份群组 ID
  if (key === 'backup_group_id') {
    const val = text.trim();
    if (val && !/^-?\d+$/.test(val)) {
      await sendMessage(token, userId, "⚠️ 群组 ID 格式错误，应为 -100 开头的纯数字。");
      return;
    }
    await setCfg(env, 'backup_group_id', val);
    await sendMessage(token, userId, val ? `✅ 备份群组 ID 已设置为 <code>${escapeHtml(val)}</code>。` : "✅ 备份群组已清除。");
    await clearAdminState(env, userId);
    await handleAdminBackupMenu(token, env, userId, 0);
    return;
  }

  // 其他未知配置项：直接存值
  await setCfg(env, key, text.trim());
  await clearAdminState(env, userId);
  await sendMessage(token, userId, `✅ 配置项 <code>${escapeHtml(key)}</code> 已更新。`);
  await handleAdminConfigMenu(token, env, userId, 0);
}

// ==================== 📣 群发系统（融合自双向bot源码） ====================
// 群发目标：所有已建立工单话题且未被拉黑的访客
async function getBroadcastTargetIds(env) {
  if (!env.BOT_DB) return [];
  const keys = await listAllKeys(env.BOT_DB, 'topic_for_');
  const ids = [...new Set(keys.map(k => k.replace('topic_for_', '')).filter(id => /^\d+$/.test(id)))];
  const result = [];
  for (const id of ids) {
    if (!(await env.BOT_DB.get(`ban_${id}`))) result.push(id);
  }
  return result;
}

// 从错误信息中提取 retry after 秒数（429 限速重试）
function extractRetryAfterSeconds(errorMsg) {
  const match = (errorMsg || "").toString().match(/retry after\s+(\d+)/i);
  if (!match) return null;
  const sec = parseInt(match[1], 10);
  return Number.isFinite(sec) && sec >= 0 ? sec : null;
}

// 带 429 限速重试的 API 调用（最多 3 次）
async function broadcastApiCall(token, methodName, params) {
  const maxAttempts = 3;
  let attempt = 0;
  while (attempt < maxAttempts) {
    const res = await safeApiCall(token, methodName, params);
    if (res.ok) return res;
    const retryAfterSec = extractRetryAfterSeconds(res.description || '');
    attempt += 1;
    if (retryAfterSec !== null && attempt < maxAttempts) {
      await sleep((retryAfterSec + 1) * 1000);
      continue;
    }
    return res;
  }
  return { ok: false, description: '重试次数耗尽' };
}

// 按四种模式向单个用户发送群发内容
async function sendBroadcastPayloadToUser(token, targetId, payload) {
  if (payload.mode === "copy") {
    return await broadcastApiCall(token, "copyMessage", { chat_id: targetId, from_chat_id: payload.fromChatId, message_id: payload.messageId });
  }
  if (payload.mode === "copy_with_caption") {
    const res = await broadcastApiCall(token, "copyMessage", { chat_id: targetId, from_chat_id: payload.fromChatId, message_id: payload.messageId, caption: payload.caption });
    if (res.ok) return res;
    // 该媒体类型不支持附加 caption 时，降级为分开发送
    if ((res.description || '').toLowerCase().includes("can't have caption")) {
      await broadcastApiCall(token, "copyMessage", { chat_id: targetId, from_chat_id: payload.fromChatId, message_id: payload.messageId });
      return await broadcastApiCall(token, "sendMessage", { chat_id: targetId, text: payload.caption });
    }
    return res;
  }
  if (payload.mode === "copy_then_text") {
    const res = await broadcastApiCall(token, "copyMessage", { chat_id: targetId, from_chat_id: payload.fromChatId, message_id: payload.messageId });
    if (!res.ok) return res;
    return await broadcastApiCall(token, "sendMessage", { chat_id: targetId, text: payload.text });
  }
  return await broadcastApiCall(token, "sendMessage", { chat_id: targetId, text: payload.text });
}

function messageSupportsCaptionForBroadcast(msg) {
  if (!msg) return false;
  return !!(msg.photo || msg.video || msg.animation || msg.document || msg.audio || msg.voice);
}

function getBroadcastPayloadLabel(payload = {}) {
  if (payload.mode === "copy") return "媒体消息（原样复制）";
  if (payload.mode === "copy_with_caption") return "媒体+文字（同条发送）";
  if (payload.mode === "copy_then_text") return "媒体+文字（分开发送）";
  return "文本消息";
}

async function executeBroadcastTask(token, env, payload, options = {}) {
  const startedAtMs = Date.now();
  const targets = Array.isArray(options.targets) ? options.targets : await getBroadcastTargetIds(env);
  const delayBetweenMs = 120;
  const result = { total: targets.length, success: 0, failed: 0, failed_user_ids: [], failed_details: [], sampled_errors: [] };

  const shouldAutoMarkBlocked = (errorMsg) => {
    const msg = (errorMsg || "").toLowerCase();
    return msg.includes("bot was blocked by the user") || msg.includes("user is deactivated");
  };

  for (const targetId of targets) {
    const res = await sendBroadcastPayloadToUser(token, targetId, payload);
    if (res.ok) {
      result.success += 1;
    } else {
      result.failed += 1;
      const errMsg = res.description || 'unknown error';
      result.failed_user_ids.push(targetId);
      if (result.sampled_errors.length < 15) result.sampled_errors.push(`${targetId}: ${errMsg}`);
      if (result.failed_details.length < 300) result.failed_details.push({ user_id: targetId, error: errMsg });

      // 自动标记拉黑（用户已拉黑机器人/注销账号），同步黑名单索引
      if (shouldAutoMarkBlocked(errMsg) && env.BOT_DB) {
        await env.BOT_DB.put(`ban_${targetId}`, 'true');
        await syncBanIndex(env, targetId, true);
      }
    }
    if (delayBetweenMs > 0) await sleep(delayBetweenMs);
  }

  const endedAtMs = Date.now();
  const report = {
    report_id: String(startedAtMs),
    source: options.source || 'broadcast',
    parent_report_id: options.parentReportId || null,
    payload,
    payload_label: getBroadcastPayloadLabel(payload),
    started_at_ms: startedAtMs,
    ended_at_ms: endedAtMs,
    duration_ms: endedAtMs - startedAtMs,
    total: result.total,
    success: result.success,
    failed: result.failed,
    failed_user_ids: result.failed_user_ids.slice(0, 5000),
    failed_details: result.failed_details,
    sampled_errors: result.sampled_errors
  };
  if (env.BOT_DB) {
    await env.BOT_DB.put('broadcast_last_report', JSON.stringify(report));
  }
  return report;
}

function buildBroadcastResultText(report, detailLimit = 15) {
  const durationSec = ((report?.duration_ms || 0) / 1000).toFixed(1);
  const details = Array.isArray(report?.failed_details) ? report.failed_details : [];
  const sampled = details.slice(0, Math.max(1, detailLimit));
  const lines = [
    "<b>群发完成</b>",
    `任务ID: <code>${escapeHtml(report?.report_id || '未知')}</code>`,
    `类型: <code>${escapeHtml(report?.payload_label || getBroadcastPayloadLabel(report?.payload || {}))}</code>`,
    `目标用户数: <code>${report?.total || 0}</code>`,
    `成功: <code>${report?.success || 0}</code>`,
    `失败: <code>${report?.failed || 0}</code>`,
    `耗时: <code>${durationSec}s</code>`
  ];
  if (sampled.length > 0) {
    lines.push("", `<b>失败详情（前 ${sampled.length} 条）</b>`);
    for (const item of sampled) {
      lines.push(`- <code>${escapeHtml(item?.user_id || '')}</code>: <code>${escapeHtml(item?.error || 'unknown error')}</code>`);
    }
  }
  if ((report?.failed || 0) > 0) {
    lines.push("", "重试失败用户：<code>/broadcast_retry_failed</code>");
  }
  lines.push("查看完整报告：<code>/broadcast_status</code>");
  return lines.join('\n');
}

function buildBroadcastStatusText(report, detailLimit = 30) {
  const durationSec = ((report?.duration_ms || 0) / 1000).toFixed(1);
  const failedIds = Array.isArray(report?.failed_user_ids) ? report.failed_user_ids : [];
  const details = Array.isArray(report?.failed_details) ? report.failed_details : [];
  const sampled = details.slice(0, Math.max(1, detailLimit));
  const lines = [
    "<b>最近一次群发报告</b>",
    `任务ID: <code>${escapeHtml(report?.report_id || '未知')}</code>`,
    `来源: <code>${escapeHtml(report?.source || 'broadcast')}</code>`,
    `类型: <code>${escapeHtml(report?.payload_label || getBroadcastPayloadLabel(report?.payload || {}))}</code>`,
    `耗时: <code>${durationSec}s</code>`,
    `目标用户数: <code>${report?.total || 0}</code>`,
    `成功: <code>${report?.success || 0}</code>`,
    `失败: <code>${report?.failed || 0}</code>`,
    `失败用户总数: <code>${failedIds.length}</code>`
  ];
  if (sampled.length > 0) {
    lines.push("", `<b>失败详情（前 ${sampled.length} 条）</b>`);
    for (const item of sampled) {
      lines.push(`- <code>${escapeHtml(item?.user_id || '')}</code>: <code>${escapeHtml(item?.error || 'unknown error')}</code>`);
    }
  }
  if (failedIds.length > 0) {
    lines.push("", "重试失败用户：<code>/broadcast_retry_failed</code>");
  }
  return lines.join('\n');
}

async function loadBroadcastLastReport(env) {
  if (!env.BOT_DB) return null;
  const raw = await env.BOT_DB.get('broadcast_last_report');
  if (!raw) return null;
  const parsed = safeParseJson(raw, null);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

// /broadcast 命令：文本 / 回复消息复制 / 回复媒体+说明 三种群发方式
async function handleBroadcastCommand(token, env, message, chatId) {
  const content = message.text ? message.text.trim().replace(/^\/broadcast\s*/, '') : '';
  const repliedMessage = message.reply_to_message || null;
  let payload = null;
  let payloadLabel = "";

  if (content && repliedMessage?.message_id) {
    const canCaption = messageSupportsCaptionForBroadcast(repliedMessage);
    if (canCaption && content.length <= 1024) {
      payload = { mode: "copy_with_caption", fromChatId: chatId, messageId: repliedMessage.message_id, caption: content };
      payloadLabel = "回复消息+文字（同条发送）";
    } else {
      payload = { mode: "copy_then_text", fromChatId: chatId, messageId: repliedMessage.message_id, text: content };
      payloadLabel = canCaption ? "回复消息+文字（文字超 1024，改为分开发送）" : "回复消息+文字（当前媒体类型不支持同条文字，自动分开发送）";
    }
  } else if (content) {
    payload = { mode: "text", text: content };
    payloadLabel = "文本消息";
  } else if (repliedMessage?.message_id) {
    payload = { mode: "copy", fromChatId: chatId, messageId: repliedMessage.message_id };
    payloadLabel = "回复消息（原样复制）";
  }

  if (!payload) {
    await sendMessage(token, chatId, [
      "📣 请使用以下任一方式群发：",
      "1) 直接发送文本：<code>/broadcast 系统维护通知</code>",
      "2) 回复你要群发的消息（图片/视频/语音/文件等），再发送：<code>/broadcast</code>",
      "3) 回复媒体并发送：<code>/broadcast 说明文字</code>（尽量同条发送，必要时自动分开发送）"
    ].join('\n'));
    return;
  }

  if ((payload.mode === "text" || payload.mode === "copy_then_text") && payload.text.length > 4096) {
    await sendMessage(token, chatId, "⚠️ 群发文字超过 Telegram 单条消息长度限制（4096 字符），请缩短后重试。");
    return;
  }

  await sendMessage(token, chatId, `📣 开始群发（${payloadLabel}）给所有工单访客，请稍候...`);
  const report = await executeBroadcastTask(token, env, payload, { source: 'broadcast' });
  await sendMessage(token, chatId, buildBroadcastResultText(report));
}

// /broadcast_retry_failed：仅重试上次群发失败的用户
async function handleBroadcastRetryFailed(token, env, chatId) {
  const lastReport = await loadBroadcastLastReport(env);
  if (!lastReport?.payload) {
    await sendMessage(token, chatId, "⚠️ 最近一次群发报告缺少可重试内容，请先重新执行 <code>/broadcast</code>。");
    return;
  }

  const failedTargets = Array.isArray(lastReport.failed_user_ids)
    ? lastReport.failed_user_ids.map(item => (item || "").toString().trim()).filter(item => /^\d+$/.test(item))
    : [];

  if (failedTargets.length === 0) {
    await sendMessage(token, chatId, "✅ 最近一次群发没有失败用户，无需重试。");
    return;
  }

  await sendMessage(token, chatId, `🔁 开始重试最近一次群发失败的 ${failedTargets.length} 个用户，请稍候...`);
  const retryReport = await executeBroadcastTask(token, env, lastReport.payload, {
    source: 'broadcast_retry_failed',
    parentReportId: lastReport.report_id || null,
    targets: failedTargets
  });
  await sendMessage(token, chatId, buildBroadcastResultText(retryReport));
}

// ==================== 双向编辑同步（融合自双向bot源码） ====================
// 访客编辑私聊消息 → 大本营对应话题收到原/新内容对比通知
async function handleGuestEditedMessage(token, env, em, userId, boundGroupId) {
  if (!env.BOT_DB || !boundGroupId) return;
  if (await env.BOT_DB.get(`ban_${userId}`)) return;
  const threadId = await env.BOT_DB.get(`topic_for_${userId}`);
  if (!threadId) return;

  const newText = em.text || em.caption;
  if (!newText) return; // 纯媒体编辑无文本可比对

  const key = `msg_text_g_${userId}_${em.message_id}`;
  const storedStr = await env.BOT_DB.get(key);
  const stored = storedStr ? safeParseJson(storedStr, {}) : null;
  const originalText = stored?.text || '[原始内容未记录]';
  const originalTime = formatTimestamp(stored?.date || em.date);
  const editTime = formatTimestamp(em.edit_date || em.date);

  const notifyText = `⚠️ <b>用户消息已修改</b>\n<b>原发送时间:</b> <code>${originalTime}</code>\n<b>本次编辑时间:</b> <code>${editTime}</code>\n<b>原始内容:</b>\n${escapeHtml(originalText)}\n<b>修改后的新内容:</b>\n${escapeHtml(newText)}`;
  await sendMessage(token, boundGroupId, notifyText, threadId);

  // 更新存储，作为下次编辑的「原始内容」
  await env.BOT_DB.put(key, JSON.stringify({ text: newText, date: em.edit_date || em.date }), { expirationTtl: 2592000 });
}

// 管理员在话题内编辑已发出的回复 → 私聊通知用户原/新内容对比
async function handleAdminEditedReply(token, env, em, boundGroupId) {
  if (!env.BOT_DB) return;

  // 忽略机器人自己的消息
  if (em.from && em.from.is_bot) return;

  // 校验编辑者管理员身份
  const senderId = em.from?.id ? String(em.from.id) : null;
  if (!senderId || !(await isAuthorizedAdmin(senderId, String(em.chat.id), env, boundGroupId))) return;

  const threadId = String(em.message_thread_id);
  const targetUserId = await env.BOT_DB.get(`user_for_${threadId}`);
  if (!targetUserId) return;

  const newText = em.text || em.caption;
  if (!newText) return;

  const key = `msg_text_a_${threadId}_${em.message_id}`;
  const storedStr = await env.BOT_DB.get(key);
  if (!storedStr) return; // 未记录原文的消息（如媒体直发无说明）无法比对

  const stored = safeParseJson(storedStr, {});
  const originalTime = formatTimestamp(stored.date);
  const editTime = formatTimestamp(em.edit_date || em.date);

  const notifyText = `⚠️ <b>管理员编辑了回复</b>\n---\n<b>原发送/上次编辑时间:</b> <code>${originalTime}</code>\n<b>本次编辑时间:</b> <code>${editTime}</code>\n<b>原消息内容：</b>\n${escapeHtml(stored.text || '')}\n<b>新消息内容：</b>\n${escapeHtml(newText)}`;

  const sendRes = await sendMessage(token, targetUserId, notifyText);
  if (sendRes && sendRes.ok) {
    // 更新存储，作为下次编辑的「原始内容」
    await env.BOT_DB.put(key, JSON.stringify({ text: newText, date: em.edit_date || em.date }), { expirationTtl: 2592000 });
  } else {
    await sendMessage(token, boundGroupId, `❌ <b>编辑回传失败</b>\n用户 ID: <code>${escapeHtml(targetUserId)}</code>\n错误: <code>${escapeHtml(sendRes?.description || '未知错误')}</code>`, threadId);
  }
}

// ==================== 话题工单与分级展示核心 ====================
// 话题标题拼装（含封禁态标识）
async function buildTopicTitle(env, userId) {
  const note = env.BOT_DB ? await env.BOT_DB.get(`note_for_${userId}`) : null;
  const isBanned = env.BOT_DB ? await env.BOT_DB.get(`ban_${userId}`) : null;

  const infoStr = env.BOT_DB ? await env.BOT_DB.get(`info_for_${userId}`) : null;
  const info = infoStr ? safeParseJson(infoStr, { first_name: '访客' }) : { first_name: '访客' };
  const fullName = (info.first_name || '') + (info.last_name ? ' ' + info.last_name : '');
  const safeName = fullName || '访客';

  let topicTitle = note ? `🏷️ [${note}]：${safeName}` : `👤 ${safeName}`;
  if (isBanned) topicTitle = `🚫 [已封禁]：${safeName}`;
  return topicTitle.slice(0, 120);
}

async function getOrCreateTopic(token, env, userId, userInfo, groupId) {
  let threadId = env.BOT_DB ? await env.BOT_DB.get(`topic_for_${userId}`) : null;
  const topicName = await buildTopicTitle(env, userId);

  // 话题已存在：精准比对是否真正更名，避免高频调用触发 Telegram 429 限流
  if (threadId) {
    if (env.BOT_DB && !(await env.BOT_DB.get(`user_for_${threadId}`))) {
      await env.BOT_DB.put(`user_for_${threadId}`, String(userId));
    }

    const lastTopicName = env.BOT_DB ? await env.BOT_DB.get(`topic_name_${threadId}`) : null;
    if (lastTopicName !== topicName) {
      await updateTopicAndPanel(token, env, userId, threadId, groupId);
    }
    return threadId;
  }

  // 🔒 建房并发锁：防止并发消息为同一访客创建重复话题
  const lockKey = `creating_topic_${userId}`;
  if (env.BOT_DB && await env.BOT_DB.get(lockKey)) {
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      threadId = await env.BOT_DB.get(`topic_for_${userId}`);
      if (threadId) return threadId;
    }
    return null;
  }
  if (env.BOT_DB) await env.BOT_DB.put(lockKey, '1', { expirationTtl: 60 });

  // 双重检查：等待期间可能已被并发请求建好
  threadId = env.BOT_DB ? await env.BOT_DB.get(`topic_for_${userId}`) : null;
  if (threadId) {
    if (env.BOT_DB) await env.BOT_DB.delete(lockKey);
    return threadId;
  }

  try {
    const res = await safeApiCall(token, 'createForumTopic', { chat_id: Number(groupId), name: topicName });

    if (res.ok) {
      threadId = res.result.message_thread_id;
      if (env.BOT_DB) {
        await env.BOT_DB.put(`topic_for_${userId}`, String(threadId));
        await env.BOT_DB.put(`user_for_${threadId}`, String(userId));
        await env.BOT_DB.put(`topic_name_${threadId}`, topicName);
        await env.BOT_DB.delete(lockKey);
      }

      // 1. 发送【屏幕最上方固定的置顶栏】(单行极限压缩) 并置顶
      const pinnedLineText = await buildPinnedSingleLine(env, userId);
      const pinnedRes = await sendMessage(token, groupId, pinnedLineText, threadId);
      if (pinnedRes && pinnedRes.ok) {
        const pinnedMsgId = pinnedRes.result.message_id;
        if (env.BOT_DB) await env.BOT_DB.put(`pinned_line_msg_${threadId}`, String(pinnedMsgId));
        await safeApiCall(token, 'pinChatMessage', { chat_id: Number(groupId), message_id: Number(pinnedMsgId) });
      }

      // 2. 发送【底部专属情报全底大卡片】
      const panelRes = await sendPanel(token, env, groupId, threadId, userId);
      if (panelRes && panelRes.ok) {
        if (env.BOT_DB) await env.BOT_DB.put(`panel_msg_${threadId}`, String(panelRes.result.message_id));
      }

      // 3. 发送【用户资料卡汇总】话题的 #新用户连接 卡片（融合自双向bot源码）
      await sendProfileLogCard(token, env, groupId, userId);

      return threadId;
    } else {
      const errReason = res.description || '未知异常';
      console.error("创建话题失败:", errReason);
      if (env.BOT_DB) await env.BOT_DB.delete(lockKey);
      await sendMessage(token, groupId, `⚠️ <b>致命异常</b>：无法为新访客创建专属独立房间！\n❌ 报错详情：<code>${escapeHtml(errReason)}</code>\n👉 <b>请务必检查机器人是否拥有群组的「管理主题 (Manage Topics)」完整权限！</b>\n（群ID: <code>${groupId}</code>）`);
      return null;
    }
  } catch (err) {
    console.error("调用 createForumTopic 异常:", err);
    if (env.BOT_DB) await env.BOT_DB.delete(lockKey);
    return null;
  }
}

// 刷新话题名、置顶单行栏与底部卡片（丢失自动重建，重 pin 保持置顶）
async function updateTopicAndPanel(token, env, userId, threadId, chatId) {
  if (!env.BOT_DB) return;

  const data = await buildPanelData(env, userId);
  await editTopicName(token, chatId, threadId, data.topicTitle);
  await env.BOT_DB.put(`topic_name_${threadId}`, data.topicTitle);

  // —— 置顶单行栏 ——
  const singleLine = await buildPinnedSingleLine(env, userId);
  const pinnedMsgId = await env.BOT_DB.get(`pinned_line_msg_${threadId}`);
  let pinNeedsRecreate = !pinnedMsgId;
  if (pinnedMsgId) {
    const res = await editMessageText(token, chatId, pinnedMsgId, singleLine);
    if (res && res.ok) {
      // 重新置顶，保证它固定在屏幕最上方
      await safeApiCall(token, 'unpinChatMessage', { chat_id: Number(chatId), message_id: Number(pinnedMsgId) });
      await safeApiCall(token, 'pinChatMessage', { chat_id: Number(chatId), message_id: Number(pinnedMsgId) });
    } else if (res && res.description && res.description.includes('message to edit not found')) {
      pinNeedsRecreate = true;
    }
  }
  if (pinNeedsRecreate) {
    const pinRes = await sendMessage(token, chatId, singleLine, threadId);
    if (pinRes && pinRes.ok) {
      const newPinId = pinRes.result.message_id;
      await env.BOT_DB.put(`pinned_line_msg_${threadId}`, String(newPinId));
      await safeApiCall(token, 'pinChatMessage', { chat_id: Number(chatId), message_id: Number(newPinId) });
    }
  }

  // —— 底部情报卡片 ——
  const panelMsgId = await env.BOT_DB.get(`panel_msg_${threadId}`);
  let panelNeedsRecreate = !panelMsgId;
  if (panelMsgId) {
    const res = await editMessageText(token, chatId, panelMsgId, data.panelText, data.keyboard);
    if (res && res.description && res.description.includes('message to edit not found')) {
      panelNeedsRecreate = true;
    }
  }
  if (panelNeedsRecreate) {
    // 走 sendPanel 以获得 tg:// 资料按钮隐私受限时的自动降级
    const panelRes = await sendPanel(token, env, chatId, threadId, userId);
    if (panelRes && panelRes.ok) {
      await env.BOT_DB.put(`panel_msg_${threadId}`, String(panelRes.result.message_id));
    }
  }
}

// 👁️【屏幕最上方固定的置顶栏】极限单行压缩版（置顶看原形）
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

  return `👁️ 昵称: ${currentName} | 🏷️ 备注: ${noteDisplay}${originalNote} | ✈️ ${username} | 🆔 <code>${userId}</code>`;
}

// 👤 资料按钮 URL：有用户名用 t.me 链接；无用户名用 tg://user?id（隐私受限自动禁用，融合自双向bot源码）
async function getProfileButtonUrl(env, userId, info) {
  if (info && info.username) return `https://t.me/${info.username}`;
  if (env.BOT_DB && (await env.BOT_DB.get(`profile_url_disabled_${userId}`)) === 'true') return null;
  return `tg://user?id=${userId}`;
}

// 🎴【卡片查全底】全角对齐 + 曾用名案底流水悬垂缩进展现 + 按钮动态切换
async function buildPanelData(env, userId) {
  const infoStr = env.BOT_DB ? await env.BOT_DB.get(`info_for_${userId}`) : null;
  const info = infoStr ? safeParseJson(infoStr, { first_name: '访客' }) : { first_name: '访客' };

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
  const fullName = (info.first_name || '') + (info.last_name ? ' ' + info.last_name : '');
  if (nameHistory.length === 0 && fullName) nameHistory = [fullName];

  const currentNameRaw = nameHistory[nameHistory.length - 1] || fullName || '访客';
  const pastNamesRaw = nameHistory.slice(0, -1);
  const username = info.username ? `@${escapeHtml(info.username)}` : '未设置';

  const savedNoteRaw = env.BOT_DB ? await env.BOT_DB.get(`note_for_${userId}`) : null;
  const isBanned = env.BOT_DB ? await env.BOT_DB.get(`ban_${userId}`) : null;
  const isMuted = env.BOT_DB ? (await env.BOT_DB.get(`mute_${userId}`)) === 'true' : false;

  // 话题标题（含封禁态）
  let topicTitleRaw = savedNoteRaw ? `🏷️ [${savedNoteRaw}]：${currentNameRaw}` : `👤 ${currentNameRaw}`;
  if (isBanned) topicTitleRaw = `🚫 [已封禁]：${currentNameRaw}`;
  if (topicTitleRaw.length > 120) topicTitleRaw = topicTitleRaw.substring(0, 120);

  // 备注展示卡：有曾用名时启用悬垂缩进排版
  let displayNoteCardRaw = '';
  if (savedNoteRaw) {
    if (pastNamesRaw.length > 0) {
      displayNoteCardRaw = formatHangingIndentEscaped(pastNamesRaw, `${savedNoteRaw}（原：`, '）');
    } else {
      displayNoteCardRaw = escapeHtml(savedNoteRaw);
    }
  } else {
    if (pastNamesRaw.length > 0) {
      displayNoteCardRaw = formatHangingIndentEscaped(pastNamesRaw, `原：`, '');
    } else {
      displayNoteCardRaw = escapeHtml(currentNameRaw);
    }
  }

  // 🔄 获取当前房间的备注状态，实现按钮三态无缝切换
  const threadIdForState = env.BOT_DB ? await env.BOT_DB.get(`topic_for_${userId}`) : null;
  const state = threadIdForState ? await env.BOT_DB.get(`state_${threadIdForState}`) : null;

  const btnText = (state && String(state).startsWith('waiting_for_note:')) ? "❌ 取消备注"
    : (savedNoteRaw ? "📝 修改备注" : "📝 添加备注");
  const btnData = (state && String(state).startsWith('waiting_for_note:')) ? `cancel_note_${userId}` : `note_${userId}`;
  const banBtnText = isBanned ? "✅ 解除封禁" : "🚫 一键封禁";
  const muteBtnText = isMuted ? "🔔 解除静音" : "🔕 静音通知";

  const panelText = `╭━━━ 👤 <b>访客专属情报</b> ━━━╮
👤 <b>昵 称</b>：${escapeHtml(currentNameRaw)}
🏷️ <b>备 注</b>：${displayNoteCardRaw}
✈️ <b>用 户</b>：${username}
🆔 <b>Ｉ Ｄ</b>：<code>${userId}</code>
╰━━━━━━━━━━━━━━━╯
💡 <b>操作</b>：右键发错的消息贴 👎(踩) 表情，可瞬间双向强制删除！`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: banBtnText, callback_data: `ban_${userId}` },
        { text: muteBtnText, callback_data: `mute_${userId}` },
        { text: btnText, callback_data: btnData }
      ]
    ]
  };

  // 👤 查看用户资料按钮（URL 按钮）
  const profileUrl = await getProfileButtonUrl(env, userId, info);
  if (profileUrl) {
    keyboard.inline_keyboard.push([{ text: "👤 查看用户资料", url: profileUrl }]);
  }

  keyboard.inline_keyboard.push([
    { text: "📌 置顶此卡片", callback_data: `pin_${userId}` },
    { text: "📋 管理黑名单", callback_data: `manage_banlist_${userId}_0` }
  ]);

  return { panelText, keyboard, topicTitle: topicTitleRaw };
}

// 发送面板卡片：tg:// 隐私受限时自动降级移除资料按钮并记录（融合自双向bot源码）
async function sendPanel(token, env, groupId, threadId, userId) {
  const data = await buildPanelData(env, userId);
  const res = await sendMessage(token, groupId, data.panelText, threadId, data.keyboard);
  if (!res.ok && res.description && res.description.toLowerCase().includes('privacy_restricted')) {
    if (env.BOT_DB) await env.BOT_DB.put(`profile_url_disabled_${userId}`, 'true');
    const retryData = await buildPanelData(env, userId);
    return await sendMessage(token, groupId, retryData.panelText, threadId, retryData.keyboard);
  }
  return res;
}

// 📋 用户资料卡汇总话题：新用户建 connected 房间时同步一张带跳转按钮的卡片
async function sendProfileLogCard(token, env, groupId, userId) {
  try {
    if (!env.BOT_DB) return;
    let logTopicId = await env.BOT_DB.get('cfg:profile_log_topic_id');
    if (!logTopicId) {
      const res = await safeApiCall(token, 'createForumTopic', { chat_id: Number(groupId), name: '📋 用户资料卡汇总' });
      if (res.ok) {
        logTopicId = String(res.result.message_thread_id);
        await env.BOT_DB.put('cfg:profile_log_topic_id', logTopicId);
      } else {
        return;
      }
    }

    const infoStr = await env.BOT_DB.get(`info_for_${userId}`);
    const info = infoStr ? safeParseJson(infoStr) : {};
    const name = escapeHtml((info.first_name || '') + (info.last_name ? ' ' + info.last_name : '')) || '访客';
    const username = info.username ? `@${escapeHtml(info.username)}` : '无';

    const cleanGroupId = String(groupId).replace(/^-100/, '');
    const topicId = await env.BOT_DB.get(`topic_for_${userId}`);
    const jumpUrl = `https://t.me/c/${cleanGroupId}/${topicId}`;
    const kb = { inline_keyboard: [[{ text: "💬 跳转到会话窗口", url: jumpUrl }]] };
    const text = `<b>#新用户连接</b>\n🆔 ID: <code>${userId}</code>\n👤 昵称: ${name}\n✈️ 用户名: ${username}`;

    const logRes = await sendMessage(token, groupId, text, logTopicId, kb);
    if (logRes && logRes.ok) {
      await env.BOT_DB.put(`profile_log_msg_${userId}`, String(logRes.result.message_id));
    }
  } catch (e) {
    console.error("发送资料汇总卡失败:", e);
  }
}

// ==================== 底层安全防崩通讯库（统一入口，网络异常不中断主流程） ====================
async function safeApiCall(token, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error(`Telegram API [${method}] 失败:`, e);
    return { ok: false, description: "网络异常或请求中断" };
  }
}

async function sendMessage(token, chatId, text, threadId = null, keyboard = null) {
  const payload = { chat_id: String(chatId), text: text, parse_mode: 'HTML' };
  if (threadId) payload.message_thread_id = threadId;
  if (keyboard) payload.reply_markup = keyboard;
  return await safeApiCall(token, 'sendMessage', payload);
}

async function answerCallbackQuery(token, cbId, text = "", showAlert = false) {
  const payload = { callback_query_id: cbId };
  if (text) {
    payload.text = text;
    payload.show_alert = showAlert;
  }
  return await safeApiCall(token, 'answerCallbackQuery', payload);
}

async function editMessageText(token, chatId, messageId, text, keyboard = null) {
  const payload = { chat_id: String(chatId), message_id: Number(messageId), text: text, parse_mode: 'HTML' };
  if (keyboard) payload.reply_markup = keyboard;
  const json = await safeApiCall(token, 'editMessageText', payload);
  if (!json.ok && !json.description?.includes('message is not modified')) {
    console.warn("editMessageText 警告:", json.description);
  }
  return json;
}

async function copyMessage(token, targetChatId, fromChatId, messageId, threadId = null, extra = null) {
  const payload = { chat_id: String(targetChatId), from_chat_id: String(fromChatId), message_id: messageId };
  if (threadId) payload.message_thread_id = threadId;
  if (extra) Object.assign(payload, extra);
  return await safeApiCall(token, 'copyMessage', payload);
}

async function forwardMessage(token, targetChatId, fromChatId, messageId, threadId = null, extra = null) {
  const payload = { chat_id: String(targetChatId), from_chat_id: String(fromChatId), message_id: messageId };
  if (threadId) payload.message_thread_id = threadId;
  if (extra) Object.assign(payload, extra);
  return await safeApiCall(token, 'forwardMessage', payload);
}

async function deleteMessage(token, chatId, messageId) {
  return await safeApiCall(token, 'deleteMessage', { chat_id: String(chatId), message_id: Number(messageId) });
}

async function editTopicName(token, chatId, threadId, name) {
  return await safeApiCall(token, 'editForumTopic', { chat_id: String(chatId), message_thread_id: Number(threadId), name: String(name).slice(0, 128) });
}
