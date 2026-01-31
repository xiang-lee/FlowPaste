import { useState, useEffect, useCallback } from 'react';
import { en } from '../locales/en';
import { zh } from '../locales/zh';

type Locale = 'en' | 'zh';
type Translations = typeof en;

const locales: Record<Locale, Translations> = { en, zh };

// Simple event bus for language changes
const listeners = new Set<(lang: Locale) => void>();
const emitChange = (lang: Locale) => listeners.forEach(l => l(lang));

export function useI18n() {
  const [lang, setLang] = useState<Locale>(() => {
    const saved = localStorage.getItem('flowpaste_lang') as Locale;
    return (saved === 'en' || saved === 'zh') ? saved : 'en'; // Default to English
  });

  useEffect(() => {
    const handler = (l: Locale) => setLang(l);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  const changeLanguage = useCallback((newLang: Locale) => {
    localStorage.setItem('flowpaste_lang', newLang);
    setLang(newLang);
    emitChange(newLang);
  }, []);

  return {
    t: locales[lang],
    lang,
    changeLanguage
  };
}
