'use strict';

// Bridge sicuro per la schermata iniziale (landing). contextIsolation attivo:
// l'unica superficie esposta è leggere i valori correnti e avviare la sessione.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherApi', {
  get: () => ipcRenderer.invoke('launcher:get'),
  start: (cfg) => ipcRenderer.invoke('launcher:start', cfg)
});
