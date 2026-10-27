import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(root, 'data', 'database-errors.log');
const maxEntries = 100;
const maxTextLength = 600;

function shorten(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  return text.length > maxTextLength ? `${text.slice(0, maxTextLength)}... (${text.length} characters)` : text;
}

// Records an error and its database details as one JSON line in data/database-errors.log,
// so the log survives restarts. A failure to write the log is reported but never thrown.
export async function recordError(operation, error, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    operation,
    status: error?.statusCode || 500,
    code: error?.code || null,
    errno: error?.errno || null,
    sqlState: error?.sqlState || null,
    message: shorten(error?.sqlMessage || error?.message || error),
    sql: shorten(error?.sql),
    ...details
  };
  console.error(`${operation}:`, error);
  try {
    await mkdir(path.dirname(logFile), { recursive: true });
    await appendFile(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (logError) {
    console.error('Unable to write the database error log:', logError.message);
  }
  return entry;
}

// Returns the most recent entries, newest first.
export async function readErrors() {
  let content;
  try {
    content = await readFile(logFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return content.split('\n').filter(line => line.trim()).slice(-maxEntries).reverse().map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return { message: shorten(line) };
    }
  });
}
