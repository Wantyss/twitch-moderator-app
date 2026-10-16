

import asyncio
import logging
import os
import re
import sys
from pathlib import Path

import aiohttp
from dotenv import load_dotenv
from twitchio.errors import AuthenticationError
from twitchio.ext import commands

# ======================= НАСТРОЙКИ =======================
load_dotenv()  # читаем .env рядом с bot.py

TOKEN = os.getenv("TWITCH_TOKEN", "").strip()
if TOKEN.lower().startswith("oauth:"):  # префикс oauth: не нужен
    TOKEN = TOKEN[6:]
NICK = os.getenv("TWITCH_NICK", "").strip().lower()
CHANNEL = os.getenv("TWITCH_CHANNEL", "").strip().lstrip("#").lower()
BANNED_WORDS_FILE = Path(os.getenv("BANNED_WORDS_FILE", "banned_words.txt"))

try:
    # Длительность таймаута в секундах. 0 — таймаут выключен.
    TIMEOUT_SECONDS = int(os.getenv("TIMEOUT_SECONDS", "10"))
except ValueError:
    TIMEOUT_SECONDS = 10

MOD_LOG_FILE = "moderation.log"
HELIX = "https://api.twitch.tv/helix"
# =========================================================

# ---------- Логирование: и в консоль, и в файл ----------
try:
    sys.stdout.reconfigure(encoding="utf-8")  # чтобы кириллица не ломалась в консоли Windows
except Exception:
    pass

log = logging.getLogger("modbot")
log.setLevel(logging.INFO)
_fmt = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", "%Y-%m-%d %H:%M:%S")
_console = logging.StreamHandler()
_console.setFormatter(_fmt)
_file = logging.FileHandler(MOD_LOG_FILE, encoding="utf-8")
_file.setFormatter(_fmt)
log.addHandler(_console)
log.addHandler(_file)


def fail(text: str):
    """Показать понятную ошибку и завершить работу."""
    log.critical(text)
    sys.exit(1)


# ---------- Список запрещённых слов ----------
class WordFilter:
    """
    Хранит слова и проверяет текст.
    Правила записи слова в banned_words.txt:
      слово     — только целое слово
      слово*    — слово с любым окончанием (хуй* найдёт «хуйня»)
      *слово*   — подстрока в любом месте (найдёт и «похуй»)
    Регистр и буква ё/е не важны.
    """

    def __init__(self, path: Path):
        self.path = path
        self.words: list[str] = []
        self._patterns: list[tuple[str, re.Pattern]] = []
        self.load()

    @staticmethod
    def normalize(text: str) -> str:
        # нижний регистр, ё -> е, лишние пробелы убираем
        return " ".join(text.lower().replace("ё", "е").split())

    @staticmethod
    def _build(word: str):
        starts_any = word.startswith("*")
        ends_any = word.endswith("*")
        core = word.strip("*")
        if not core:
            return None
        pattern = re.escape(core)
        # Границы слова ставим, только если край слова — буква/цифра
        if not starts_any and re.match(r"\w", core[0]):
            pattern = r"(?<!\w)" + pattern
        if not ends_any and re.match(r"\w", core[-1]):
            pattern = pattern + r"(?!\w)"
        return re.compile(pattern)

    def _compile(self):
        self._patterns = []
        for w in self.words:
            p = self._build(w)
            if p:
                self._patterns.append((w, p))

    def load(self) -> int:
        """Читает файл. Если файла нет — создаёт пустой."""
        if not self.path.exists():
            self.path.write_text("", encoding="utf-8")
            log.warning("Файл слов %s не найден — создан пустой.", self.path)
        words: list[str] = []
        for line in self.path.read_text(encoding="utf-8-sig").splitlines():
            w = self.normalize(line)
            if w and w not in words:
                words.append(w)
        self.words = words
        self._compile()
        return len(words)

    def save(self):
        self.path.write_text("\n".join(self.words) + ("\n" if self.words else ""), encoding="utf-8")

    def add(self, word: str) -> bool:
        w = self.normalize(word)
        if not w.strip("*") or w in self.words:
            return False
        self.words.append(w)
        self._compile()
        self.save()
        return True

    def remove(self, word: str) -> bool:
        w = self.normalize(word)
        if w not in self.words:
            return False
        self.words.remove(w)
        self._compile()
        self.save()
        return True

    def find(self, text: str):
        """Возвращает сработавшее слово из списка или None."""
        t = self.normalize(text)
        for word, pattern in self._patterns:
            if pattern.search(t):
                return word
        return None


