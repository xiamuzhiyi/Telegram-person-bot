# Telegram 多群组双向私聊中继机器人 (Cloudflare Worker 版)

基于 **Cloudflare Worker** 与 **KV 数据库** 构建的高性能 Telegram 双向客服中继机器人。无需购买 VPS 服务器，完全基于 Serverless 架构运行，零成本托管。

本项目支持将外部陌生访客的私聊消息同步广播推送至多个 Telegram 管理群组，群内任意管理员长按引用（Reply）即可中继回复该访客。系统同时支持超级管理员私聊独立总控、智能广告过滤、全局免打扰开关与可视化黑名单管理。

---

## 核心特性

* **多群组协同广播**：访客发送的消息（文本、图片、表情贴纸、语音、视频、文件等）会自动并发广播到所有授权的管理群组。
* **双轨引用回复中继**：
  * **群组协同**：任意授权群组内的管理员长按/右键点击**访客原消息**或**下方信息资料卡**并选择“回复（Reply）”，机器人即可自动将回复内容送达该访客私聊。
  * **私聊超管独立通道**：超级管理员在与机器人的私聊窗口中，同样支持引用回复与面板管理。
* **多层次安全与防骚扰防护**：
  * **灰产营销词库过滤**：内置 USDT、TRX、博彩、网赌、兼职、色粉、代开等垃圾词汇过滤拦截。
  * **防链接引流拦截**：严格拦截 `t.me/` 频道/群组推广链接及第三方频道转发引流行为，触发即自动拉黑并发送违规告警。
  * **2 小时冷却欢迎语**：新访客首条消息推送专属欢迎语，2 小时内自动进入静默防刷机制。
* **交互式图形化控制面板**：
  * 支持一键切换“正常服务”与“免打扰/暂停模式”（开启免打扰后自动拦截陌生私聊并智能提示）。
  * 资料卡一键封禁，并提供分页式的黑名单可视化解封面板。
* **门禁保护**：内置 `SECRET_PATH` Webhook 路径暗号验证，杜绝外部扫描与恶意伪造推送。

---

## 系统架构与工作流

```text
[ 访客私聊 ] ──(发送消息)──> [ Telegram 服务器 ]
                                    │ (Webhook 加密推送)
                                    ▼
                     [ Cloudflare Worker 边缘网关 ]
                                    │
         ┌──────────────────────────┴──────────────────────────┐
         │ 1. 验证路径暗号 (SECRET_PATH)                        │
         │ 2. 检查黑名单与全局免打扰状态 (KV: BOT_DB)           │
         │ 3. 广告关键词与引流规则过滤 (RegExp)                  │
         │ 4. 存储 Message_ID <-> User_ID 映射 (有效期 30 天)  │
         └──────────────────────────┬──────────────────────────┘
                                    │
       ┌────────────────────────────┴────────────────────────────┐
       ▼                                                         ▼
[ 授权群组 A (-100xxxx) ]                               [ 授权群组 B (-100yyyy) ]
(原消息 + 快捷管理卡片)                                   (原消息 + 快捷管理卡片)
       │                                                         │
       └────────────────────────────┬────────────────────────────┘
                                    │ 管理员引用 (Reply) 任意卡片或消息
                                    ▼
                     [ Cloudflare Worker 提取目标 ID ]
                                    │
                                    ▼ (copyMessage)
                             [ 访客收到回复 ]
```

---

## 部署教程

### 步骤一：创建 Cloudflare KV 命名空间

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 进入 **Storage & Databases** -> **KV**。
3. 点击 **Create Namespace**，命名为 `tg-bot-db`（名称可自定义）。

---

### 步骤二：创建 Worker 并绑定 KV 数据库

1. 导航至 **Workers & Pages** -> 点击 **Create Application** -> **Create Worker**。
2. 输入服务名称（如 `tg-contact-bot`），点击 **Deploy**。
3. 进入该 Worker 的设置界面，点击 **Settings** -> **Bindings**（或 **Variables and Secrets**）。
4. 在 **KV Namespace Bindings** 区域点击 **Add**：
   * **Variable name（变量名称）**：严格填写为 `BOT_DB`（必须完全大写）。
   * **KV namespace**：选择步骤一中创建好的 `tg-bot-db`。
