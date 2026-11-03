import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Texts of the device manager. The GUI picks the language, so every text carries all languages.
 * The translations are taken from admin/i18n/*.json, so they are maintained in one place only
 * (the same files are used by the jsonConfig of the instance settings).
 */
const LANGUAGES: ioBroker.Languages[] = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/** build/lib/i18n.js → admin/i18n */
const I18N_DIR = join(__dirname, '..', '..', 'admin', 'i18n');

let words: Partial<Record<ioBroker.Languages, Record<string, string>>> | null = null;

function load(): Partial<Record<ioBroker.Languages, Record<string, string>>> {
    if (!words) {
        words = {};
        for (const lang of LANGUAGES) {
            try {
                words[lang] = JSON.parse(readFileSync(join(I18N_DIR, `${lang}.json`), 'utf8'));
            } catch {
                // The English key is used as fallback
            }
        }
    }
    return words;
}

/**
 * Get the text in all languages. Every `%s` is replaced by the next argument.
 *
 * @param key English text, used as key in admin/i18n/*.json
 * @param args values for `%s` placeholders
 */
export function t(key: string, ...args: (string | number)[]): ioBroker.Translated {
    const all = load();
    const result: Partial<ioBroker.Translated> = {};
    for (const lang of LANGUAGES) {
        let text = all[lang]?.[key] || all.en?.[key] || key;
        for (const arg of args) {
            text = text.replace('%s', String(arg));
        }
        result[lang] = text;
    }
    return result as ioBroker.Translated;
}
