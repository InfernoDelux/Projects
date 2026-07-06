require('dotenv').config();
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');
const Database = require('better-sqlite3');

// =====================
// DATABASE
// =====================
const db = new Database('bot.db');

db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  role TEXT,
  content TEXT
)
`).run();

// =====================
// MEMORY (SQLite)
// =====================
function saveMessage(userId, role, content) {
  db.prepare(`
    INSERT INTO messages (user_id, role, content)
    VALUES (?, ?, ?)
  `).run(userId, role, content);
}

function getHistory(userId) {
  return db.prepare(`
    SELECT role, content
    FROM messages
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 10
  `).all(userId).reverse();
}

// =====================
// ANTI-SPAM SYSTEM
// =====================
const lastMessageTime = new Map();
const spamCounter = new Map();

// reset spam every minute
setInterval(() => {
  spamCounter.clear();
}, 60 * 1000);

// =====================
// BOT INIT
// =====================
const bot = new Telegraf(process.env.BOT_TOKEN);

// Groq client (OpenAI compatible)
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// =====================
// MENU COMMANDS
// =====================
bot.telegram.setMyCommands([
  { command: 'start', description: 'Запустить бота 🤖' },
  { command: 'help', description: 'Помощь 📌' },
  { command: 'reset', description: 'Очистить память 🧹' },
]);

// =====================
// COMMANDS
// =====================
bot.start((ctx) => {
  ctx.reply('🤖 Привет! Я AI-бот. Напиши сообщение или используй /help');
});

bot.help((ctx) => {
  ctx.reply(
`📌 Команды:

/start — запустить бота
/help — помощь
/reset — очистить память`
  );
});

bot.command('reset', (ctx) => {
  const userId = String(ctx.from.id);

  db.prepare(`
    DELETE FROM messages
    WHERE user_id = ?
  `).run(userId);

  ctx.reply('🧹 Память очищена!');
});

// =====================
// MAIN AI LOGIC
// =====================
bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  const userText = ctx.message.text;

  try {

    // =====================
    // 1. LIMIT 5 SECONDS
    // =====================
    const now = Date.now();
    const lastTime = lastMessageTime.get(userId);

    if (lastTime && now - lastTime < 5000) {
      const wait = Math.ceil((5000 - (now - lastTime)) / 1000);
      return ctx.reply(`⏳ Подожди ${wait} сек перед следующим сообщением`);
    }

    lastMessageTime.set(userId, now);

    // =====================
    // 2. ANTI-SPAM
    // =====================
    const count = spamCounter.get(userId) || 0;
    spamCounter.set(userId, count + 1);

    if (count >= 25) {
      return ctx.reply('🚫 Слишком много сообщений. Попробуй позже.');
    }

    // =====================
    // 3. SAVE USER MESSAGE
    // =====================
    saveMessage(userId, 'user', userText);

    const history = getHistory(userId);

    // =====================
    // 4. AI REQUEST (SAFE)
    // =====================
    let answer;

    try {
      const response = await client.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `
Ты — умный русскоязычный ассистент.
Отвечай грамотно, понятно и по делу.
`
          },
          ...history
        ],
      });

      answer = response.choices[0].message.content;

    } catch (apiError) {
      console.error('❌ Groq error:', apiError);
      return ctx.reply('⚠️ AI перегружен, попробуй позже');
    }

    // =====================
    // 5. SAVE BOT ANSWER
    // =====================
    saveMessage(userId, 'assistant', answer);

    ctx.reply(answer);

  } catch (err) {
    console.error(err);
    ctx.reply('❌ Ошибка сервера');
  }
});

// =====================
// SAFE START / STOP
// =====================
bot.launch().then(() => {
  console.log('🤖 Bot запущен (PRO mode)');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// global crash protection
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});