'use strict';

// Bridge sicuro per la schermata iniziale (landing). contextIsolation attivo:
// l'unica superficie esposta è leggere i valori correnti e avviare la sessione.
const { contextBridge, ipcRenderer } = require('electron');

// Catalogo delle stringhe per la pagina (lo consuma i18n-renderer.js).
// Sincrono perché deve essere disponibile prima del primo paint.
contextBridge.exposeInMainWorld('i18nBridge', {
  initial: ipcRenderer.sendSync('i18n:sync'),
  onChange: (callback) => ipcRenderer.on('i18n:changed', (_event, payload) => callback(payload))
});

contextBridge.exposeInMainWorld('launcherApi', {
  get: () => ipcRenderer.invoke('launcher:get'),
  start: (cfg) => ipcRenderer.invoke('launcher:start', cfg),
  // Il selettore di lingua della landing: applica e persiste la scelta.
  setLanguage: (lang) => ipcRenderer.invoke('i18n:set', lang)
});
