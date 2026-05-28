# Telegram 反馈 Bot

基于 **Cloudflare Workers + D1 + Workers AI** 的轻量反馈机器人。全球边缘节点运行，零服务器、零成本起步。

---

## 一、创建 D1 数据库

进入 Cloudflare 控制台 → **D1** → **Create database**

名称：`feedback-bot`

---

## 二、创建数据表

在 D1 控制台执行以下 SQL：

```sql
-- 反馈主表
CREATE TABLE feedbacks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    username    TEXT,
    first_name  TEXT,
    group_id    TEXT,
    group_name  TEXT,
    category    TEXT,
    content     TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 标签独立表（支持真正的 SQL 聚合）
CREATE TABLE feedback_tags (
    feedback_id INTEGER NOT NULL,
    tag         TEXT NOT NULL,
    FOREIGN KEY (feedback_id) REFERENCES feedbacks(id)
);

-- 限速持久化表（跨边缘节点一致）
CREATE TABLE rate_limits (
    user_id TEXT PRIMARY KEY,
    last_at INTEGER NOT NULL
);

-- 关键索引
CREATE INDEX idx_feedbacks_category   ON feedbacks(category);
CREATE INDEX idx_feedbacks_created_at ON feedbacks(created_at);
CREATE INDEX idx_feedback_tags_tag    ON feedback_tags(tag);
CREATE INDEX idx_feedback_tags_fid    ON feedback_tags(feedback_id);
```

---

## 三、Worker 绑定

Worker → **Settings → Bindings** 添加：

| 类型           | 变量名 | 值              |
| ------------ | --- | -------------- |
| D1 Database  | `DB` | `feedback-bot` |
| Workers AI   | `AI` | 默认             |

---

## 四、配置环境变量

**敏感信息一律走 Secrets，不要写进源码。** 用 wrangler 或控制台 **Variables and Secrets** 设置：

| 变量名                  | 类型     | 必填     | 说明                            |
| -------------------- | ------ | ------ | ----------------------------- |
| `BOT_TOKEN`          | Secret | ✅      | Telegram Bot Token            |
| `ADMIN_ID`           | Secret | ✅      | 管理员 Telegram 用户 ID            |
| `BOT_USERNAME`       | Var    | ✅      | Bot 用户名，不带 @                  |
| `ALLOW_GROUP_IDS`    | Var    | ✅      | 允许的群组 ID，逗号分隔                 |
| `WEBHOOK_SECRET`     | Secret | 强烈建议   | Telegram webhook 校验密钥（任意字符串）  |
| `RATE_LIMIT_SECONDS` | Var    | 否      | 默认 30 秒                       |
| `MAX_MESSAGE_LENGTH` | Var    | 否      | 默认 1000                       |

命令行示例：

```bash
wrangler secret put BOT_TOKEN
wrangler secret put ADMIN_ID
wrangler secret put WEBHOOK_SECRET
```

`ALLOW_GROUP_IDS` 示例值：`-1001234567890,-1009876543210`

---

## 五、部署

```bash
wrangler deploy
```

或在控制台直接粘贴 `worker.js`。

---

## 六、设置 Telegram Webhook（必须带 secret_token）

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

`secret_token` 必须和上一步 `WEBHOOK_SECRET` 完全一致。Telegram 会在每次回调时通过 `X-Telegram-Bot-Api-Secret-Token` 头携带，Worker 会校验，不匹配直接 401。

⚠️ 不设置 secret 的话，任何知道 Worker URL 的人都能伪造 Telegram 更新，污染数据库、刷 AI 消耗、给管理员发垃圾。**强烈建议设置。**

---

## 使用

### 群组提交反馈

在被列入 `ALLOW_GROUP_IDS` 的群组中：

> @你的bot 网站打不开

Bot 自动：

1. 基于 Telegram entities 精确识别 @ 提及（不会被 `email@bot.com` 误触发）
2. 校验长度 / 限速
3. **单次调用** Workers AI → 同时返回分类 + 标签
4. 写入 D1（feedback 先入主表拿到真实 ID，再批量写 tags；tags 失败降级，不影响主反馈和通知）
5. **并行**：推送管理员 + 群内 ✅ 回复
6. 全部异步执行，webhook 立即响应，避免 Telegram 超时重试

