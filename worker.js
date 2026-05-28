// ========================================
// Telegram 反馈 Bot · Cloudflare Worker
// 配置走环境变量，详见 README
// ========================================

const VALID_CATEGORIES = ['Bug', '建议', '举报', '咨询', '其它'];

const DEFAULT_RATE_LIMIT_SECONDS = 30;

const DEFAULT_MAX_MESSAGE_LENGTH = 1000;


// ========================================
// MarkdownV2 转义
// ========================================

function escapeMd(text) {

  return String(text ?? '').replace(
    /[_*[\]()~`>#+\-=|{}.!\\]/g,
    '\\$&'
  );
}

function escapeMdCode(text) {

  return String(text ?? '').replace(
    /[`\\]/g,
    '\\$&'
  );
}


// ========================================
// Telegram API
// ========================================

async function sendMessage(token, chatId, text, options = {}) {

  return fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        ...options
      })
    }
  );
}


// ========================================
// AI 一次性分析（分类 + 标签合并为单次调用）
// ========================================

async function analyzeFeedback(ai, text) {

  try {

    const result = await ai.run(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [
          {
            role: 'system',
            content:
              '你是反馈分析助手。严格按要求格式输出，不要任何解释。'
          },
          {
            role: 'user',
            content:
`分析下面反馈，输出两行：
分类: <Bug|建议|举报|咨询|其它>
标签: <最多5个关键词，逗号分隔>

反馈：
${text}`
          }
        ]
      }
    );

    const out = String(result.response || '');

    const catMatch =
      out.match(/分类\s*[:：]\s*(\S+)/);

    const tagMatch =
      out.match(/标签\s*[:：]\s*([^\n]+)/);

    const category =
      catMatch && VALID_CATEGORIES.includes(catMatch[1].trim())
        ? catMatch[1].trim()
        : '其它';

    const tags =
      tagMatch
        ? tagMatch[1]
            .split(/[,，、;；]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 5)
        : [];

    return { category, tags };

  } catch (err) {

    console.error('analyzeFeedback failed:', err);

    return { category: '其它', tags: [] };
  }
}


// ========================================
// @ 提及检测（基于 Telegram entities）
// ========================================

function isMentioningBot(msg, botUsername) {

  if (!msg.entities || !msg.text || !botUsername) return false;

  const target = `@${botUsername}`.toLowerCase();
  const text = msg.text;

  return msg.entities.some((e) =>
    e.type === 'mention' &&
    text.slice(e.offset, e.offset + e.length).toLowerCase() === target
  );
}

function extractFeedback(msg, botUsername) {

  const text = msg.text || '';

  if (!msg.entities) return text.trim();

  const target = `@${botUsername}`.toLowerCase();

  const mentions =
    msg.entities
      .filter((e) =>
        e.type === 'mention' &&
        text.slice(e.offset, e.offset + e.length).toLowerCase() === target
      )
      .sort((a, b) => b.offset - a.offset);

  let result = text;

  for (const m of mentions) {
    result = result.slice(0, m.offset) + result.slice(m.offset + m.length);
  }

  return result.trim();
}


// ========================================
// 限速（D1 持久化，跨边缘节点一致）
// ========================================

async function checkAndUpdateRateLimit(db, userId, windowSec) {

  const now = Math.floor(Date.now() / 1000);

  const row = await db.prepare(
    `SELECT last_at FROM rate_limits WHERE user_id = ?`
  ).bind(String(userId)).first();

  if (row && now - row.last_at < windowSec) {
    return false;
  }

  await db.prepare(
`INSERT INTO rate_limits (user_id, last_at)
VALUES (?, ?)
ON CONFLICT(user_id) DO UPDATE SET last_at = excluded.last_at`
  ).bind(String(userId), now).run();

  return true;
}


// ========================================
// 保存反馈（feedback + tags 单 batch 原子写入）
// ========================================

