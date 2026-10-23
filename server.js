const http = require('node:http');
const { readFile, mkdir, rename, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(root, 'data');
const stateFile = path.join(dataDirectory, 'state.json');
const maxBodyBytes = 20 * 1024 * 1024;
const emptyState = { dogs: [], foods: [], meals: {}, savedPlans: [], selectedDog: '' };

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        const error = new Error('Request body is too large.');
        error.statusCode = 413;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('Request body must be valid JSON.');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function isValidState(state) {
  return state &&
    Array.isArray(state.dogs) &&
    Array.isArray(state.foods) &&
    state.meals && typeof state.meals === 'object' && !Array.isArray(state.meals) &&
    Array.isArray(state.savedPlans);
}

async function writeState(state) {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${stateFile}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(state), 'utf8');
  await rename(temporaryFile, stateFile);
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');

  if (pathname === '/api/state' && request.method === 'GET') {
    try {
      sendJson(response, 200, await readState());
    } catch (error) {
      console.error('Unable to read application data:', error);
      sendJson(response, 500, { error: 'Unable to read application data.' });
    }
    return;
  }

  if (pathname === '/api/state' && request.method === 'PUT') {
    try {
      const state = await readRequestJson(request);
      if (!isValidState(state)) {
        sendJson(response, 400, { error: 'Application data has an invalid format.' });
        return;
      }
      await writeState(state);
      sendJson(response, 200, { saved: true });
    } catch (error) {
      if (response.headersSent) return;
      const statusCode = error.statusCode || 500;
      if (statusCode === 500) console.error('Unable to save application data:', error);
      sendJson(response, statusCode, { error: statusCode === 500 ? 'Unable to save application data.' : error.message });
    }
    return;
  }

  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = await readFile(path.join(root, 'index.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(html);
    } catch (error) {
      console.error('Unable to serve the application:', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unable to serve the application.');
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => {
  console.log(`DoggyFeed is running at http://${host}:${port}`);
});
