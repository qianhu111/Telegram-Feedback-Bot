## 一、先创建 D1 数据库

进入：

Cloudflare D1 Dashboard

创建：

`feedback-bot`

## 二、绑定 D1

Worker：

Settings
→ Bindings
→ Add Binding
→ D1 Database

变量名：

`DB`

## 三、创建数据表

进入 D1 控制台执行：

```sql id="0u5n1w"
CREATE TABLE IF NOT EXISTS feedbacks (

    id INTEGER PRIMARY KEY AUTOINCREMENT,

    user_id TEXT,
    username TEXT,
    first_name TEXT,

    group_id TEXT,
    group_name TEXT,

    category TEXT,
    tags TEXT,

    content TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 四、升级后的完整 Worker

部署 `worker.js`

## 新增的能力
/stats
管理员私聊 bot

/top
查看热门标签

/recent
查看最近反馈

## D1 现在保存

| 字段         | 内容   |
| ---------- | ---- |
| user_id    | 用户ID |
| username   | 用户名  |
| group_id   | 群组ID |
| category   | AI分类 |
| tags       | AI标签 |
| content    | 反馈内容 |
| created_at | 时间   |

## 功能汇总

1. 群组反馈收集
用户在群组中：
> @你的bot 反馈内容
即可提交反馈。
Bot 会：
- 自动识别
- 自动处理
- 自动推送

2. 群组白名单机制（防滥用）
只有 `ALLOW_GROUP_IDS` 中的群组会被监听。
即使：
- 别人拉 bot 进其它群
- 恶意邀请 bot
也不会触发监听。
这是当前最核心的安全机制之一。

3. 必须 @bot 才会触发
不会监听普通聊天。
只有：
> @bot 内容
才会处理。
避免：
- 误收集
- 大量无关消息
- 隐私问题

4. 自动推送给管理员
收到反馈后，自动发送给 `ADMIN_ID`
支持：
- 管理员私聊
- 后续可改频道
- 后续可改日志群

5. Markdown 美化通知
反馈消息会自动美化。
包括：
- 分类
- 标签
- 用户信息
- 群组信息
- 内容

结构化显示。

6. Workers AI 自动分类
使用 `Cloudflare Workers AI` 自动分析反馈类型。
当前支持：
- Bug
- 建议
- 举报
- 咨询
- 其它

例如：
> 网站打不开
自动：
> Bug

7. AI 自动标签提取
自动生成关键词标签。
例如：
> 登录页面一直卡加载

自动生成：
> 登录,页面,加载,卡顿

用于：
- 热门问题统计
- 后期搜索
- AI 分析

8. D1 数据库存储
使用 `Cloudflare D1` 永久保存反馈。

保存内容包括：
| 字段   | 内容         |
| ---- | ---------- |
| 用户ID | user_id    |
| 用户名  | username   |
| 群组ID | group_id   |
| 群组名称 | group_name |
| 分类   | category   |
| 标签   | tags       |
| 反馈内容 | content    |
| 时间   | created_at |

9. 用户限速（防刷）

当前默认：
> 30 秒一次

避免：
- 刷屏
- Flood
- AI Token 消耗攻击

10. 消息长度限制
自动限制 `MAX_MESSAGE_LENGTH`

防止：
- 巨量文本
- 恶意复制
- Token 爆炸

11. 仅处理文本消息
自动忽略：
- 图片
- Sticker
- 文件
- 视频
- GIF

减少滥用风险。

12. 自动回复用户
成功提交后：
群内自动回复：
> ✅ 反馈已提交

### 管理员功能
13. `/stats`
查看反馈统计。
例如：
`/stats`
返回：

```
总反馈数
Bug 数量
建议数量
举报数量
```

14. `/top`
查看热门标签。
例如：
`/top`
返回：

```
#登录
#支付
#卡顿
```

可用于：
- 高频问题分析
- 用户痛点分析

15. `/recent`
查看最近反馈。
例如：
`/recent`
返回最近几条反馈。

### 安全机制
16. 群组隔离
非白名单群：
> 完全无效

17. 防 AI 滥用

通过：
- 限速
- 长度限制
- 必须@
- 群组限制

减少：
- Token 消耗
- Prompt 滥用

18. Workers Serverless 架构
不需要：
- VPS
- Docker
- PM2
- 常驻进程

使用：
- Cloudflare Workers
- D1
- Workers AI

即可运行。

19. Webhook 架构
Telegram：
`Webhook`
直连 Worker。
优点：
- 延迟低
- 成本低
- 不会休眠
- 全球边缘节点

20. 完全免费可运行
当前架构：

| 服务         | 免费额度    |
| ---------- | ------- |
| Workers    | 很高      |
| D1         | 足够轻量bot |
| Workers AI | 有免费额度   |

轻量使用基本够用。

### 当前整体架构
```
Telegram Group
        ↓
     @bot
        ↓
Cloudflare Worker
        ↓
  Workers AI
   ↙       ↘
分类        标签
        ↓
       D1
        ↓
管理员通知
```
