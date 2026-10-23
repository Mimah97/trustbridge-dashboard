/**
 * @vitest-environment jsdom
 *
 * i18n tests — issues #514 and #515.
 *
 * The docblock above runs this file in jsdom so the I18nProvider can be
 * rendered with @testing-library/react (vitest.config.ts only maps
 * *.test.tsx to jsdom); the locale-file and i18n-config assertions below
 * work unchanged in either environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import fs from 'fs';
import path from 'path';
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isSupportedLocale,
  resolveLocale,
} from '@/lib/i18n-config';
import * as StaticI18n from '@/lib/i18n-context';
import type { SupportedLocale } from '@/lib/i18n-config';

// ---------------------------------------------------------------------------
// Shared config module — issue #515
// ---------------------------------------------------------------------------

describe('i18n-config (shared module)', () => {
  it('exports SUPPORTED_LOCALES containing en, es, pt', () => {
    expect(SUPPORTED_LOCALES).toContain('en');
    expect(SUPPORTED_LOCALES).toContain('es');
    expect(SUPPORTED_LOCALES).toContain('pt');
    expect(SUPPORTED_LOCALES).toHaveLength(3);
  });

  it('DEFAULT_LOCALE is en', () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('isSupportedLocale returns true for all supported locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(isSupportedLocale(locale)).toBe(true);
    }
  });

  it('isSupportedLocale returns false for unsupported locales', () => {
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale('de')).toBe(false);
    expect(isSupportedLocale('zh')).toBe(false);
  });

  it('resolveLocale handles missing / null / undefined → DEFAULT_LOCALE', () => {
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('')).toBe(DEFAULT_LOCALE);
  });

  it('resolveLocale normalises locale case (EN → en)', () => {
    expect(resolveLocale('EN')).toBe('en');
    expect(resolveLocale('ES')).toBe('es');
    expect(resolveLocale('PT')).toBe('pt');
  });

  it('resolveLocale returns DEFAULT_LOCALE for unsupported values', () => {
    expect(resolveLocale('fr')).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('xx')).toBe(DEFAULT_LOCALE);
  });
});

// ---------------------------------------------------------------------------
// Locale parity — server config vs client I18nProvider use the same list
// ---------------------------------------------------------------------------

describe('locale list parity — server config vs client provider (#515)', () => {
  it('SUPPORTED_LOCALES in i18n-config matches locale files on disk', () => {
    const localeDir = path.join(process.cwd(), 'public/locales');
    const files = fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'));
    const fileLocales = files.map((f) => f.replace('.json', ''));

    for (const locale of SUPPORTED_LOCALES) {
      expect(fileLocales).toContain(locale);
    }
  });

  it('every locale file has a matching entry in SUPPORTED_LOCALES', () => {
    const localeDir = path.join(process.cwd(), 'public/locales');
    const files = fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'));
    const fileLocales = files.map((f) => f.replace('.json', ''));

    for (const fileLocale of fileLocales) {
      expect(SUPPORTED_LOCALES as readonly string[]).toContain(fileLocale);
    }
  });
});

// ---------------------------------------------------------------------------
// Existing locale file tests (preserved from original)
// ---------------------------------------------------------------------------

describe('i18n', () => {
  describe('locale files', () => {
    it('should have en, es, and pt locale files', () => {
      const localeDir = path.join(process.cwd(), 'public/locales');
      const files = fs.readdirSync(localeDir);
      expect(files).toContain('en.json');
      expect(files).toContain('es.json');
      expect(files).toContain('pt.json');
    });

    it('should have valid JSON in all locale files', () => {
      const localeDir = path.join(process.cwd(), 'public/locales');
      const locales = ['en', 'es', 'pt'];

      locales.forEach((locale) => {
        const content = fs.readFileSync(
          path.join(localeDir, `${locale}.json`),
          'utf-8',
        );
        expect(() => JSON.parse(content)).not.toThrow();
      });
    });

    it('should have matching keys across all locale files', () => {
      const localeDir = path.join(process.cwd(), 'public/locales');
      const locales = ['en', 'es', 'pt'];
      const messages: Record<string, unknown> = {};

      locales.forEach((locale) => {
        const content = fs.readFileSync(
          path.join(localeDir, `${locale}.json`),
          'utf-8',
        );
        messages[locale] = JSON.parse(content);
      });

      const enKeys = new Set(flattenKeys(messages.en));
      const esKeys = new Set(flattenKeys(messages.es));
      const ptKeys = new Set(flattenKeys(messages.pt));

      const missingInEs = [...enKeys].filter((k) => !esKeys.has(k));
      const missingInPt = [...enKeys].filter((k) => !ptKeys.has(k));

      expect(missingInEs).toHaveLength(0);
      expect(missingInPt).toHaveLength(0);
    });
  });

  describe('locale parity with Action', () => {
    it('should support en, es, pt locales matching GitHub Action', () => {
      const localeDir = path.join(process.cwd(), 'public/locales');
      const files = fs.readdirSync(localeDir);
      const requiredLocales = ['en.json', 'es.json', 'pt.json'];
      requiredLocales.forEach((locale) => {
        expect(files).toContain(locale);
      });
    });
  });
});

function flattenKeys(obj: unknown, prefix = ''): string[] {
  const keys: string[] = [];
  for (const key in obj as Record<string, unknown>) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      keys.push(...flattenKeys(val, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// I18nProvider — default locale first paint — issue #514
// ---------------------------------------------------------------------------

function readLocale(locale: string): Record<string, any> {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'public/locales', `${locale}.json`),
      'utf-8',
    ),
  );
}

/** setLocale captured from the most recently rendered provider. */
let setLocale: (locale: SupportedLocale) => void;

