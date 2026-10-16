// renderer.js — логика интерфейса
// renderer.js — логика интерфейса
(() => {
const api = window.api;
const $ = (id) => document.getElementById(id);

const MAX_LOG_LINES = 1000; // чтобы лог не разрастался бесконечно

let words = [];
let botState = 'stopped';
let startedAt = null;
let saveTimer = null;
let noteTimer = null;

// ---------- Настройки ----------
function collectSettings() {
  return {
    token: $('token').value,
    nick: $('nick').value.trim(),
    channel: $('channel').value.trim().replace(/^#/, ''),
    timeout: $('timeout').checked,
  };
}

// Автосохранение при изменении (с небольшой задержкой, чтобы не писать на каждую букву)
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveSettings(collectSettings()), 400);
}

['token', 'nick', 'channel'].forEach((id) => $(id).addEventListener('input', scheduleSave));
$('timeout').addEventListener('change', scheduleSave);

$('btn-save').addEventListener('click', async () => {
  clearTimeout(saveTimer);
  const res = await api.saveSettings(collectSettings());
  const btn = $('btn-save');
  btn.textContent = res.ok ? 'Сохранено ✓' : 'Ошибка сохранения';
  setTimeout(() => { btn.textContent = 'Сохранить настройки'; }, 1500);
});

// Глазик: показать / скрыть токен
$('toggle-token').addEventListener('click', () => {
  const hidden = $('token').type === 'password';
  $('token').type = hidden ? 'text' : 'password';
  $('toggle-token').classList.toggle('shown', hidden);
});

// ---------- Запуск / остановка ----------
$('btn-start').addEventListener('click', () => api.startBot(collectSettings()));
$('btn-stop').addEventListener('click', () => api.stopBot());

function setStatus({ state, channel }) {
  botState = state;
  const dot = $('status-dot');
  dot.className = 'dot ' + state;
  $('status-text').textContent =
    state === 'running' ? `Подключён к #${channel}` :
    state === 'starting' ? 'Запускается...' : 'Бот остановлен';

  $('btn-start').disabled = state !== 'stopped';
  $('btn-stop').disabled = state === 'stopped';

  // При новом запуске бот сам читает свежий файл слов — подсказка не нужна
  if (state !== 'running') showNote('');
}

// ---------- Статистика ----------
function pad(n) { return String(n).padStart(2, '0'); }
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
function tickUptime() {
  $('stat-uptime').textContent = startedAt ? formatUptime(Date.now() - startedAt) : '00:00:00';
}
function updateStats(s) {
  $('stat-deleted').textContent = s.deleted;
  $('stat-timeouts').textContent = s.timeouts;
  startedAt = s.startedAt;
  tickUptime();
}

// ---------- Лог ----------
function appendLog({ time, type, text }) {
  const box = $('log-body');
  // Автопрокрутка только если пользователь и так внизу (не мешаем читать старое)
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;

  const div = document.createElement('div');
  div.className = 'line ' + type;
  div.textContent = `[${time}] ${text}`; // textContent — текст чата не исполняется как HTML
  box.appendChild(div);

  while (box.childElementCount > MAX_LOG_LINES) box.removeChild(box.firstChild);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

$('btn-clear').addEventListener('click', () => { $('log-body').textContent = ''; });

// ---------- Список слов ----------
function renderWords() {
  $('words-title').textContent = `Запрещённые слова (${words.length})`;
  const list = $('word-list');
  list.textContent = '';
  for (const w of words) {
    const li = document.createElement('li');
    li.className = 'word';
    const span = document.createElement('span');
    span.textContent = w;
    const btn = document.createElement('button');
    btn.className = 'remove';
    btn.textContent = '×';
    btn.title = 'Удалить';
    btn.dataset.word = w;
    li.append(span, btn);
    list.appendChild(li);
  }
}

// Короткое сообщение под списком; пустая строка — скрыть
function showNote(text, autoHideMs = 0) {
  const el = $('words-note');
  clearTimeout(noteTimer);
  el.textContent = text;
  el.classList.toggle('hidden', !text);
  if (text && autoHideMs) noteTimer = setTimeout(() => showNote(''), autoHideMs);
}

async function persistWords() {
  const res = await api.saveWords(words);
  if (!res.ok) { showNote('Не удалось сохранить: ' + res.error, 4000); return; }
  // Запущенный бот держит список в памяти и перечитывает его только по !reload
  if (botState === 'running') {
    showNote('Бот запущен: чтобы применить изменения, напишите !reload в чате или перезапустите бота.');
  }
}

async function addWord() {
  const input = $('word-input');
  const w = input.value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!w) return;
  if (words.includes(w)) { showNote('Такое слово уже есть в списке.', 3000); return; }
  words.push(w);
  input.value = '';
  renderWords();
  const list = $('word-list');
  list.scrollTop = list.scrollHeight; // показываем добавленное слово
  await persistWords();
}

$('btn-add').addEventListener('click', addWord);
$('word-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWord(); });

// Удаление по крестику (делегирование: один обработчик на весь список)
$('word-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.remove');
  if (!btn) return;
  words = words.filter((w) => w !== btn.dataset.word);
  renderWords();
  await persistWords();
});

// ---------- Старт ----------
(async function init() {
  const s = await api.loadSettings();
  $('token').value = s.token;
  $('nick').value = s.nick;
  $('channel').value = s.channel;
  $('timeout').checked = s.timeout;

  words = await api.loadWords();
  renderWords();

  api.onLog(appendLog);
  api.onStats(updateStats);
  api.onStatus(setStatus);

  setStatus({ state: 'stopped', channel: '' });
  setInterval(tickUptime, 1000);
})();
})();