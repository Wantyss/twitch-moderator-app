# Wanty Moderator

Десктопное приложение (Electron) для управления Twitch-ботом-модератором.
Бот на Python удаляет сообщения с запрещёнными словами и выдаёт таймаут.

## Требования
- Node.js 20+
- Python 3.12

## Запуск
```bash
pip install -r python/requirements.txt
npm install
npm start
```

## Сборка установщика (Windows)
```bash
npm run dist
```

## Настройка
В приложении укажи OAuth-токен бота, ник бота и канал.
Токен получают с правами `chat:read chat:edit moderator:manage:chat_messages moderator:manage:banned_users`.