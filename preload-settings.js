'use strict';

// Bridge sicuro per la finestra Impostazioni (contextIsolation attivo).
const { contextBridge, ipcRenderer } = require('electron');

// Catalogo delle stringhe per la pagina (lo consuma i18n-renderer.js).
// Sincrono perché deve essere disponibile prima del primo paint.
contextBridge.exposeInMainWorld('i18nBridge', {
  initial: ipcRenderer.sendSync('i18n:sync'),
  onChange: (callback) => ipcRenderer.on('i18n:changed', (_event, payload) => callback(payload))
});

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (cfg) => ipcRenderer.invoke('settings:save', cfg),
  // Applicata e persistita subito, senza passare dal salvataggio del form.
  setLanguage: (lang) => ipcRenderer.invoke('i18n:set', lang),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  close: () => ipcRenderer.invoke('settings:close')
});
