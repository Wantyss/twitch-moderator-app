// preload.js — безопасный мост между окном (renderer) и главным процессом
const { contextBridge, ipcRenderer } = require('electron');

// Подписка на событие; возвращает функцию отписки
function subscribe(channel, callback) {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  startBot: (settings) => ipcRenderer.invoke('bot:start', settings),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  loadWords: () => ipcRenderer.invoke('words:load'),
  saveWords: (words) => ipcRenderer.invoke('words:save', words),
  onLog: (callback) => subscribe('bot:log', callback),       // {time, type, text}
  onStats: (callback) => subscribe('bot:stats', callback),   // {deleted, timeouts, startedAt}
  onStatus: (callback) => subscribe('bot:status', callback), // {state, channel}
});