// main.js — главный процесс Electron
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------- Пути ----------
// В разработке храним данные рядом с кодом, в собранном приложении — в папке userData
// (в Program Files писать нельзя). Туда же бот пишет moderation.log.
const dataDir = app.isPackaged ? app.getPath('userData') : __dirname;
const settingsPath = path.join(dataDir, 'settings.json');
const botPath = path.join(__dirname, 'python', 'bot.py');
const defaultWordsPath = path.join(__dirname, 'python', 'banned_words.txt');
const wordsPath = app.isPackaged ? path.join(dataDir, 'banned_words.txt') : defaultWordsPath;

const DEFAULT_SETTINGS = { token: '', nick: '', channel: '', timeout: true };

// ---------- Состояние ----------
let win = null;
let botProc = null;     // процесс Python
let starting = false;   // защита от двойного нажатия «Запустить»
let stopping = false;   // true, если остановку запросил пользователь
let hintShown = false;  // подсказку про зависимости показываем один раз за запуск
let stats = { deleted: 0, timeouts: 0, startedAt: null };

// ---------- Отправка событий в окно ----------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const nowTime = () => new Date().toLocaleTimeString('ru-RU', { hour12: false });
function pushLog(type, text, time) {
  send('bot:log', { time: time || nowTime(), type, text });
}
function sendStats() { send('bot:stats', { ...stats }); }
function setStatus(state, channel = '') { send('bot:status', { state, channel }); }

// ---------- Настройки ----------
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS }; // файла нет или он повреждён — берём значения по умолчанию
  }
}

