import { createHash } from 'node:crypto';
import { getConnection } from '../database.js';
import { CZECH_TEXTS } from './texts-cs.js';

// Languages of the page texts. The translations table holds every visible text of DoggyFeed per language, keyed
// by its English text; the page translates itself with them (see the translator in index.html). At server start
// the English records are written first, then the Czech ones from texts-cs.js. A translation changed in the
// database and marked edited = 1 is kept; the others follow the texts in the code.

export const LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English', texts: Object.fromEntries(Object.keys(CZECH_TEXTS).map(key => [key, key])) },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', texts: CZECH_TEXTS }
];
const ROWS_PER_INSERT = 200;

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const keyHash = key => createHash('md5').update(key).digest('hex');

export async function seedTexts() {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    for (const [index, language] of LANGUAGES.entries()) {
      await connection.query(
        `INSERT INTO languages (code, name, native_name, sort_order) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), native_name = VALUES(native_name), sort_order = VALUES(sort_order)`,
        [language.code, language.name, language.nativeName, index + 1]
      );
      const rows = Object.entries(language.texts);
      const now = new Date();
      for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
        const chunk = rows.slice(start, start + ROWS_PER_INSERT);
        // updated_at is set before translation, so it still compares against the stored translation.
        await connection.query(
          `INSERT INTO translations (language_code, key_hash, text_key, translation, updated_at)
           VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}
           ON DUPLICATE KEY UPDATE
             updated_at = IF(edited OR translation = VALUES(translation), updated_at, VALUES(updated_at)),
             translation = IF(edited, translation, VALUES(translation))`,
          chunk.flatMap(([key, text]) => [language.code, keyHash(key), key, text, now])
        );
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export async function listLanguages() {
  const connection = await getConnection();
  try {
    const rows = await connection.query('SELECT code, name, native_name FROM languages WHERE enabled = 1 ORDER BY sort_order, name');
    return rows.map(row => ({ code: row.code, name: row.name, nativeName: row.native_name }));
  } finally {
    connection.release();
  }
}

// All texts of a language as { English text: translation }.
export async function readTexts(code) {
  const connection = await getConnection();
  try {
    const [language] = await connection.query('SELECT code FROM languages WHERE code = ? AND enabled = 1', [String(code).slice(0, 10)]);
    if (!language) throw httpError(404, 'This language is not available.');
    const rows = await connection.query('SELECT text_key, translation FROM translations WHERE language_code = ?', [language.code]);
    return Object.fromEntries(rows.map(row => [row.text_key, row.translation]));
  } finally {
    connection.release();
  }
}