# ---------- Проверка токена и канала ДО подключения ----------
async def prepare() -> dict:
    """Проверяет токен, права (scopes) и находит ID канала."""
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("https://id.twitch.tv/oauth2/validate",
                             headers={"Authorization": f"OAuth {TOKEN}"}) as r:
                if r.status == 401:
                    fail("Токен неверный или истёк. Получите новый OAuth-токен (см. README.md) "
                         "и вставьте его в TWITCH_TOKEN.")
                if r.status != 200:
                    fail(f"Не удалось проверить токен: HTTP {r.status}")
                data = await r.json()

            scopes = set(data.get("scopes", []))
            need = {"chat:read", "chat:edit", "moderator:manage:chat_messages"}
            lacking = need - scopes
            if lacking:
                fail("У токена не хватает прав: " + ", ".join(sorted(lacking)) +
                     ". Получите токен заново с этими scopes (см. README.md).")

            can_timeout = "moderator:manage:banned_users" in scopes
            if TIMEOUT_SECONDS > 0 and not can_timeout:
                log.warning("У токена нет права moderator:manage:banned_users — "
                            "таймауты работать не будут (сообщения всё равно удаляются).")

            if data.get("login", "").lower() != NICK:
                log.warning("Токен выдан аккаунту «%s», а в TWITCH_NICK указан «%s». "
                            "Проверьте настройки.", data.get("login"), NICK)

            if data.get("expires_in", 10**9) < 86400:
                log.warning("Токен скоро истечёт (меньше суток).")

            headers = {"Authorization": f"Bearer {TOKEN}", "Client-Id": data["client_id"]}
            async with s.get(f"{HELIX}/users", params={"login": CHANNEL}, headers=headers) as r:
                if r.status != 200:
                    fail(f"Не удалось получить данные канала: HTTP {r.status}")
                users = (await r.json()).get("data", [])
            if not users:
                fail(f"Канал «{CHANNEL}» не найден. Проверьте TWITCH_CHANNEL.")

            return {
                "client_id": data["client_id"],
                "bot_id": data["user_id"],
                "broadcaster_id": users[0]["id"],
                "can_timeout": can_timeout,
            }
    except aiohttp.ClientError as e:
        fail(f"Нет связи с Twitch: {e}")