async function saveFeedback(db, data) {

  const stmts = [
    db.prepare(
`INSERT INTO feedbacks (
  user_id, username, first_name,
  group_id, group_name,
  category, content
) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      data.user_id,
      data.username,
      data.first_name,
      data.group_id,
      data.group_name,
      data.category,
      data.content
    ),
    ...data.tags.map((tag) =>
      db.prepare(
        `INSERT INTO feedback_tags (feedback_id, tag) VALUES (last_insert_rowid(), ?)`
      ).bind(tag)
    )
  ];

  await db.batch(stmts);
}


// ========================================
// 查询
// ========================================

async function getStats(db) {

  const [total, categories] = await Promise.all([

    db.prepare(`SELECT COUNT(*) AS count FROM feedbacks`).first(),

    db.prepare(
`SELECT category, COUNT(*) AS count
FROM feedbacks
GROUP BY category
ORDER BY count DESC`
    ).all()
  ]);

  return { total, categories };
}

async function getTopTags(db) {

  const r = await db.prepare(
`SELECT tag, COUNT(*) AS count
FROM feedback_tags
GROUP BY tag
ORDER BY count DESC
LIMIT 10`
  ).all();

  return r.results || [];
}

async function getRecent(db) {

  const r = await db.prepare(
`SELECT
  f.id,
  f.category,
  f.content,
  f.created_at,
  GROUP_CONCAT(t.tag) AS tags
FROM feedbacks f
LEFT JOIN feedback_tags t ON t.feedback_id = f.id
GROUP BY f.id
ORDER BY f.id DESC
LIMIT 5`
  ).all();

  return r.results || [];
}


// ========================================
// 工具
// ========================================

function truncate(str, max) {

  const s = String(str ?? '');

  return s.length > max ? s.slice(0, max) + '…' : s;
}

function parseConfig(env) {

  const ids =
    String(env.ALLOW_GROUP_IDS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));

  return {
    botToken: env.BOT_TOKEN || '',
    adminId: String(env.ADMIN_ID || ''),
    botUsername: env.BOT_USERNAME || '',
    allowGroupIds: ids,
    webhookSecret: env.WEBHOOK_SECRET || '',
    rateLimitSeconds:
      Number(env.RATE_LIMIT_SECONDS) || DEFAULT_RATE_LIMIT_SECONDS,
    maxMessageLength:
      Number(env.MAX_MESSAGE_LENGTH) || DEFAULT_MAX_MESSAGE_LENGTH
  };
}


// ========================================
// 管理员命令
// ========================================

async function handleAdminCommand(env, cfg, text) {

  if (text === '/stats') {

    const stats = await getStats(env.DB);

    let md =
`📊 *反馈统计*

━━━━━━━━━━

📦 总反馈数: ${escapeMd(stats.total.count)}
`;

    for (const item of stats.categories.results || []) {
      md += `\n🏷 ${escapeMd(item.category)}: ${escapeMd(item.count)}`;
    }

    await sendMessage(cfg.botToken, cfg.adminId, md);

    return true;
  }

  if (text === '/top') {

    const tags = await getTopTags(env.DB);

    let md =
`🔥 *热门标签 TOP*

━━━━━━━━━━`;

    if (tags.length === 0) {
      md += `\n\n_暂无数据_`;
    } else {
      for (const t of tags) {
        md += `\n\\#${escapeMd(t.tag)} \\(${escapeMd(t.count)}\\)`;
      }
    }

    await sendMessage(cfg.botToken, cfg.adminId, md);

    return true;
  }

  if (text === '/recent') {

    const recent = await getRecent(env.DB);

    let md =
`🕓 *最近反馈*

━━━━━━━━━━`;

    if (recent.length === 0) {

      md += `\n\n_暂无反馈_`;

    } else {

      for (const item of recent) {

        const tags =
          item.tags ? item.tags.split(',').filter(Boolean) : [];

        md += `\n\n🏷 ${escapeMd(item.category)}`;

        if (tags.length) {
          md += `  ${tags.map((t) => '\\#' + escapeMd(t)).join(' ')}`;
        }

        md += `\n${escapeMd(truncate(item.content, 80))}`;
      }
    }

    await sendMessage(cfg.botToken, cfg.adminId, md);

    return true;
  }

  return false;
}


