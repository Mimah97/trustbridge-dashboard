'use client';
/**
 * Client-side I18nProvider and helpers.
 *
 * Issue #515 — now uses the shared i18n-config module so the supported locale
 * list and message-loading path are identical to the next-intl server config
 * (src/i18n.ts).  The provider also accepts an `initialLocale` prop so the
 * server-selected locale can be passed down without a client/server mismatch.
 *
 * Issue #514 — the default (en) bundle is imported statically and seeds the
 * initial `messages` state, so useTranslations returns English strings on the
 * very first paint (SSR HTML included) instead of raw keys while an async
 * import resolves.  Bundle-size trade-off: only en.json (~2.5 kB) ships
 * eagerly; es/pt stay lazy chunks loaded on switch.  A useEffect hydration
 * would still flash untranslated keys on the first paint, so the initial
 * state is used instead.
 */
import React, { ReactNode, useRef, useState } from 'react';
import {
  SUPPORTED_LOCALES,
  SupportedLocale,
  DEFAULT_LOCALE,
  resolveLocale,
} from '@/lib/i18n-config';

// Default-locale messages for first paint and as the fallback bundle when a
// locale switch fails.  src/lib → ../../public/locales — the same directory
// the server config (src/i18n.ts) loads from.
import enMessages from '../../public/locales/en.json';

// Re-export so callers that imported these from here still compile.
export type { SupportedLocale };
export { SUPPORTED_LOCALES, DEFAULT_LOCALE };

const DEFAULT_MESSAGES = enMessages as Record<string, unknown>;

interface I18nContextType {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  messages: Record<string, unknown>;
}

const I18nContext = React.createContext<I18nContextType | undefined>(undefined);

interface I18nProviderProps {
  children: ReactNode;
  /**
   * Locale pre-selected on the server (e.g. read from the request cookie or
   * next-intl routing).  When provided the client initialises with the same
   * locale the server used — preventing a hydration mismatch.
   * Defaults to DEFAULT_LOCALE ('en') when omitted.
   */
  initialLocale?: string;
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  // resolveLocale normalises case and falls back to DEFAULT_LOCALE for unknown
  // values, so a misconfigured server prop cannot crash the client.
  const [locale, setLocaleState] = useState<SupportedLocale>(
    resolveLocale(initialLocale),
  );
  // Issue #514 — start from the statically imported default bundle instead of
  // `{}` so the first render already resolves translations (no raw keys).
  const [messages, setMessages] = useState<Record<string, unknown>>(
    DEFAULT_MESSAGES,
  );
  // Monotonic id per switch: a slow import started for an older locale must
  // not overwrite the messages of a newer selection (rapid locale toggles
  // would otherwise race setState and land the wrong bundle).
  const loadIdRef = useRef(0);

  const handleSetLocale = async (newLocale: SupportedLocale) => {
    const resolved = resolveLocale(newLocale);
    const loadId = ++loadIdRef.current;
    setLocaleState(resolved);

    // The default bundle is already in memory — nothing to fetch.
    if (resolved === DEFAULT_LOCALE) {
      setMessages(DEFAULT_MESSAGES);
      return;
    }

    try {
      // Load from the same public/locales path used by the server config.
      const localeMessages = await import(
        `../../public/locales/${resolved}.json`
      );
      if (loadIdRef.current !== loadId) return; // stale — a newer locale won
      setMessages(localeMessages.default);
    } catch (error) {
      if (loadIdRef.current !== loadId) return;
      // Console error for observability; fall back to the statically bundled
      // English messages — consistent with the server fallback and immune to
      // chunk-load failures, so the UI can never show raw keys.
      console.error(`Failed to load locale ${resolved}:`, error);
      setMessages(DEFAULT_MESSAGES);
    }
  };

  return (
    <I18nContext.Provider
      value={{ locale, setLocale: handleSetLocale, messages }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = React.useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}

export function useTranslations() {
  const { messages } = useI18n();
  return (key: string, defaultValue: string = key) => {
    const keys = key.split('.');
    let value: unknown = messages;
    for (const k of keys) {
      if (typeof value === 'object' && value !== null) {
        value = (value as Record<string, unknown>)[k];
      }
    }
    return typeof value === 'string' ? value : defaultValue;
  };
}
