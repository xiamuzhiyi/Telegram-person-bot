# Telegram 个人专属免群组双向私聊机器人

基于 **Cloudflare Workers (ES Modules)** 与 **Cloudflare KV** 构建的高性能、免服务器 Telegram 双向客服/私聊中继机器人。

无需创建超级群组，无需折腾话题（Topics）模式。陌生人在私聊中发消息，机器人直接中继至你的 Telegram 私聊窗口；长按或右键直接回复即可原路送达。

---

## 核心特性

- **纯 1 对 1 私聊架构**：无需任何群组支持，所有交互均在你与机器人的专属私聊窗口内完成。
- **长按/右键双向中继**：无论是长按用户的原始消息还是下方的处理资料卡，均支持直接 Reply（回复），系统自动完成 Message ID 映射与回传。
- **免打扰总开关（一键停启）**：管理面板可一键切换运行状态（🟢 运行中 / 🔴 已暂停）。暂停期间访客消息自动拦截，主号免受打扰。
- **智能防刷屏机制**：
  - **首条欢迎语冷却**：同一用户 2 小时内仅触发一次“消息已送达”欢迎语，避免连发多句时机器人疯狂复读。
  - **暂停状态提示冷却**：免打扰开启时，同一访客 2 小时内仅收到一次提示。
- **多维度反垃圾与广告拦截**：
  - **灰产关键词正则库**：自动识别 USDT、博彩、代开票、色粉等垃圾营销词（同时覆盖纯文本与媒体 Caption）。
  - **引流链接封杀**：自动拦截携带 `t.me/` 频道/群聊推广链接的消息。
  - **第三方转发拦截**：阻止广告机利用批量转发（`forward_origin` / `forward_from`）引流。
  - **自动拉黑机制**：命中规则者自动加入黑名单并终止服务。
- **可视化黑名单管理面板**：
  - 收到消息下方自带“🚫 一键封禁”内联按钮。
  - 管理面板支持展开所有被封禁的用户列表，支持单个一键解封。
- **安全与健壮性**：
  - **路径暗号门禁**：仅授权路径响应请求，其他爬虫与扫描一律返回 `403 Forbidden`。
  - **HTML 实体转义**：严格转义 `<`、`>`、`&` 等字符，防止特殊符号昵称引发 Telegram API 报错。
  - **健康检查探针**：浏览器直接 GET 访问暗号路径可即时查看 Worker 存活状态与 KV 数据库绑定有效性。

---

## 准备工作

