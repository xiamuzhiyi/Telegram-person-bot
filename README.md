# Telegram Forum CRM Work-order System

基于 Cloudflare Workers 与 Telegram Forum（超级群话题）特性的轻量级双向私聊中继与工单客服系统。访客私聊发送的消息会自动在管理群创建独立话题房间，支持真实验证码、更名案底追踪、消息双向表情粉碎与强迫症级 UX 排版。

---

## 核心特性

* **话题工单隔离**：访客私信自动在 Telegram 超级群中创建独立的话题（Topic）房间，双向实时中继文本、图片与多媒体。
* **动态人机验证**：访客首次来信需通过 9 以内的随机加法算术验证码，有效拦截引流脚本与垃圾广告机。
* **马甲案底追踪**：自动记录并追踪访客历史更名流水，以时间轴形式在情报卡片中展现改名轨迹。
* **分级展示交互**：
  * **单行置顶栏**：置顶精简单行情报（`📌 昵称 | 备注 (原名) | 用户名 | ID`），不遮挡聊天视野。
  * **情报底卡**：全角对齐排版，支持一键封禁、备注修改与黑名单管理。
* **双向物理粉碎**：管理员对群内任意消息贴上 `👎`（踩）表情，机器人会同步物理删除群内与访客端的对应消息。
* **隐形备注修改**：点击修改备注后，管理员在房间打字直接更新话题标题与卡片，并自动吞噬输入内容，不会外发给客户。
* **访客模拟测试**：超级管理员可通过 `/test on` 进入模拟访客模式，原地验证进房、验证码与消息流转，输入 `/test off` 即可切回。
* **自动降级容错**：当超级群开启“禁止保存与复制内容”时，自动降级为文本直接代发，避免 `the message can't be copied` 接口报错阻断通讯。

---

## 环境变量配置

在 Cloudflare Worker 的 **Settings** -> **Variables and Secrets** 中配置以下参数：

| 变量名 | 类型 | 必填 | 默认值 / 示例 | 说明 |
| :--- | :---: | :---: | :--- | :--- |
| **`BOT_TOKEN`** | Secret | **是** | `` | Telegram Bot Token（兼容 `TOKEN` 变量名） |
| **`BOT_DB`** | KV Binding | **是** | *(绑定 KV 空间)* | **必须绑定为 KV Namespace**，用于会话状态与索引存储 |
| **`OWNER_ID`** | Text | 选填 | `` | 超级管理员个人 Telegram 数字 ID |
| **`SECRET_PATH`** | Text | 选填 | `` | Webhook 访问路径暗号，防止未授权扫描 |
| **`WEBHOOK_SECRET`** | Secret | 选填 | `your_secret_token` | Webhook 请求头验证密钥（防伪造 update，兼容 `SECRET_TOKEN`） |
| **`OWNER_GROUP_IDS`** | Text | 选填 | `` | 授权备用管理超级群 ID（多个用英文逗号分隔） |

---

## 部署流程

### 1. 创建 KV 数据库并绑定
1. 在 Cloudflare 控制台进入 **Storage & Databases** -> **KV**，创建一个命名空间（例如 `tg-crm-kv`）。
2. 打开已创建的 Worker -> **Settings** -> **Bindings**。
3. 添加 **KV Namespace Binding**，Variable Name 必须严格填写为 **`BOT_DB`**，选择刚才创建的命名空间。

### 2. 部署代码与配置环境变量
1. 将 `worker.js` 代码粘贴至 Worker 编辑器中并保存部署。
2. 在 **Variables and Secrets** 中添加 `BOT_TOKEN`、`OWNER_ID`、`WEBHOOK_SECRET` 等环境变量。

### 3. 一键配置 Telegram Webhook
部署完成后，使用浏览器访问：
```text
https://<你的Worker域名>/setup
```
若返回 `{"ok": true, "result": true, "description": "Webhook was set"}`，则说明 Webhook 已成功接入官方 Telegram 服务端。

### 4. 检查服务健康状态
浏览器访问：
```text
https://<你的Worker域名><SECRET_PATH>
# 示例：https://crm.yourname.workers.dev/123XXXX
```
页面将回显当前 Token、KV、Webhook 防伪造以及群组绑定的健康诊断状态。

---

## 群组设置与绑定

### 1. 超级群要求
* 必须使用 **开启了 Topics（话题）** 的超级群（Supergroup）。
* 将机器人拉入群组，并提升为管理员，赋予以下权限：
  * **Manage Topics（管理话题）**
  * **Pin Messages（置顶消息）**
  * **Delete Messages（删除消息）**

### 2. 绑定大本营
群主或超管在群内任意位置发送：
```text
/bind
```
机器人回复 `绑定成功` 后，当前超级群即被持久化保存为工单处理中心。

---

## 操作指南与指令集

| 指令 / 动作 | 触发场景 | 功能说明 |
| :--- | :--- | :--- |
| **`/start`** | 私聊（超管） | 呼出全局后台控制台，可切换暂停免打扰模式与管理黑名单。 |
| **`/test on`** | 私聊（超管） | 开启模拟访客测试，超管发出的消息会作为新访客建房并推送到群聊。 |
| **`/test off`** | 私聊（超管） | 关闭测试模式，恢复超级管理员身份。 |
| **`/bind`** | 超级群 | 将当前群组设为工单大本营。 |
| **`/binduser <ID>`** | 群内话题房间 | 应急救援指令：强行将当前话题房间与指定的访客数字 ID 建立双向绑定。 |
| **`/cancel`** | 群内话题房间 | 取消正在进行的“修改备注”状态，避免后续正常打字被误当作备注吞噬。 |
| **贴 👎 表情** | 群内或私聊消息 | 在任意消息上添加 `👎` 表情 Reaction，系统双向物理撤回双方对应的消息记录。 |

---

## 常见问题排查

* **建房被拒绝（`chat is not a forum` / `not enough rights`）**：
  * 检查群组是否开启了 Topics 功能，以及机器人是否拥有 `Manage Topics` 管理员权限。
* **回复提示“该房间未关联到访客 ID”**：
  * 该话题属于人工手动创建或 KV 索引丢失，直接在话题内发送 `/binduser <访客ID>` 即可立即恢复双向通讯。
* **多媒体消息发送受限**：
  * 若群内发送纯图片/多媒体提示无法复制，请前往群设置 -> **Group Type** -> 关闭 **Restrict saving content（限制保存内容）**。纯文本消息系统已内建原生直发通道，不受此项限制。