# ---------- Сам бот ----------
class ModBot(commands.Bot):
    def __init__(self, info: dict):
        super().__init__(token=TOKEN, prefix="!", initial_channels=[CHANNEL])
        self.wf = WordFilter(BANNED_WORDS_FILE)
        self.client_id = info["client_id"]
        self.bot_id = info["bot_id"]
        self.broadcaster_id = info["broadcaster_id"]
        self.can_timeout = info["can_timeout"] and TIMEOUT_SECONDS > 0
        self.web: aiohttp.ClientSession | None = None
        self._warned_no_mod = False

    # --- вспомогательное: запрос к Helix API ---
    async def helix(self, method: str, path: str, **kwargs):
        headers = {"Authorization": f"Bearer {TOKEN}", "Client-Id": self.client_id}
        try:
            async with self.web.request(method, f"{HELIX}/{path}", headers=headers, **kwargs) as r:
                return r.status, await r.text()
        except aiohttp.ClientError as e:
            return 0, str(e)

    def api_problem(self, status: int, text: str, action: str):
        """Понятное сообщение об ошибке API."""
        if status == 401:
            log.error("Токен недействителен или истёк (%s). Получите новый токен.", action)
        elif status == 403:
            if not self._warned_no_mod:  # предупреждаем один раз, чтобы не спамить
                self._warned_no_mod = True
                log.warning("Бот НЕ модератор канала #%s (или у токена нет нужных прав). "
                            "Выдайте права командой в чате стримера: /mod %s", CHANNEL, NICK)
        else:
            log.warning("Не удалось выполнить «%s»: HTTP %s %s", action, status, text[:200])

    async def check_moderator_rights(self):
        """
        Пробный запрос: удаляем несуществующее сообщение.
        403 = бот не модератор; любой другой ответ = права есть.
        """
        status, text = await self.helix(
            "DELETE", "moderation/chat",
            params={"broadcaster_id": self.broadcaster_id, "moderator_id": self.bot_id,
                    "message_id": "00000000-0000-0000-0000-000000000000"})
        if status in (401, 403):
            self.api_problem(status, text, "проверка прав модератора")
        else:
            log.info("Права модератора в #%s подтверждены.", CHANNEL)

    async def delete_message(self, message_id: str) -> bool:
        status, text = await self.helix(
            "DELETE", "moderation/chat",
            params={"broadcaster_id": self.broadcaster_id, "moderator_id": self.bot_id,
                    "message_id": message_id})
        if status == 204:
            return True
        self.api_problem(status, text, "удаление сообщения")
        return False

    async def timeout_user(self, user_id: str, reason: str) -> bool:
        status, text = await self.helix(
            "POST", "moderation/bans",
            params={"broadcaster_id": self.broadcaster_id, "moderator_id": self.bot_id},
            json={"data": {"user_id": user_id, "duration": TIMEOUT_SECONDS, "reason": reason}})
        if status == 200:
            return True
        self.api_problem(status, text, "таймаут")
        return False

    # --- события ---
    async def event_ready(self):
        self.web = aiohttp.ClientSession()
        log.info("Бот %s подключён к чату #%s", NICK, CHANNEL)
        log.info("Загружено запрещённых слов: %d", len(self.wf.words))
        await self.check_moderator_rights()

    async def close(self):
        if self.web and not self.web.closed:
            await self.web.close()
        await super().close()

    async def event_message(self, message):
        # Свои сообщения и служебные — пропускаем
        if message.echo or message.author is None:
            return

        author = message.author
        # Модераторов и стримера не трогаем
        if not (author.is_mod or author.is_broadcaster):
            word = self.wf.find(message.content or "")
            if word:
                await self.punish(message, word)
                return  # сообщение удалено — команды из него не обрабатываем

        await self.handle_commands(message)

    async def punish(self, message, word: str):
        author = message.author.name
        text = (message.content or "").replace("\n", " ")
        if await self.delete_message(message.id):
            # Строка попадает и в консоль, и в moderation.log
            log.info('УДАЛЕНО | %s | "%s" | сработало слово: %s', author, text, word)
            if self.can_timeout:
                if await self.timeout_user(message.author.id, f"Запрещённое слово: {word}"):
                    log.info("ТАЙМАУТ %d сек | %s", TIMEOUT_SECONDS, author)
        else:
            log.warning('НЕ УДАЛОСЬ удалить | %s | "%s" | слово: %s', author, text, word)

    async def event_command_error(self, ctx, error):
        if isinstance(error, commands.CommandNotFound):
            return
        log.error("Ошибка команды: %s", error)

    # --- команды (только для модераторов и стримера) ---
    @staticmethod
    def _is_mod(ctx) -> bool:
        return ctx.author.is_mod or ctx.author.is_broadcaster

    @commands.command(name="addword")
    async def addword(self, ctx: commands.Context, *, word: str = None):
        if not self._is_mod(ctx):
            return
        if not word:
            await ctx.send("Использование: !addword <слово>")
        elif self.wf.add(word):
            log.info("Слово добавлено модератором %s. Всего: %d", ctx.author.name, len(self.wf.words))
            await ctx.send(f"@{ctx.author.name} слово добавлено. Всего слов: {len(self.wf.words)}")
        else:
            await ctx.send(f"@{ctx.author.name} такое слово уже есть (или оно пустое).")

    @commands.command(name="delword")
    async def delword(self, ctx: commands.Context, *, word: str = None):
        if not self._is_mod(ctx):
            return
        if not word:
            await ctx.send("Использование: !delword <слово>")
        elif self.wf.remove(word):
            log.info("Слово удалено модератором %s. Всего: %d", ctx.author.name, len(self.wf.words))
            await ctx.send(f"@{ctx.author.name} слово удалено. Всего слов: {len(self.wf.words)}")
        else:
            await ctx.send(f"@{ctx.author.name} такого слова нет в списке.")

    @commands.command(name="listwords")
    async def listwords(self, ctx: commands.Context):
        if not self._is_mod(ctx):
            return
        if not self.wf.words:
            await ctx.send("Список запрещённых слов пуст.")
            return
        # Лимит сообщения в Twitch — 500 символов, поэтому режем на части
        chunks, cur = [], ""
        for w in self.wf.words:
            if len(cur) + len(w) + 2 > 400:
                chunks.append(cur)
                cur = ""
            cur += (", " if cur else "") + w
        chunks.append(cur)
        for part in chunks[:3]:
            await ctx.send(part)
        if len(chunks) > 3:
            await ctx.send("...список слишком длинный, остальное смотрите в файле.")

    @commands.command(name="reload")
    async def reload(self, ctx: commands.Context):
        if not self._is_mod(ctx):
            return
        count = self.wf.load()
        log.info("Список слов перечитан модератором %s: %d", ctx.author.name, count)
        await ctx.send(f"@{ctx.author.name} список перечитан. Слов: {count}")


def main():
    missing = [n for n, v in (("TWITCH_TOKEN", TOKEN), ("TWITCH_NICK", NICK),
                              ("TWITCH_CHANNEL", CHANNEL)) if not v]
    if missing:
        fail("Не заполнены переменные: " + ", ".join(missing) + ". Проверьте файл .env")

    # Свой event loop — так надёжно работает и на Python 3.12
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    info = loop.run_until_complete(prepare())

    bot = ModBot(info)
    try:
        bot.run()
    except AuthenticationError:
        fail("Twitch отклонил токен при подключении к чату. Получите новый токен (см. README.md).")


if __name__ == "__main__":
    main()