1. **Telegram 账号与数字 ID**：
   - 找 [@userinfobot](https://t.me/userinfobot) 获取你的 Telegram 纯数字 ID（如 `8913877802`）。
2. **Telegram Bot Token**：
   - 找 [@BotFather](https://t.me/BotFather) 创建机器人并获取专属 Token（如 `1234567890:ABC...`）。
3. **Cloudflare 账号**：
   - 拥有一个免费的 Cloudflare 账户，并准备好一个可用的域名（推荐绑定自定义域名以保障国内连通性）。

---

## 部署步骤

### 1. 创建 Cloudflare KV 命名空间

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 依次进入 **Storage & Databases** -> **KV**。
3. 点击 **Create Namespace**，命名为 `tg-bot-db`（名称可自定义）。

### 2. 创建 Worker 并绑定 KV

1. 进入 **Workers & Pages** -> 点击 **Create Application** -> **Create Worker**。
2. 输入服务名称（如 `tg-relay-bot`），点击 **Deploy**。
3. 进入该 Worker 的管理页面：
   - 切换到 **Settings** -> **Bindings**（或 Variables and Secrets）。
   - 找到 **KV Namespace Bindings**，点击 **Add**。
   - **Variable name（变量名称）**：必须严格填写为 **`BOT_DB`**（全大写）。
   - **KV namespace**：下拉选择第一步创建的 `tg-bot-db`。
   - 点击 **Save and deploy**。

### 3. 配置代码与自定义域名

1. 点击 Worker 页面的 **Edit code**，将仓库中的完整代码复制粘贴进去。
2. 确认或修改代码顶部的核心配置项：
   ```javascript
   const TOKEN = '你的_BOT_TOKEN'; 
   const OWNER_ID = '你的_数字_ID'; 
   const SECRET_PATH = '/你的自定义暗号路径'; // 例如 /xiagefei120
  - 配置 Secret 变量：
  - 进入 Worker -> Settings -> Variables and Secrets。
  - 点击 Add，添加变量名 BOT_TOKEN，类型选择 Secret，填入你在 @BotFather 重新获取的全新 Token。
  - 点击 Save and deploy。
3. 点击右上角 **Deploy** 部署。
4. 返回 Worker 详情页，进入 **Settings** -> **Domains & Routes** -> **Add Custom Domain**，绑定你的自定义域名（例如 `tgchat.example.com`）。

### 4. 探针自检（验证 Worker 状态）

在浏览器直接访问你的自定义域名与暗号路径：
```text
https://tgchat.example.com/xiagefei120
```
- **预期输出**：
  ```text
  Worker 运行正常！
  KV 状态: 已成功绑定 ✅
  ```
- 如果显示“未绑定 ❌”，请返回第 2 步检查变量名是否严格为 `BOT_DB`。

### 5. 绑定 Telegram Webhook

将以下链接中的参数替换为你的实际信息，复制到浏览器地址栏中访问以激活 Webhook：

```text
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://tgchat.example.com/xiagefei120&drop_pending_updates=true
```

- **验证标准**：页面返回 `{"ok":true,"result":true,"description":"Webhook was set"}`。
- **排查命令**：若要检查 Webhook 状态，可访问：
  ```text
  https://api.telegram.org/bot<你的BOT_TOKEN>/getWebhookInfo
  ```
  确认 `pending_update_count` 为 `0` 且无 `last_error_message`。

---

## 使用指南

### 1. 主人控制台（发送 `/start`）
用你的管理者账号私聊机器人发送 `/start`，机器人会弹出主控面板：
- **启停开关**：点击按钮实时切换 `🟢 机器人运行中` 与 `🔴 机器人已暂停`。
- **管理黑名单**：查看被拦截或手动拉黑的用户列表，点击对应 ID 可一键解封。

### 2. 双向消息中继
- **用户发信**：访客在私聊中发消息，你的私聊窗口会收到：
  1. 用户的原始消息。
  2. 一张带有该用户昵称、ID 及“🚫 一键封禁”按钮的操作卡片。
- **主人回复**：
  - **长按 / 右键点击**原消息或操作卡片。
  - 选择 **Reply（回复）**，输入文字、图片或语音发送。
  - 机器人会自动将内容原样回传给该用户，并提示 `✅ 回复已成功送达`。

### 3. 广告拦截与风控
- 当陌生人发送包含引流词汇、`t.me/` 链接或使用批量转发时，系统会自动终止中继，向对方发出警告并将对方写入 KV 黑名单。
- 你不会收到任何弹窗或打扰，保持私信清洁。

---

## 环境变量说明（可选推荐）

为防止代码泄露时暴露凭证，推荐在 Cloudflare Worker 的 **Settings** -> **Variables and Secrets** 中以 Environment Variables 配置：

| 变量名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `BOT_TOKEN` | Secret / Text | Telegram 机器人的 Token |
| `OWNER_ID` | Text | 你的纯数字 Telegram ID |
| `SECRET_PATH` | Text | Webhook 安全路径（以 `/` 开头） |
| `BOT_DB` | KV Namespace | 必须绑定的 KV 数据库实例 |

---

## 常见问题排查 (FAQ)

#### Q1: 发送 `/start` 机器人完全不回复？
1. 核对你在 [@userinfobot](https://t.me/userinfobot) 查到的 ID 是否与代码中的 `OWNER_ID` 完全一致。
2. 浏览器直接访问 `https://你的域名/你的暗号`，确认页面是否显示 `KV 状态: 已成功绑定 ✅`。如果报 1101，说明 KV 绑定名称不匹配。
3. 检查 Webhook 绑定的 Token 是否对应你正在聊天的这个机器人。

#### Q2: 为什么提示 `⚠️ 回复失败：未能识别到对应的目标用户 ID`？
回复时**必须**长按或右键对准消息点击 **Reply（回复）**。直接在输入框打字发送相当于普通文本，机器人无法判定你打算回复给哪位访客。

#### Q3: 免费额度够用吗？
完全足够。Cloudflare Workers 免费计划每天提供 100,000 次请求，KV 每天提供 100,000 次读取与 1,000 次写入，足以支撑个人站长或博主高频的日常私信沟通。