5. 点击 **Save and deploy** 保存。

---

### 步骤三：配置环境变量 (Environment Variables)

在 Worker 设置页面的 **Environment Variables** 区域点击 **Add**，依次添加以下参数：

| 变量名称 (Variable Name) | 必填 | 示例值 | 作用说明 |
| :--- | :---: | :--- | :--- |
| `BOT_TOKEN` | **是** | `` | Telegram Bot Token（建议开启 Encrypt 加密存储） |
| `SECRET_PATH` | **是** | `/` | Webhook 路径暗号（必须以 `/` 开头） |
| `OWNER_GROUP_IDS` | **是** | `1,2` | 授权管理群 ID，**多个群用英文逗号 `,` 分隔** |
| `OWNER_ID` | 否 | `` | 超级管理员个人数字 ID（用于私聊专属后台管理） |

---

### 步骤四：部署 Worker 业务代码

1. 在 Worker 管理页面点击 **Edit code** 进入代码编辑器。
2. 清空默认生成的脚本，将项目中的完整 `worker.js` 代码粘贴进去。
3. 点击右上角 **Deploy** 进行发布。

---

### 步骤五：注册 Telegram Webhook

将你的 Cloudflare Worker 自定义域名（或默认分配的 workers.dev 域名）注册到 Telegram 官方服务器。

在浏览器地址栏打开以下 URL（注意替换 `<BOT_TOKEN>`、`<你的Worker域名>` 与 `<SECRET_PATH>`）：

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<你的Worker域名><SECRET_PATH>&drop_pending_updates=true
```

**示例：**
```text
https://api.telegram.org/](https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<你的Worker域名><SECRET_PATH>&drop_pending_updates=true)
```

若页面返回 `{"ok":true,"result":true,"description":"Webhook was set"}`，则代表注册成功。

---

## 运行与自检验证

1. **健康自检**：在浏览器直接访问你的 Webhook 地址（例如 `https://tgchat.2pac.pp.ua/xiagefei120`），若配置正确会返回纯文本健康报告：
   ```text
   Worker 多群组版运行正常！
   Token 状态: 已配置 ✅
   KV 状态: 已成功绑定 ✅
   超管个人ID: XXXXXXXXXXXXX
   已授权管理群组 (1个): -100XXXXXXXXXXXX
   ```
2. **群组管理员赋权**：务必将机器人拉入 `OWNER_GROUP_IDS` 中配置的所有群组，并将机器人提升为**群管理员**（至少开启“发送消息”和“删除消息”权限）。
3. **唤出管理面板**：
   * 在已授权的群组内发送 `/start`，机器人会呼出包含“免打扰切换”与“黑名单管理”的总控面板。
   * 超管个人私聊机器人发送 `/start`，同样可以独立唤出管理面板。
4. **双向消息测试**：
   * 使用非管理账号向机器人私聊发送文字或图片；
   * 检查所有管理群是否均收到原消息及附带用户 ID、一键拉黑按钮的信息卡；
   * 在群内对准消息或卡片点击 **Reply（回复）**，验证访客是否能无缝收到回复。

---

## 常见问题解答 (FAQ)

#### Q1: 回复访客时机器人提示“未能识别到对应的目标用户 ID”？
* **A**: 请检查是否使用了 Telegram 原生的 **Reply（引用回复）** 功能。回复时必须长按或右键点击“访客发来的原消息”或“附带按钮的信息卡”，不能在群内空白处直接打字发送。

#### Q2: 访问暗号路径出现 `Error 1101 (Worker threw exception)`？
* **A**: 1101 表示 Worker 代码在加载时抛出了未捕获的致命错误。请检查：
  1. KV 命名空间绑定名称是否严格大写为 `BOT_DB`；
  2. 环境变量 `BOT_TOKEN` 是否已正确填入。

#### Q3: 管理群内收不到访客消息推送？
* **A**: 请排查以下项：
  1. 群组数字 ID 是否以 `-100` 开头；
  2. 机器人是否已被拉进群组，且是否赋予了发消息的管理员权限；
  3. 访客消息是否触发了黑名单关键词或链接引流规则被系统直接拦截。
