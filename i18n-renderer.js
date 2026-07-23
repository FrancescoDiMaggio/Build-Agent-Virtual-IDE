'use strict';

// ============================================================
//  i18n · lato pagina
// ============================================================
// Gira nel renderer, non nel preload: i preload sono in sandbox e non possono
// caricare moduli locali (`require('./…')` fallisce). Il preload si limita
// quindi a esporre il catalogo ricevuto dal main via window.i18nBridge, e la
// traduzione del DOM avviene qui.
//
// Nel markup i testi si marcano con attributi:
//   data-i18n="chiave"              → textContent
//   data-i18n-placeholder="chiave"  → attributo placeholder
//   data-i18n-title="chiave"        → attributo title (tooltip)
//
// Va incluso a fine <body>, prima dello script della pagina: così il DOM è
// già completo (apply() traduce subito, senza lampeggio) e window.i18n esiste
// quando lo script della pagina lo usa.

(function () {
  let lang = window.i18nBridge.initial.lang;
  let strings = window.i18nBridge.initial.strings;

  // Chiamati al cambio lingua per i testi che la pagina costruisce a runtime
  // e che apply() non può ritradurre da solo (es. un errore già a schermo).
  const listeners = [];

  // Sostituisce i segnaposto {nome}. Un segnaposto senza valore resta com'è,
  // così un errore di chiave è visibile invece di sparire silenziosamente.
  function format(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, function (match, key) {
      return vars && key in vars ? String(vars[key]) : match;
    });
  }

  function t(key, vars) {
    const value = strings[key];
    return value === undefined ? key : format(value, vars);
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.dataset.i18n);
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    scope.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = t(el.dataset.i18nTitle);
    });
  }

  window.i18n = {
    t: t,
    apply: function (root) { apply(root); },
    getLang: function () { return lang; },
    onChange: function (callback) { listeners.push(callback); }
  };

  document.documentElement.lang = lang;
  apply();

  // Cambio lingua a runtime (dalle Impostazioni o dal selettore della landing):
  // ritraduce in place, senza ricaricare la pagina — così l'audio non si
  // interrompe e i valori già digitati nei campi restano dove sono.
  window.i18nBridge.onChange(function (payload) {
    lang = payload.lang;
    strings = payload.strings;
    document.documentElement.lang = lang;
    apply();
    listeners.forEach(function (fn) { fn(lang); });
  });
}());
