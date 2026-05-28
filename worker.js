// ========================================
// 配置
// ========================================

const BOT_TOKEN = '';

const ADMIN_ID = '';

const BOT_USERNAME = 'your_bot';

const ALLOW_GROUP_IDS = [
  -1001234567890
];

const RATE_LIMIT_SECONDS = 30;

const MAX_MESSAGE_LENGTH = 1000;


// ========================================
// 限速缓存
// ========================================

const rateLimitMap = new Map();


// ========================================
// Telegram API
// ========================================

async function sendMessage(chatId, text, options = {}) {

  return fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        ...options
      })
    }
  );
}


// ========================================
// Markdown 转义
// ========================================

function escapeMarkdown(text) {

  return String(text).replace(
    /[_*[\]()~`>#+=|{}.!-]/g,
    '\\$&'
  );
}


// ========================================
// AI 分类
// ========================================

async function classifyFeedback(ai, text) {

  try {

    const result = await ai.run(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [
          {
            role: 'user',
            content:
`分析以下反馈属于哪类。

只能返回：
Bug
建议
举报
咨询
其它

反馈：
${text}`
          }
        ]
      }
    );

    return (
      result.response || '其它'
    ).trim();

  } catch {

    return '其它';
  }
}


// ========================================
// AI 标签提取
// ========================================

async function generateTags(ai, text) {

  try {

    const result = await ai.run(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [
          {
            role: 'user',
            content:
`请从以下反馈中提取最多5个关键词标签。

要求：
- 只返回标签
- 使用逗号分隔
- 不要解释

反馈：
${text}`
          }
        ]
      }
    );

    return (
      result.response || '其它'
    ).trim();

  } catch {

    return '其它';
  }
}


// ========================================
// 保存反馈
// ========================================

async function saveFeedback(
  db,
  data
) {

  await db.prepare(
`
INSERT INTO feedbacks (

  user_id,
  username,
  first_name,

  group_id,
  group_name,

  category,
  tags,

  content

)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`
  )
  .bind(
    data.user_id,
    data.username,
    data.first_name,

    data.group_id,
    data.group_name,

    data.category,
    data.tags,

    data.content
  )
  .run();
}


// ========================================
// 获取统计
// ========================================

async function getStats(db) {

  const total =
    await db.prepare(
      `SELECT COUNT(*) as count FROM feedbacks`
    ).first();

  const categories =
    await db.prepare(
`
SELECT
  category,
  COUNT(*) as count
FROM feedbacks
GROUP BY category
ORDER BY count DESC
`
    ).all();

  return {
    total,
    categories
  };
}


// ========================================
// TOP 标签
// ========================================

async function getTopTags(db) {

  const rows =
    await db.prepare(
`
SELECT tags
FROM feedbacks
ORDER BY id DESC
LIMIT 100
`
    ).all();

  const map = {};

  for (const row of rows.results) {

    const tags =
      String(row.tags)
      .split(',');

    for (let tag of tags) {

      tag = tag.trim();

      if (!tag) continue;

      map[tag] = (map[tag] || 0) + 1;
    }
  }

  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
}


// ========================================
// 最近反馈
// ========================================

async function getRecent(db) {

  return db.prepare(
`
SELECT
  category,
  content,
  created_at
FROM feedbacks
ORDER BY id DESC
LIMIT 5
`
  ).all();
}


// ========================================
// 主程序
// ========================================

export default {

  async fetch(request, env) {

    if (request.method !== 'POST') {

      return new Response('Not Found', {
        status: 404
      });
    }

    try {

      const update =
        await request.json();

      const msg =
        update.message;

      if (!msg || !msg.text) {

        return new Response('ok');
      }

      const text =
        msg.text.trim();

      const userId =
        msg.from.id;

      const chatId =
        msg.chat.id;

      // 管理员命令
      // ====================================

      if (
        userId == ADMIN_ID
      ) {

        // /stats
        if (text === '/stats') {

          const stats =
            await getStats(env.DB);

          let markdown =
`📊 *反馈统计*

━━━━━━━━━━

📦 总反馈数：
${stats.total.count}

`;

          for (
            const item of
            stats.categories.results
          ) {

            markdown +=
`\n🏷 ${escapeMarkdown(item.category)}：${item.count}`;
          }

          await sendMessage(
            ADMIN_ID,
            markdown
          );

          return new Response('ok');
        }

        // /top
        if (text === '/top') {

          const topTags =
            await getTopTags(env.DB);

          let markdown =
`🔥 *热门标签 TOP*

━━━━━━━━━━
`;

          for (
            const [tag, count]
            of topTags
          ) {

            markdown +=
`\n#${escapeMarkdown(tag)} (${count})`;
          }

          await sendMessage(
            ADMIN_ID,
            markdown
          );

          return new Response('ok');
        }

        // /recent
        if (text === '/recent') {

          const recent =
            await getRecent(env.DB);

          let markdown =
`🕓 *最近反馈*

━━━━━━━━━━
`;

          for (
            const item
            of recent.results
          ) {

            markdown +=
`

🏷 ${escapeMarkdown(item.category)}

${escapeMarkdown(item.content.slice(0, 50))}
`;
          }

          await sendMessage(
            ADMIN_ID,
            markdown
          );

          return new Response('ok');
        }
      }

      // 群组白名单
      // ====================================

      if (
        !ALLOW_GROUP_IDS.includes(chatId)
      ) {

        return new Response('ok');
      }

      // 必须@
      // ====================================

      if (
        !text.includes(
          `@${BOT_USERNAME}`
        )
      ) {

        return new Response('ok');
      }

      // 提取反馈
      // ====================================

      const feedbackContent =
        text.replace(
          `@${BOT_USERNAME}`,
          ''
        ).trim();

      if (!feedbackContent) {

        return new Response('ok');
      }

      // 长度限制
      // ====================================

      if (
        feedbackContent.length >
        MAX_MESSAGE_LENGTH
      ) {

        await sendMessage(
          chatId,
          '❌ 内容过长',
          {
            reply_to_message_id:
              msg.message_id
          }
        );

        return new Response('ok');
      }

      // 限速
      // ====================================

      const now = Date.now();

      const lastTime =
        rateLimitMap.get(userId) || 0;

      if (
        now - lastTime <
        RATE_LIMIT_SECONDS * 1000
      ) {

        await sendMessage(
          chatId,
          '⏳ 请稍后再发送',
          {
            reply_to_message_id:
              msg.message_id
          }
        );

        return new Response('ok');
      }

      rateLimitMap.set(
        userId,
        now
      );

      // AI 分类
      // ====================================

      const category =
        await classifyFeedback(
          env.AI,
          feedbackContent
        );

      // AI 标签
      // ====================================

      const tags =
        await generateTags(
          env.AI,
          feedbackContent
        );

      // 保存数据库
      // ====================================

      await saveFeedback(
        env.DB,
        {
          user_id:
            String(userId),

          username:
            msg.from.username || '',

          first_name:
            msg.from.first_name || '',

          group_id:
            String(chatId),

          group_name:
            msg.chat.title || '',

          category,
          tags,

          content:
            feedbackContent
        }
      );

      // Markdown 美化
      // ====================================

      const markdown =
`📢 *新的用户反馈*

━━━━━━━━━━

🏷 *分类*
\`${escapeMarkdown(category)}\`

🔖 *标签*
${escapeMarkdown(tags)}

👤 *用户*
${escapeMarkdown(msg.from.first_name)}

🆔 *用户ID*
\`${userId}\`

👥 *群组*
${escapeMarkdown(msg.chat.title)}

💬 *反馈内容*

${escapeMarkdown(feedbackContent)}

━━━━━━━━━━`;

      // 推送管理员
      // ====================================

      await sendMessage(
        ADMIN_ID,
        markdown
      );

      // 群回复
      // ====================================

      await sendMessage(
        chatId,
        '✅ 反馈已提交',
        {
          reply_to_message_id:
            msg.message_id
        }
      );

      return new Response('ok');

    } catch (err) {

      console.log(err);

      return new Response(
        'error',
        {
          status: 500
        }
      );
    }
  }
};