// ========================================
// 反馈处理（异步，不阻塞 webhook 响应）
// ========================================

async function processFeedback(env, cfg, msg, content) {

  const chatId = msg.chat.id;

  // 长度限制
  if (content.length > cfg.maxMessageLength) {

    await sendMessage(cfg.botToken, chatId, '❌ 内容过长', {
      reply_to_message_id: msg.message_id
    });

    return;
  }

  // 限速
  const allowed = await checkAndUpdateRateLimit(
    env.DB,
    msg.from.id,
    cfg.rateLimitSeconds
  );

  if (!allowed) {

    await sendMessage(cfg.botToken, chatId, '⏳ 请稍后再发送', {
      reply_to_message_id: msg.message_id
    });

    return;
  }

  // AI 分析（单次调用同时返回分类 + 标签）
  const { category, tags } =
    await analyzeFeedback(env.AI, content);

  // 入库
  await saveFeedback(env.DB, {
    user_id: String(msg.from.id),
    username: msg.from.username || '',
    first_name: msg.from.first_name || '',
    group_id: String(chatId),
    group_name: msg.chat.title || '',
    category,
    tags,
    content
  });

  // Markdown
  const markdown =
`📢 *新的用户反馈*

━━━━━━━━━━

🏷 *分类*
\`${escapeMdCode(category)}\`

🔖 *标签*
${tags.length ? tags.map((t) => '\\#' + escapeMd(t)).join(' ') : '_无_'}

👤 *用户*
${escapeMd(msg.from.first_name || '')}

🆔 *用户ID*
\`${escapeMdCode(msg.from.id)}\`

👥 *群组*
${escapeMd(msg.chat.title || '')}

💬 *反馈内容*

${escapeMd(content)}

━━━━━━━━━━`;

  // 推送 + 回复（并行）
  await Promise.all([
    sendMessage(cfg.botToken, cfg.adminId, markdown),
    sendMessage(cfg.botToken, chatId, '✅ 反馈已提交', {
      reply_to_message_id: msg.message_id
    })
  ]);
}


// ========================================
// 主入口
// ========================================

export default {

  async fetch(request, env, ctx) {

    if (request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }

    const cfg = parseConfig(env);

    if (!cfg.botToken || !cfg.adminId || !cfg.botUsername) {

      console.error(
        'missing required env: BOT_TOKEN / ADMIN_ID / BOT_USERNAME'
      );

      return new Response('Misconfigured', { status: 500 });
    }

    // Webhook secret 校验
    if (cfg.webhookSecret) {

      const got =
        request.headers.get('X-Telegram-Bot-Api-Secret-Token');

      if (got !== cfg.webhookSecret) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    let update;

    try {
      update = await request.json();
    } catch (err) {
      console.error('bad json:', err);
      return new Response('Bad Request', { status: 400 });
    }

    const msg = update.message;

    // 编辑消息 / 频道帖 / 非文本一律忽略
    if (!msg || !msg.text) {
      return new Response('ok');
    }

    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // 管理员命令（仅私聊）
    if (
      String(userId) === cfg.adminId &&
      msg.chat.type === 'private' &&
      text.startsWith('/')
    ) {

      ctx.waitUntil(
        handleAdminCommand(env, cfg, text).catch((err) =>
          console.error('admin cmd failed:', err)
        )
      );

      return new Response('ok');
    }

    // 群组白名单
    if (!cfg.allowGroupIds.includes(chatId)) {
      return new Response('ok');
    }

    // 必须真正 @ bot（基于 entities，避免 email@bot 等误触发）
    if (!isMentioningBot(msg, cfg.botUsername)) {
      return new Response('ok');
    }

    const content = extractFeedback(msg, cfg.botUsername);

    if (!content) {
      return new Response('ok');
    }

    // 后续处理全部异步，立即响应 Telegram 避免 5s 超时重试
    ctx.waitUntil(
      processFeedback(env, cfg, msg, content).catch((err) =>
        console.error('process failed:', err)
      )
    );

    return new Response('ok');
  }
};