/**
 * Renders I18nProvider with a probe that resolves keys through
 * useTranslations.  React.createElement instead of JSX: this file must stay
 * `.ts` (issue #514 asks for tests/unit/i18n.test.ts) and esbuild's `.ts`
 * loader rejects JSX.
 *
 * Accepts a module namespace so the failure test can render a freshly
 * imported provider whose locale bundle is mocked.
 */
function renderProvider(mod: typeof StaticI18n = StaticI18n) {
  function Probe() {
    const t = mod.useTranslations();
    return React.createElement(
      'div',
      null,
      React.createElement(
        'span',
        { 'data-testid': 'title' },
        t('dashboard.title'),
      ),
      React.createElement(
        'span',
        { 'data-testid': 'missing' },
        t('no.such.key', 'Fallback default'),
      ),
    );
  }

  function Harness() {
    const { setLocale: set } = mod.useI18n();
    setLocale = set;
    return React.createElement(Probe);
  }

  return render(
    React.createElement(mod.I18nProvider, null, React.createElement(Harness)),
  );
}

describe('I18nProvider — default locale first paint (#514)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns English strings on first render (no flash of raw keys)', () => {
    // No await / no act flush: the statically imported default bundle must
    // be synchronously present in initial state, before any effect or async
    // import could resolve.
    renderProvider();
    expect(screen.getByTestId('title')).toHaveTextContent(
      readLocale(DEFAULT_LOCALE).dashboard.title,
    );
  });

  it('falls back to defaultValue for a missing key', () => {
    renderProvider();
    expect(screen.getByTestId('missing')).toHaveTextContent(
      'Fallback default',
    );
  });

  it('async locale switch still loads the es bundle', async () => {
    renderProvider();

    await act(async () => {
      setLocale('es');
    });

    await waitFor(() =>
      expect(screen.getByTestId('title')).toHaveTextContent(
        readLocale('es').dashboard.title,
      ),
    );
  });

  it('async locale switch still loads the pt bundle', async () => {
    renderProvider();

    await act(async () => {
      setLocale('pt');
    });

    await waitFor(() =>
      expect(screen.getByTestId('title')).toHaveTextContent(
        readLocale('pt').dashboard.title,
      ),
    );
  });

  it('switching back to en restores the statically bundled messages', async () => {
    renderProvider();

    await act(async () => {
      setLocale('pt');
    });
    await waitFor(() =>
      expect(screen.getByTestId('title')).toHaveTextContent(
        readLocale('pt').dashboard.title,
      ),
    );

    await act(async () => {
      setLocale('en');
    });
    expect(screen.getByTestId('title')).toHaveTextContent(
      readLocale('en').dashboard.title,
    );
  });

  it('rapid locale toggles settle on the last selection (no setState race)', async () => {
    renderProvider();

    await act(async () => {
      // Fire both switches without awaiting the first import.
      setLocale('es');
      setLocale('pt');
    });

    await waitFor(() =>
      expect(screen.getByTestId('title')).toHaveTextContent(
        readLocale('pt').dashboard.title,
      ),
    );

    // Give a stale in-flight import time to land and (incorrectly)
    // overwrite the newer selection.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.getByTestId('title')).toHaveTextContent(
      readLocale('pt').dashboard.title,
    );
  });

  it('logs a console error and falls back to English when a bundle import fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // resolveLocale maps unknown strings to 'en', so an unsupported locale
    // can never reach the import — mock a *supported* bundle instead and
    // load a fresh copy of the provider so only this test sees the mock.
    vi.resetModules();
    vi.doMock('../../public/locales/pt.json', () => {
      throw new Error('simulated bundle load failure');
    });
    const fresh = await import('@/lib/i18n-context');

    try {
      renderProvider(fresh);

      await act(async () => {
        setLocale('pt');
      });

      // Logs the failure…
      await waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          'Failed to load locale pt:',
          expect.anything(),
        ),
      );

      // …without crashing, and falls back to the statically bundled English
      // messages instead of going empty / rendering raw keys.
      expect(screen.getByTestId('title')).toHaveTextContent(
        readLocale('en').dashboard.title,
      );
    } finally {
      vi.doUnmock('../../public/locales/pt.json');
      vi.resetModules();
    }
  });
});

describe('Providers tree', () => {
  it('still wraps the app with I18nProvider', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/components/Providers.tsx'),
      'utf-8',
    );
    expect(source).toContain('<I18nProvider>');
    expect(source).toContain('</I18nProvider>');
  });
});
