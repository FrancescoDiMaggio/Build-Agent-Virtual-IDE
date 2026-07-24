'use strict';

// ============================================================
//  i18n · catalogo stringhe condiviso (main process + preload)
// ============================================================
// I cataloghi sono JSON piatti chiave → testo, con segnaposto {nome}.
// L'inglese fa da fallback: se una chiave manca in una lingua si usa la
// versione inglese invece di mostrare la chiave grezza all'utente.

const CATALOGS = {
  en: require('./i18n/en.json'),
  it: require('./i18n/it.json'),
  fr: require('./i18n/fr.json'),
  es: require('./i18n/es.json')
};

const FALLBACK = 'en';
const SUPPORTED = Object.keys(CATALOGS);

// Nomi mostrati nel selettore, ciascuno nella propria lingua.
const LANGUAGE_NAMES = {
  en: 'English',
  it: 'Italiano',
  fr: 'Français',
  es: 'Español'
};

// Lingua attiva del processo. Il main la fissa all'avvio (vedi resolve).
let current = FALLBACK;

// 'it-IT', 'it_IT', 'IT' → 'it'. Ritorna null se la lingua non è tradotta.
function normalize(tag) {
  const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.includes(base) ? base : null;
}

// Decide la lingua effettiva: la preferenza esplicita dell'utente vince,
// 'auto' (o valore ignoto) ricade sulla lingua di sistema, poi sull'inglese.
function resolve(preference, systemLocale) {
  if (preference && preference !== 'auto') {
    const explicit = normalize(preference);
    if (explicit) return explicit;
  }
  return normalize(systemLocale) || FALLBACK;
}

function setLanguage(lang) {
  current = SUPPORTED.includes(lang) ? lang : FALLBACK;
  return current;
}

function getLanguage() {
  return current;
}

// Catalogo completo di una lingua, con i buchi tappati dall'inglese.
// È ciò che viene passato ai renderer (che non leggono il filesystem).
function strings(lang) {
  return { ...CATALOGS[FALLBACK], ...(CATALOGS[lang || current] || {}) };
}

// Sostituisce i segnaposto {nome}. Un segnaposto senza valore resta com'è,
// così un errore di chiave è visibile invece di sparire silenziosamente.
function format(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    vars && key in vars ? String(vars[key]) : match
  ));
}

// Traduce nella lingua attiva del processo.
function t(key, vars) {
  const value = CATALOGS[current][key] !== undefined
    ? CATALOGS[current][key]
    : CATALOGS[FALLBACK][key];
  return value === undefined ? key : format(value, vars);
}

// Elenco per il selettore di lingua: 'auto' + le lingue tradotte.
// L'etichetta di 'auto' è tradotta dal chiamante (chiave settings.languageAuto).
function options() {
  return SUPPORTED.map((code) => ({ code, name: LANGUAGE_NAMES[code] }));
}

module.exports = {
  FALLBACK,
  SUPPORTED,
  LANGUAGE_NAMES,
  normalize,
  resolve,
  setLanguage,
  getLanguage,
  strings,
  format,
  options,
  t
};
