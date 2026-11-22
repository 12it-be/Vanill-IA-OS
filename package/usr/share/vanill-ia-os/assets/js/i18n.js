/**
 * ==============================================================================
 * Vanill-IA OS — Lightweight Vanilla ES6 Internationalization Engine (i18n.js)
 * - Default language: English ('en') across 100% of the WebOS
 * - Automatic fallback to 'en' when a translation key is missing
 * - Supports `t('key', { var: val })`, `data-i18n*` DOM attributes & live switch
 * ==============================================================================
 */

const SUPPORTED_LANGS = ['en', 'fr'];
const dictionaries = {
  en: {},
  fr: {},
};

let currentLang = 'en';
let initialized = false;

function getNestedValue(obj, path) {
  if (!obj) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) {
    return obj[path];
  }
  return path.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), obj);
}

async function fetchDictionary(lang) {
  try {
    const res = await fetch(`/assets/lang/${lang}.json`, { cache: 'no-cache' });
    if (res.ok) {
      dictionaries[lang] = await res.json();
    }
  } catch (_) {
    // Keep empty object fallback if offline before precache
  }
}

export async function initI18n(preferredLang = null) {
  await Promise.all([fetchDictionary('en'), fetchDictionary('fr')]);
  initialized = true;

  const savedLocal = localStorage.getItem('vanillia_lang');
  const initial = SUPPORTED_LANGS.includes(preferredLang)
    ? preferredLang
    : SUPPORTED_LANGS.includes(savedLocal)
      ? savedLocal
      : 'en';

  setLanguage(initial, { emit: false });
  return currentLang;
}

export function getLanguage() {
  return currentLang;
}

export function getLocaleTag() {
  return currentLang === 'fr' ? 'fr-FR' : 'en-US';
}

/**
 * Translates a key with automatic fallback to English ('en') and `{placeholder}` interpolation.
 */
export function t(key, vars = {}) {
  const activeDict = dictionaries[currentLang] || {};
  const fallbackDict = dictionaries.en || {};

  let raw = getNestedValue(activeDict, key);
  if (raw === undefined || raw === null || raw === '') {
    raw = getNestedValue(fallbackDict, key);
  }
  if (raw === undefined || raw === null) {
    raw = key;
  }

  let str = String(raw);
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, String(v ?? ''));
  }
  return str;
}

/**
 * Resolves a localized field from a plugin manifest (`"String"` or `{ en: "...", fr: "..." }`).
 */
export function resolveLocalized(value, fallback = '') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return String(value[currentLang] || value.en || Object.values(value)[0] || fallback);
  }
  return fallback;
}

/**
 * Applies `data-i18n`, `data-i18n-placeholder`, `data-i18n-title` and `data-i18n-aria` inside `root`.
 */
export function applyTranslations(root = document) {
  if (!root || !root.querySelectorAll) return;

  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });

  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key));
  });

  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  });

  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key));
  });
}

/**
 * Switches active UI language immediately without closing open windows.
 */
export function setLanguage(lang, { emit = true } = {}) {
  const next = SUPPORTED_LANGS.includes(lang) ? lang : 'en';
  currentLang = next;
  document.documentElement.setAttribute('lang', next);
  try {
    localStorage.setItem('vanillia_lang', next);
  } catch (_) {}

  if (initialized) {
    applyTranslations(document);
    if (emit) {
      window.dispatchEvent(new CustomEvent('vanillia:lang-changed', { detail: { lang: next } }));
    }
  }
  return currentLang;
}
