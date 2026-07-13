'use strict';

// Bridge sicuro per la finestra Impostazioni (contextIsolation attivo).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (cfg) => ipcRenderer.invoke('settings:save', cfg),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  close: () => ipcRenderer.invoke('settings:close')
});
