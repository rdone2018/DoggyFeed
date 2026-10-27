import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const errorLogFile = path.join(root, 'data', 'database-errors.log');
const saveLogFile = path.join(root, 'data', 'database-saves.log');
const maxEntries = 100;
const maxTextLength = 600;

function shorten(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  return text.length > maxTextLength ? `${text.slice(0, maxTextLength)}... (${text.length} characters)` : text;
}

// Each log keeps one JSON object per line in the data folder, so it survives restarts.
// A failure to write a log is reported but never thrown.
async function appendEntry(file, entry) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (logError) {
    console.error(`Unable to write ${path.basename(file)}:`, logError.message);
  }
}

// Returns the most recent entries, newest first.
async function readEntries(file) {
  let content;
  try {
    content = await readFile(file, 'utf8');
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

// Records an error and its database details.
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
  await appendEntry(errorLogFile, entry);
  return entry;
}

// Records a successful save, including where the request came from, so it is clear which
// address and proxy reach this server.
export async function recordSave(details) {
  await appendEntry(saveLogFile, { time: new Date().toISOString(), ...details });
}

export function readErrors() {
  return readEntries(errorLogFile);
}

export function readSaves() {
  return readEntries(saveLogFile);
}
