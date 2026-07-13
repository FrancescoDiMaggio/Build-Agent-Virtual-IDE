'use strict';

// Bridge sicuro (contextIsolation) tra il main process e l'HUD.
// L'unica cosa esposta è un callback per ricevere gli aggiornamenti di memoria.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  onMem: (callback) => ipcRenderer.on('mem', (_event, data) => callback(data)),
  // Comandi per la playlist chiptune ospitata nell'HUD.
  onPlaylist: (callback) => ipcRenderer.on('playlist', (_event, data) => callback(data)),
  // L'HUD è click-through: lo rende interattivo solo mentre il cursore è
  // sopra i controlli audio, così i clic altrove passano comunque all'IDE.
  setInteractive: (flag) => ipcRenderer.send('hud:interactive', !!flag)
});