function saveSettings(s) {
  try {
    const clean = {
      token: String(s?.token ?? '').trim(),
      nick: String(s?.nick ?? '').trim(),
      channel: String(s?.channel ?? '').trim().replace(/^#/, ''),
      timeout: Boolean(s?.timeout),
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(clean, null, 2), 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- Список слов ----------
function ensureWordsFile() {
  fs.mkdirSync(path.dirname(wordsPath), { recursive: true });
  if (!fs.existsSync(wordsPath)) {
    // В собранном приложении копируем шаблон из python/, иначе создаём пустой
    if (defaultWordsPath !== wordsPath && fs.existsSync(defaultWordsPath)) {
      fs.copyFileSync(defaultWordsPath, wordsPath);
    } else {
      fs.writeFileSync(wordsPath, '', 'utf-8');
    }
  }
}

function loadWords() {
  ensureWordsFile();
  const text = fs.readFileSync(wordsPath, 'utf-8').replace(/^\uFEFF/, '');
  const seen = new Set();
  const words = [];
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim();
    if (w && !seen.has(w)) { seen.add(w); words.push(w); }
  }
  return words;
}

function saveWords(words) {
  try {
    const list = [...new Set((Array.isArray(words) ? words : [])
      .map((w) => String(w).trim()).filter(Boolean))];
    fs.mkdirSync(path.dirname(wordsPath), { recursive: true });
    fs.writeFileSync(wordsPath, list.length ? list.join('\n') + '\n' : '', 'utf-8');
    return { ok: true, count: list.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- Разбор строк лога бота ----------
// Бот пишет: "2026-10-16 23:41:07 | INFO | текст"
const LINE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \| (DEBUG|INFO|WARNING|ERROR|CRITICAL) \| (.*)$/;

function handleLine(rawLine, fromStderr) {
  const line = rawLine.replace(/\r$/, '');
  if (!line.trim()) return;

  const m = LINE_RE.exec(line);
  let time = nowTime();
  let level = fromStderr ? 'ERROR' : 'INFO';
  let message = line;
  if (m) { time = m[2]; level = m[3]; message = m[4]; }

  // Определяем тип строки (от него зависит цвет). Проверяем НАЧАЛО сообщения,
  // чтобы слово «УДАЛЕНО» в тексте чата не ломало счётчики.
  let type = 'info';
  if (message.startsWith('УДАЛЕНО')) type = 'del';
  else if (message.startsWith('ТАЙМАУТ')) type = 'timeout';
  else if (level === 'ERROR' || level === 'CRITICAL') type = 'error';
  else if (level === 'WARNING') type = 'warn';
  else if (!m && fromStderr) type = 'error';

  // Для обычных строк показываем уровень, для УДАЛЕНО/ТАЙМАУТ — само сообщение
  const text = m && type !== 'del' && type !== 'timeout' ? `${level} | ${message}` : message;
  pushLog(type, text, time);

  if (type === 'del') { stats.deleted++; sendStats(); }
  if (type === 'timeout') { stats.timeouts++; sendStats(); }

  // Бот пишет «Бот <ник> подключён к чату #канал» — значит, всё работает
  if (message.includes('подключён к чату')) {
    const ch = /#([\w]+)/.exec(message);
    setStatus('running', ch ? ch[1] : '');
  }

  // Типичная проблема — не установлен twitchio
  if (!hintShown && /ModuleNotFoundError|No module named/.test(line)) {
    hintShown = true;
    pushLog('error', 'Не установлены зависимости Python. Выполните в папке приложения: pip install -r python/requirements.txt');
  }
}

// Читает поток по строкам (данные приходят кусками, строка может разорваться)
function pipeLines(stream, fromStderr) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const parts = buf.split(/\n/);
    buf = parts.pop();
    parts.forEach((l) => handleLine(l, fromStderr));
  });
  stream.on('end', () => { if (buf) handleLine(buf, fromStderr); });
}

// ---------- Запуск Python ----------
// Пробуем команды по очереди: если первая не найдена (ENOENT) — берём следующую
function spawnPython(candidates, env) {
  return new Promise((resolve) => {
    const [cmd, ...rest] = candidates;
    const child = spawn(cmd, ['-u', botPath], { cwd: dataDir, env, windowsHide: true });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (err.code === 'ENOENT' && rest.length) resolve(spawnPython(rest, env));
      else resolve({ child: null, error: err });
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      resolve({ child });
    });
  });
}

async function startBot(s) {
  if (botProc || starting) return { ok: false, error: 'Бот уже запущен' };

  const token = String(s?.token ?? '').trim();
  const nick = String(s?.nick ?? '').trim().toLowerCase();
  const channel = String(s?.channel ?? '').trim().replace(/^#/, '').toLowerCase();
  if (!token || !nick || !channel) {
    const error = 'Заполните токен, ник бота и канал';
    pushLog('error', error);
    return { ok: false, error };
  }

  starting = true;
  saveSettings(s);
  ensureWordsFile();
  hintShown = false;
  stats = { deleted: 0, timeouts: 0, startedAt: null };
  sendStats();
  setStatus('starting', channel);

  // Настройки отдаём боту через переменные окружения (бот читает их сам)
  const env = {
    ...process.env,
    TWITCH_TOKEN: token,
    TWITCH_NICK: nick,
    TWITCH_CHANNEL: channel,
    BANNED_WORDS_FILE: wordsPath,
    TIMEOUT_SECONDS: s.timeout ? '10' : '0',
    PYTHONUNBUFFERED: '1',       // без этого логи приходят с задержкой
    PYTHONIOENCODING: 'utf-8',   // кириллица в потоках
  };
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  const { child, error } = await spawnPython(candidates, env);
  starting = false;

  if (!child) {
    setStatus('stopped');
    pushLog('error', error.code === 'ENOENT'
      ? 'Python не найден. Установите Python 3.12 с python.org (отметьте «Add Python to PATH») и запустите приложение снова.'
      : `Не удалось запустить Python: ${error.message}`);
    return { ok: false, error: 'Python не найден' };
  }

  botProc = child;
  stopping = false;
  stats.startedAt = Date.now();
  sendStats();
  pushLog('info', `Запуск бота (канал #${channel})...`);

  // Логи бота идут через logging в stderr, обычный print — в stdout: читаем оба потока
  pipeLines(child.stdout, false);
  pipeLines(child.stderr, true);

  child.on('error', (e) => pushLog('error', `Ошибка процесса: ${e.message}`));
  child.on('close', (code) => {
    if (botProc !== child) return;
    botProc = null;
    const byUser = stopping;
    stopping = false;
    if (byUser) {
      pushLog('info', 'Бот остановлен');
    } else if (process.platform === 'win32' && code === 9009) {
      pushLog('error', 'Python не найден (это заглушка Microsoft Store). Установите Python 3.12 с python.org.');
    } else {
      pushLog(code === 0 ? 'info' : 'error', `Бот завершил работу (код ${code})`);
    }
    stats.startedAt = null;
    sendStats();
    setStatus('stopped');
  });

  return { ok: true };
}

// Убиваем процесс вместе с потомками (на Windows py.exe запускает python.exe отдельно)
function killTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      .on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

function stopBot() {
  return new Promise((resolve) => {
    if (!botProc) return resolve({ ok: true });
    stopping = true;
    const child = botProc;
    child.once('close', () => resolve({ ok: true }));
    setTimeout(() => resolve({ ok: true }), 4000); // страховка
    killTree(child);
  });
}

// ---------- IPC ----------
ipcMain.handle('bot:start', (_e, settings) => startBot(settings));
ipcMain.handle('bot:stop', () => stopBot());
ipcMain.handle('settings:save', (_e, settings) => saveSettings(settings));
ipcMain.handle('settings:load', () => loadSettings());
ipcMain.handle('words:load', () => loadWords());
ipcMain.handle('words:save', (_e, words) => saveWords(words));

// ---------- Окно ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0f0f10', // чтобы не мигало белым при загрузке
    title: 'Wanty Moderator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
  // F12 — консоль разработчика (для отладки)
win.webContents.on('before-input-event', (_e, input) => {
  if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
});
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // убираем стандартное меню
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// При выходе обязательно гасим бота, чтобы он не остался висеть в фоне
app.on('before-quit', () => {
  if (botProc) { stopping = true; killTree(botProc); }
});
app.on('window-all-closed', () => app.quit());