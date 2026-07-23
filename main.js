'use strict';

const { app, BrowserWindow, shell, Menu, dialog, Notification, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const i18n = require('./i18n');
const t = i18n.t;

// ============================================================
//  DEFAULT (usati solo per generare config.json al primo avvio)
// ============================================================
const DEFAULTS = {
  // URL da aprire. Vuoto di default: l'app non è legata a una specifica
  // istanza, lo si imposta dalla schermata iniziale (landing) al primo avvio
  // o, in seguito, da File ▸ Impostazioni / config.json.
  url: '',
  // Tetto dell'heap V8 (JS) per il renderer, in MB. È il limite oltre il
  // quale Chrome farebbe "Aw Snap". Hai 16 GB di RAM: 8192 è il massimo
  // sensato; non superare ~12288.
  maxOldSpaceSize: 8192,
  // Soglie del semaforo (HUD), come frazione del tetto RAM:
  //   < warnPct → 🟢 verde · warnPct–alertPct → 🟡 giallo · ≥ alertPct → 🔴 rosso
  warnPct: 0.60,
  alertPct: 0.85,
  // Se true, la playlist chiptune parte automaticamente durante l'uso.
  playlist: false,
  // Lingua dell'interfaccia: 'auto' segue la lingua di sistema, altrimenti
  // uno dei codici tradotti (vedi i18n.js: en, it, fr, es).
  language: 'auto'
};
// ============================================================

// --- #1: configurazione esterna editabile ------------------
// Il file vive nella cartella dati utente (scrivibile e persistente tra
// gli aggiornamenti), NON dentro l'app pacchettizzata che è in sola lettura.
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  let cfg = { ...DEFAULTS };
  try {
    if (fs.existsSync(configPath)) {
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg = { ...cfg, ...onDisk };
    } else {
      // Primo avvio: crea il file coi default così l'utente può modificarlo.
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2), 'utf8');
    }
  } catch (err) {
    // Config corrotto o illeggibile: prosegui coi default, non bloccare l'app.
    console.error('Config non valido, uso i default:', err.message);
  }

  // Le variabili d'ambiente, se presenti, hanno priorità (utile per test).
  if (process.env.TARGET_URL) cfg.url = process.env.TARGET_URL;
  if (process.env.MAX_OLD_SPACE_SIZE) {
    cfg.maxOldSpaceSize = Number(process.env.MAX_OLD_SPACE_SIZE) || cfg.maxOldSpaceSize;
  }
  return cfg;
}

const config = loadConfig();