### 管理员私聊命令

| 命令        | 功能                       |
| --------- | ------------------------ |
| `/stats`  | 总反馈数 + 各分类计数             |
| `/top`    | TOP 10 标签（全量 SQL 聚合，非采样） |
| `/recent` | 最近 5 条反馈（含标签）            |

---

## 架构

```
Telegram Group
        ↓
     @bot
        ↓
Cloudflare Worker
   ├─ Webhook Secret 校验
   ├─ 群组白名单
   ├─ Entities @ 检测
   ├─ D1 限速
   │
   └─ ctx.waitUntil 异步处理
       │
       ├─→ Workers AI (单次调用：分类 + 标签)
       │
       ├─→ D1 写入 (feedbacks → 拿到 ID → batch 写 feedback_tags)
       │
       └─→ 并行通知
             ↓             ↓
          管理员私聊      群内回复
```

---

## 安全 & 健壮性

| 项               | 实现                                       |
| --------------- | ---------------------------------------- |
| Webhook 来源验证    | `X-Telegram-Bot-Api-Secret-Token` 头校验    |
| 敏感信息隔离          | BOT_TOKEN / ADMIN_ID 全部走 Secrets，不进源码    |
| 群组白名单           | `ALLOW_GROUP_IDS` 严格匹配                   |
| @ 提及精确检测        | 基于 Telegram `entities`，避免字符串 includes 误判 |
| 用户限速            | D1 持久化，跨边缘节点全局一致                         |
| 长度限制            | 防 token 爆炸、大文本 DoS                       |
| 仅文本消息           | 自动忽略图片 / 文件 / Sticker / 编辑消息             |
| AI 调用失败降级       | 自动落 `其它` 分类 + 空标签，反馈仍正常入库                |
| Webhook 不阻塞     | `ctx.waitUntil` 让响应秒返回，避免 Telegram 重试    |
| MarkdownV2 完整转义 | 覆盖全部特殊字符 `_*[]()~``>#+-=\|{}.!\`         |
| 数据降级           | 标签写入失败不阻断主反馈和通知                  |
| 错误可观测           | 失败路径全部 `console.error`，可通过 wrangler tail 查看 |

---

## 数据表速查

| 表 | 字段 | 说明 |
| --- | --- | --- |
| feedbacks | id, user_id, username, first_name, group_id, group_name, category, content, created_at | 反馈主表 |
| feedback_tags | feedback_id, tag | 标签明细表，1:N |
| rate_limits | user_id, last_at | 限速记录（unix 秒） |

---

## 相比初版的优化

| 项           | 初版              | 当前                          |
| ----------- | --------------- | --------------------------- |
| 敏感信息        | 硬编码源码           | 全部 Secrets                  |
| Webhook 校验  | 无               | secret_token 强制校验           |
| 限速          | 进程内 Map（边缘节点失效） | D1 持久，跨节点一致                 |
| AI 调用       | 串行 2 次          | 合并 1 次（延迟减半，token 减半）       |
| 入库 / 通知     | 全程 await 串行     | `ctx.waitUntil` 并行          |
| @ 检测        | `text.includes` | 基于 entities，精确              |
| TOP 标签      | JS 端聚合最近 100 条  | 独立 tags 表 + SQL GROUP BY 全量 |
| 索引          | 无               | category / created_at / tag |
| Markdown 转义 | 与 parse_mode 错配 | MarkdownV2 完整覆盖             |
| 错误处理        | 静默吞             | 全路径 console.error           |
| Telegram 重试 | 长链路易超时          | webhook 秒返回                 |

---

## 免费额度参考

| 服务         | 免费额度                  |
| ---------- | --------------------- |
| Workers    | 10 万次请求/天             |
| D1         | 5 万行读 / 10 万行写 每天     |
| Workers AI | 10000 Neurons/天（小 bot 够） |

轻量使用基本零成本运行。