// Persiste l'oggetto config sul disco (config.json nella cartella utente).
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// Alza il limite dell'heap V8 PRIMA che l'app sia pronta.
app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${config.maxOldSpaceSize}`);

// Permette la riproduzione audio automatica (cracktro del launcher + playlist)
// senza richiedere un gesto dell'utente.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// --- audio: cracktro del launcher + playlist chiptune ------
// I file vivono in assets/. Esposti ai renderer come URL file:// (i renderer
// hanno contextIsolation e non possono leggere il filesystem da soli).
const ASSETS_DIR = path.join(__dirname, 'assets');
function toFileUrl(p) { return pathToFileURL(p).toString(); }
const LOGIN_SOUND = toFileUrl(path.join(ASSETS_DIR, 'login.mp3'));

function listPlaylist() {
  try {
    return fs.readdirSync(path.join(ASSETS_DIR, 'playlist'))
      .filter((f) => /\.mp3$/i.test(f))
      .sort()
      .map((f) => ({
        name: f.replace(/\.mp3$/i, ''),
        url: toFileUrl(path.join(ASSETS_DIR, 'playlist', f))
      }));
  } catch (_) {
    return [];
  }
}
const PLAYLIST = listPlaylist();

// Valore di RAM EFFETTIVAMENTE applicato al flag V8 di questo processo.
// Se l'utente sceglie un valore diverso dalla landing, serve un riavvio del
// processo perché il flag non è modificabile a runtime.
const APPLIED_MAX_OLD_SPACE = config.maxOldSpaceSize;

// Se presente, salta la landing e va dritto alla finestra regolare: usato dopo
// un riavvio innescato dal cambio di RAM, così non si ripresenta la schermata.
const AUTO_START = process.argv.includes('--autostart');

let mainWindow = null;
let hudWindow = null;
let settingsWindow = null;
let launcherWindow = null;
// True una volta che la sessione è stata avviata (finestra regolare aperta).
let started = false;
// Se la playlist deve suonare durante l'uso (scelta dalla landing / menu).
let playlistEnabled = !!config.playlist;
// L'HUD è click-through di default (non blocca l'IDE sottostante). Si rende
// interattivo solo su richiesta esplicita dal menu, per usare i controlli audio.
let hudInteractive = false;

// Attiva/disattiva la cattura del mouse dell'HUD. Quando spento (default) i
// clic attraversano l'HUD e arrivano all'IDE; quando acceso i controlli
// dell'HUD sono cliccabili ma l'HUD copre l'area sottostante.
function setHudInteractive(flag) {
  hudInteractive = !!flag;
  if (!hudWindow || hudWindow.isDestroyed()) return;
  if (hudInteractive) {
    hudWindow.setIgnoreMouseEvents(false);
  } else {
    hudWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

// Invia un comando al player audio ospitato nell'HUD.
// action: 'play' | 'pause' | 'toggle' | 'next'
function sendPlaylist(action) {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudWindow.webContents.send('playlist', { action, tracks: PLAYLIST });
}

// --- #3: stato per la notifica con isteresi ----------------
// Notifichiamo UNA volta all'ingresso in "rosso" e non ri-notifichiamo
// finché la memoria non rientra sotto la soglia di "giallo".
let alertActive = false;

const HUD_W = 300;   // largo abbastanza per pillola memoria + controlli audio
const HUD_H = 46;
const HUD_MARGIN = 16;

// --- #2: stato per il recovery dai crash -------------------
// Contatore di crash ravvicinati: se la pagina continua a morire subito
// dopo il reload, smettiamo di ricaricare all'infinito e avvisiamo l'utente.
let recentCrashes = 0;
let crashResetTimer = null;
const MAX_AUTO_RELOADS = 3; // reload automatici entro la finestra temporale

function formatMB(kb) {
  return (kb / 1024).toFixed(0); // getAppMetrics riporta in KB
}

function startMemoryMonitor() {
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const metrics = app.getAppMetrics();
      let rendererKB = 0;
      let totalKB = 0;
      for (const m of metrics) {
        const workingSetKB = m.memory ? m.memory.workingSetSize : 0;
        totalKB += workingSetKB;
        if (m.type === 'Tab' || m.type === 'renderer') {
          rendererKB = Math.max(rendererKB, workingSetKB);
        }
      }

      const rendererMB = Number(formatMB(rendererKB));
      // Nota: rendererMB è la RSS del processo (proxy di pressione), non
      // l'heap V8 esatto — ma cresce insieme e va bene come semaforo.
      const pct = rendererMB / config.maxOldSpaceSize;
      const level = pct >= config.alertPct ? 'red'
                  : pct >= config.warnPct  ? 'yellow'
                  : 'green';

      mainWindow.setTitle(t('window.mainTitle', {
        mb: rendererMB,
        cap: config.maxOldSpaceSize,
        total: formatMB(totalKB)
      }));

      // #3: aggiorna l'HUD col semaforo.
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.webContents.send('mem', {
          mb: rendererMB,
          capMb: config.maxOldSpaceSize,
          pct,
          level
        });
      }

      // #3: notifica con isteresi — una volta sola all'ingresso in rosso,
      // riarmata solo quando si scende sotto il giallo.
      if (level === 'red' && !alertActive) {
        alertActive = true;
        if (Notification.isSupported()) {
          new Notification({
            title: t('notify.memory.title'),
            body: t('notify.memory.body', { mb: rendererMB, pct: Math.round(pct * 100) })
          }).show();
        }
      } else if (level === 'green') {
        alertActive = false;
      }
    } catch (_) {
      // getAppMetrics può fallire durante shutdown: ignora.
    }
  }, 2000);
}

// --- #3: finestra HUD trasparente, click-through, sempre sopra ---
function createHud() {
  hudWindow = new BrowserWindow({
    width: HUD_W,
    height: HUD_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload-hud.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  hudWindow.loadFile(path.join(__dirname, 'hud.html'));
  // Applica lo stato corrente: di default click-through verso l'IDE sottostante.
  setHudInteractive(hudInteractive);
  hudWindow.setVisibleOnAllWorkspaces(true);
  positionHud();

  // Quando l'HUD è pronto, avvia la playlist se l'utente l'ha richiesta.
  hudWindow.webContents.on('did-finish-load', () => {
    if (playlistEnabled && PLAYLIST.length) sendPlaylist('play');
  });

  hudWindow.on('closed', () => { hudWindow = null; });
}

// Ancora l'HUD in basso a destra dell'area della finestra principale.
function positionHud() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getBounds();
  hudWindow.setBounds({
    x: b.x + b.width - HUD_W - HUD_MARGIN,
    y: b.y + b.height - HUD_H - HUD_MARGIN,
    width: HUD_W,
    height: HUD_H
  });
}

// --- #2: aggancia il recovery a una finestra ---------------
function attachCrashRecovery(win) {
  win.webContents.on('render-process-gone', (_event, details) => {
    // details.reason: 'crashed' | 'oom' | 'killed' | ...
    console.error('Renderer terminato:', details.reason);
    if (win.isDestroyed()) return;

    recentCrashes += 1;

    // Azzera il contatore se per 60s non ci sono altri crash.
    if (crashResetTimer) clearTimeout(crashResetTimer);
    crashResetTimer = setTimeout(() => { recentCrashes = 0; }, 60000);

    if (recentCrashes <= MAX_AUTO_RELOADS) {
      // Recovery automatico: ricarica l'istanza invece di restare su schermo bianco.
      win.loadURL(config.url);
    } else {
      // Troppi crash ravvicinati: probabile leak o limite RAM insufficiente.
      // Smetti di ricaricare a vuoto e chiedi all'utente.
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: [t('crash.retry'), t('crash.quit')],
        defaultId: 0,
        cancelId: 1,
        title: t('crash.title'),
        message: t('crash.message'),
        detail: t('crash.detail', {
          reason: details.reason,
          cap: config.maxOldSpaceSize
        })
      });
      recentCrashes = 0;
      if (choice === 0) {
        win.loadURL(config.url);
      } else {
        app.quit();
      }
    }
  });

  // Se la pagina si blocca (non risponde), offri ricarica invece di attendere.
  win.webContents.on('unresponsive', () => {
    if (win.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: [t('unresponsive.wait'), t('unresponsive.reload')],
      defaultId: 0,
      cancelId: 0,
      title: t('unresponsive.title'),
      message: t('unresponsive.message'),
      detail: t('unresponsive.detail')
    });
    if (choice === 1 && !win.isDestroyed()) win.reload();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'ServiceNow IDE',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      partition: 'persist:servicenow',
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true
    }
  });

  attachCrashRecovery(mainWindow);
  mainWindow.loadURL(config.url);

  // #3: crea l'HUD e tienilo agganciato all'angolo della finestra.
  mainWindow.once('ready-to-show', createHud);
  mainWindow.on('move', positionHud);
  mainWindow.on('resize', positionHud);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.hostname.endsWith('service-now.com')) {
        return { action: 'allow' };
      }
    } catch (_) { /* fallthrough */ }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
    mainWindow = null;
  });
}

// --- #0: schermata iniziale (landing/launcher) -------------
// Si apre per prima: l'utente imposta URL, RAM e soglie e preme START.
function createLauncher() {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.focus();
    return;
  }
  launcherWindow = new BrowserWindow({
    width: 520,
    height: 600,
    resizable: false,
    maximizable: false,
    title: 'ServiceNow IDE',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload-launcher.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  launcherWindow.setMenuBarVisibility(false);
  launcherWindow.loadFile(path.join(__dirname, 'launcher.html'));
  launcherWindow.on('closed', () => { launcherWindow = null; });
}

// Valida i valori in ingresso dalla landing/impostazioni. Ritorna i valori
// normalizzati su {ok:true}, oppure {ok:false, error} con il motivo.
function validateIncoming(incoming) {
  const url = String(incoming.url || '').trim();
  const ram = Number(incoming.maxOldSpaceSize);
  const warnPct = Number(incoming.warnPct);
  const alertPct = Number(incoming.alertPct);

  if (!/^https?:\/\//i.test(url)) return { ok: false, error: t('error.url') };
  if (!(ram >= 1024 && ram <= 14336)) return { ok: false, error: t('error.ram') };
  if (!(warnPct > 0 && alertPct < 1 && warnPct < alertPct)) {
    return { ok: false, error: t('error.thresholds') };
  }
  return { ok: true, url, ram, warnPct, alertPct };
}

// --- #4: finestra Impostazioni (modale) --------------------
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 560,   // spazio anche per il selettore di lingua
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: t('window.settings'),
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// Riceve i valori dalla finestra, li valida, aggiorna config + disco e
// applica subito ciò che è possibile. Ritorna se serve un riavvio.
ipcMain.handle('settings:get', () => ({
  url: config.url,
  maxOldSpaceSize: config.maxOldSpaceSize,
  warnPct: config.warnPct,
  alertPct: config.alertPct,
  language: config.language || 'auto',
  languages: i18n.options()
}));

ipcMain.handle('settings:save', (_event, incoming) => {
  try {
    const v = validateIncoming(incoming);
    if (!v.ok) return v;

    const urlChanged = v.url !== config.url;
    // Confronto col valore davvero applicato al flag V8 di questo processo:
    // così "serve riavvio" è vero solo se la RAM differisce da quella attiva.
    const ramChanged = v.ram !== APPLIED_MAX_OLD_SPACE;

    config.url = v.url;
    config.maxOldSpaceSize = v.ram;   // applicato al prossimo avvio (flag V8)
    config.warnPct = v.warnPct;       // applicate subito dal monitor
    config.alertPct = v.alertPct;
    // Se il form non manda la lingua, non toccarla (altrimenti la si
    // riporterebbe a 'auto' a ogni salvataggio).
    const langChanged = incoming.language === undefined
      ? false
      : applyLanguage(incoming.language);
    saveConfig();

    // Lingua: si applica subito a menu e finestre, senza riavvio.
    if (langChanged) broadcastLanguage();

    // URL: ricarica subito la pagina sul nuovo indirizzo.
    if (urlChanged && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(config.url);
    }

    return { ok: true, restartNeeded: ramChanged };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- #0: la landing legge i valori correnti e fa partire la sessione -------
ipcMain.handle('launcher:get', () => ({
  url: config.url,
  maxOldSpaceSize: config.maxOldSpaceSize,
  warnPct: config.warnPct,
  alertPct: config.alertPct,
  playlist: !!config.playlist,
  loginSound: LOGIN_SOUND,        // cracktro suonato dalla landing
  hasPlaylist: PLAYLIST.length > 0,
  language: config.language || 'auto',
  languages: i18n.options()
}));

ipcMain.handle('launcher:start', (_event, incoming) => {
  try {
    const v = validateIncoming(incoming);
    if (!v.ok) return v;

    const ramChanged = v.ram !== APPLIED_MAX_OLD_SPACE;

    config.url = v.url;
    config.maxOldSpaceSize = v.ram;
    config.warnPct = v.warnPct;
    config.alertPct = v.alertPct;
    config.playlist = !!incoming.playlist;
    playlistEnabled = config.playlist;
    saveConfig();

    if (ramChanged) {
      // Il flag V8 è fissato a inizio processo: per applicare la nuova RAM
      // riavviamo l'app con --autostart, così riparte già sulla pagina senza
      // ripresentare la landing.
      const args = process.argv.slice(1).filter((a) => a !== '--autostart');
      args.push('--autostart');
      app.relaunch({ args });
      app.exit(0);
      return { ok: true };
    }

    // RAM invariata: apri direttamente la finestra regolare.
    started = true;
    buildMenu(); // riallinea la spunta "Playlist neon" alla scelta fatta qui
    createWindow();
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// L'HUD chiede di attivare/disattivare la cattura del mouse (vedi preload-hud).
ipcMain.on('hud:interactive', (_event, flag) => setHudInteractive(flag));

ipcMain.handle('settings:close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

// --- i18n --------------------------------------------------
// I renderer non leggono il filesystem: ricevono il catalogo dal main.
// Sincrono perché il preload lo richiede prima del primo paint.
ipcMain.on('i18n:sync', (event) => {
  event.returnValue = { lang: i18n.getLanguage(), strings: i18n.strings() };
});

// Ritraduce tutto ciò che è già a schermo: menu applicativo (ricostruito) e
// finestre aperte (che riapplicano le stringhe in place, senza ricaricarsi).
function broadcastLanguage() {
  const payload = { lang: i18n.getLanguage(), strings: i18n.strings() };
  buildMenu();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('i18n:changed', payload);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.setTitle(i18n.t('window.settings'));
  }
}

// Applica una preferenza di lingua ('auto' o un codice) e la persiste.
// Ritorna true se la lingua effettiva è cambiata.
function applyLanguage(preference) {
  const pref = preference === 'auto' || i18n.SUPPORTED.includes(preference)
    ? preference
    : 'auto';
  const before = i18n.getLanguage();
  config.language = pref;
  i18n.setLanguage(i18n.resolve(pref, app.getLocale()));
  return i18n.getLanguage() !== before;
}

ipcMain.handle('i18n:set', (_event, preference) => {
  const changed = applyLanguage(preference);
  saveConfig();
  if (changed) broadcastLanguage();
  return { ok: true, lang: i18n.getLanguage() };
});

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: t('menu.file'),
      submenu: [
        {
          // #4: finestra grafica per modificare i parametri.
          label: t('menu.settings'),
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettings()
        },
        { type: 'separator' },
        {
          // #1: apre il config.json grezzo nell'editor di sistema (avanzato).
          label: t('menu.openConfig'),
          click: () => { shell.openPath(configPath); }
        },
        {
          label: t('menu.showConfigFolder'),
          click: () => { shell.showItemInFolder(configPath); }
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: t('menu.hud'),
      submenu: [
        {
          // Di default l'HUD è click-through e non blocca l'IDE sottostante.
          // Attivalo solo quando vuoi usare i controlli audio dell'HUD.
          label: t('menu.hudInteractive'),
          type: 'checkbox',
          checked: hudInteractive,
          accelerator: 'CmdOrCtrl+Shift+H',
          click: (item) => setHudInteractive(item.checked)
        }
      ]
    },
    {
      label: t('menu.audio'),
      submenu: [
        {
          label: t('menu.playlist'),
          type: 'checkbox',
          checked: playlistEnabled,
          enabled: PLAYLIST.length > 0,
          click: (item) => {
            playlistEnabled = item.checked;
            config.playlist = playlistEnabled;
            saveConfig();
            sendPlaylist(playlistEnabled ? 'play' : 'pause');
          }
        },
        {
          label: t('menu.nextTrack'),
          accelerator: 'CmdOrCtrl+Right',
          enabled: PLAYLIST.length > 0,
          click: () => sendPlaylist('next')
        }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Cross-origin isolation per l'IDE (VS Code Web) --------
// L'IDE ServiceNow è basato su VS Code e, per far girare i suoi worker
// (es. workerMain.js, dove vive il "SDK 4 runtime" della build), ha bisogno
// di un contesto "cross-origin isolated": COOP + COEP. Sull'istanza questi
// header li inietta un service worker (gliderScriptsSecuritySW.js); dentro
// Electron quel meccanismo non copre la richiesta del worker, che viene
// bloccata da Chromium (CoepFrameResourceNeedsCoep) e fa fallire la build
// con il fuorviante "Failed to construct 'URL': Invalid URL".
// Impostiamo noi gli header a livello di sessione, così l'origin ServiceNow
// è davvero cross-origin isolated e il worker viene ammesso.
// Replichiamo esattamente ciò che il service worker di VS Code fa quando vede
// "?vscode-coi=3": COOP same-origin + COEP require-corp. Serve però anche CORP
// (Cross-Origin-Resource-Policy) su ogni risposta, altrimenti sotto require-corp
// le risorse — incluso workerMain.js — vengono bloccate con ERR_BLOCKED_BY_RESPONSE.
function enableCrossOriginIsolation() {
  const snSession = session.fromPartition('persist:servicenow');
  snSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
        'Cross-Origin-Resource-Policy': ['cross-origin']
      }
    });
  });
}

app.whenReady().then(() => {
  // La lingua di sistema è nota solo a app pronta, quindi si risolve qui —
  // prima di costruire il menu e di aprire qualsiasi finestra.
  i18n.setLanguage(i18n.resolve(config.language, app.getLocale()));

  enableCrossOriginIsolation();
  buildMenu();
  startMemoryMonitor(); // il monitor è inerte finché non esiste mainWindow

  if (AUTO_START) {
    // Riavvio dovuto al cambio di RAM: salta la landing.
    started = true;
    createWindow();
  } else {
    // Primo avvio (o avvio normale): mostra la schermata iniziale.
    createLauncher();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (started) createWindow();
      else createLauncher();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
