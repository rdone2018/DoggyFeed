import http from 'node:http';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase, readDatabaseDiagnostics, readRevision, readState, writeState } from './database.js';
import { readErrors, readSaves, recordError, recordSave } from './errorlog.js';
import * as dogsModule from './modules/dogs.js';
import * as foodsModule from './modules/foods.js';
import * as mealsModule from './modules/meals.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const maxBodyBytes = 20 * 1024 * 1024;

// Identifies this running server on the diagnostics page, to tell apart two copies of DoggyFeed.
const serverInfo = {
  startedAt: new Date().toISOString(),
  processId: process.pid,
  folder: root,
  database: `${process.env.DB_NAME || 'doggyfeed'} on ${process.env.DB_HOST || 'localhost'}:${Number(process.env.DB_PORT) || 3306}`
};

// The page is read from disk on every request, but the server code only loads at startup. After a git pull
// without a restart, new pages talk to old server code and their saves can fail. A fingerprint of the server
// files taken at startup lets the page warn when the files on disk have changed since.
async function serverCodeFingerprint() {
  const modules = (await readdir(path.join(root, 'modules')).catch(() => []))
    .filter(name => name.endsWith('.js')).map(name => `modules/${name}`);
  const hash = createHash('sha256');
  for (const file of ['server.js', 'database.js', 'errorlog.js', ...modules].sort()) {
    hash.update(file);
    hash.update(await readFile(path.join(root, file)).catch(() => Buffer.from('missing')));
  }
  return hash.digest('hex').slice(0, 16);
}
let startupFingerprint = '';

function sendJson(response, statusCode, value) {
  // Proxies and CDNs in front of DoggyFeed must never serve stored API answers, or reloads show old data.
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Surrogate-Control': 'no-store',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

function isLoopbackRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
}

function readRequestJson(request, maxBytes = maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      request.bodyBytes = size;
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

// Returns the decoded id from paths like /api/dogs/<id>, or null when the path does not match.
function routeId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

function sendRouteError(request, response, error, message) {
  const statusCode = error.statusCode || 500;
  recordError(message, error, {
    request: `${request.method} ${new URL(request.url, 'http://localhost').pathname}`,
    bodyBytes: request.bodyBytes ?? null
  });
  if (response.headersSent) return;
  // Include the database error code (for example ER_BAD_FIELD_ERROR) so failures can be diagnosed from the browser.
  const detail = statusCode === 500 && error.code ? ` (${error.code})` : '';
  sendJson(response, statusCode, {
    error: statusCode === 500 ? `${message}${detail}.` : error.message,
    ...(error.currentRevision !== undefined ? { conflict: true, currentRevision: error.currentRevision } : {})
  });
}

function isValidState(state) {
  return state &&
    Array.isArray(state.dogs) &&
    Array.isArray(state.foods) &&
    state.meals && typeof state.meals === 'object' && !Array.isArray(state.meals) &&
    Array.isArray(state.savedPlans);
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');

  if ((pathname === '/diagnostics' || pathname === '/api/diagnostics' || pathname === '/api/diagnostics/errors') && !isLoopbackRequest(request)) {
    sendJson(response, 403, { error: 'Database diagnostics are available only from this computer.' });
    return;
  }

  // The error log does not need the database, so it stays readable when MariaDB is failing.
  if (pathname === '/api/diagnostics/errors' && request.method === 'GET') {
    try {
      const [errors, saves] = await Promise.all([readErrors(), readSaves()]);
      sendJson(response, 200, { errors, saves, server: serverInfo });
    } catch (error) {
      console.error('Unable to read the database error log:', error);
      sendJson(response, 500, { error: 'Unable to read the database error log.' });
    }
    return;
  }

  if (pathname === '/api/diagnostics' && request.method === 'GET') {
    try {
      sendJson(response, 200, await readDatabaseDiagnostics());
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read database diagnostics');
    }
    return;
  }

  if (pathname === '/diagnostics' && request.method === 'GET') {
    try {
      const html = await readFile(path.join(root, 'diagnostics.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(html);
    } catch (error) {
      console.error('Unable to serve database diagnostics:', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unable to serve database diagnostics.');
    }
    return;
  }

  // Save failures the browser saw but this server never received, such as a proxy rejecting a large request.
  if (pathname === '/api/client-errors' && request.method === 'POST') {
    try {
      const report = await readRequestJson(request, 16 * 1024);
      const error = new Error(String(report?.message || 'Unknown browser error'));
      error.statusCode = Number(report?.status) || null;
      await recordError('Browser save failed', error, {
        request: 'Save to /api/state (reported by the browser)',
        bodyBytes: Number(report?.bodyBytes) || null
      });
      sendJson(response, 200, { recorded: true });
    } catch {
      sendJson(response, 400, { error: 'Invalid error report.' });
    }
    return;
  }

  if (pathname === '/api/server-status' && request.method === 'GET') {
    try {
      const current = await serverCodeFingerprint();
      sendJson(response, 200, { startedAt: serverInfo.startedAt, restartNeeded: Boolean(startupFingerprint) && current !== startupFingerprint });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to check the server code');
    }
    return;
  }

  if (pathname === '/api/state' && request.method === 'GET') {
    try {
      sendJson(response, 200, await readState());
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read application data');
    }
    return;
  }

  if (pathname === '/api/state/revision' && request.method === 'GET') {
    try {
      sendJson(response, 200, { revision: await readRevision(), startedAt: serverInfo.startedAt });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read the save number');
    }
    return;
  }

  // Connection test: the page sends requests of different sizes, content and addresses. They are only read
  // and answered, never saved, to find what a proxy or firewall between the browser and DoggyFeed holds back.
  const isStateTest = pathname === '/api/state' && request.method === 'POST' &&
    new URL(request.url, 'http://localhost').searchParams.get('connectionTest') === '1';
  if ((pathname === '/api/connection-test' && request.method === 'POST') || isStateTest) {
    const started = Date.now();
    try {
      await readRequestJson(request);
      console.log(`Connection test reached the server: ${pathname}, ${request.bodyBytes} bytes, ${Date.now() - started} ms`);
      sendJson(response, 200, { ok: true, bytes: request.bodyBytes, path: pathname });
    } catch (error) {
      sendRouteError(request, response, error, 'Connection test failed');
    }
    return;
  }

  // The page saves with POST, because some proxies and hosting firewalls block PUT. PUT stays for older pages.
  if (pathname === '/api/state' && (request.method === 'POST' || request.method === 'PUT')) {
    // Each step is logged and a save still running after 20 seconds is recorded, so a save that never
    // finishes shows where it stopped instead of failing silently.
    const started = Date.now();
    let stage = 'receiving the data from the browser';
    console.log(`Save received from ${request.headers['x-forwarded-for'] || request.socket.remoteAddress}`);
    const watchdog = setTimeout(() => {
      const error = new Error(`The save has been running for 20 seconds and is still ${stage}.`);
      error.code = 'SAVE_TOO_SLOW';
      recordError('Save is taking too long', error, { request: `${request.method} /api/state`, bodyBytes: request.bodyBytes ?? null });
    }, 20000);
    try {
      const state = await readRequestJson(request);
      console.log(`Save data received: ${request.bodyBytes} bytes after ${Date.now() - started} ms`);
      if (!isValidState(state)) {
        sendJson(response, 400, { error: 'Application data has an invalid format.' });
        return;
      }
      stage = 'writing to the database';
      const result = await writeState(state, Number.isInteger(state.baseRevision) ? state.baseRevision : null);
      console.log(`Save #${result.revision} written after ${Date.now() - started} ms`);
      stage = 'recording the save';
      await recordSave({
        ...result,
        bodyBytes: request.bodyBytes ?? null,
        host: request.headers.host || null,
        forwardedFor: request.headers['x-forwarded-for'] || null,
        forwardedHost: request.headers['x-forwarded-host'] || null,
        client: request.socket.remoteAddress || null
      });
      sendJson(response, 200, { saved: true, ...result });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to save application data');
    } finally {
      clearTimeout(watchdog);
    }
    return;
  }

  const dogId = routeId(pathname, '/api/dogs/');
  const foodId = routeId(pathname, '/api/foods/');
  const mealsDogId = routeId(pathname, '/api/meals/');
  const planId = routeId(pathname, '/api/plans/');

  // Dogs module routes
  if (pathname === '/api/dogs' && request.method === 'GET') {
    try {
      const dogs = await dogsModule.getDogs();
      sendJson(response, 200, dogs);
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read dogs');
    }
    return;
  }

  if (pathname === '/api/dogs' && request.method === 'PUT') {
    try {
      const dog = await readRequestJson(request);
      if (!dog || typeof dog.id !== 'string' || !dog.id || typeof dog.name !== 'string' || !dog.name) {
        sendJson(response, 400, { error: 'A dog needs an id and a name.' });
        return;
      }
      await dogsModule.saveDog(dog);
      sendJson(response, 200, { saved: true });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to save dog');
    }
    return;
  }

  if (dogId && request.method === 'DELETE') {
    try {
      await dogsModule.deleteDog(dogId);
      sendJson(response, 200, { deleted: true });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to delete dog');
    }
    return;
  }

  // Foods module routes
  if (pathname === '/api/foods' && request.method === 'GET') {
    try {
      const foods = await foodsModule.getFoods();
      sendJson(response, 200, foods);
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read foods');
    }
    return;
  }

  if (pathname === '/api/foods' && request.method === 'PUT') {
    try {
      const food = await readRequestJson(request);
      if (!food || typeof food.id !== 'string' || !food.id || typeof food.name !== 'string' || !food.name) {
        sendJson(response, 400, { error: 'A food needs an id and a name.' });
        return;
      }
      await foodsModule.saveFood(food);
      sendJson(response, 200, { saved: true });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to save food');
    }
    return;
  }

  if (foodId && request.method === 'DELETE') {
    try {
      await foodsModule.deleteFood(foodId);
      sendJson(response, 200, { deleted: true });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to delete food');
    }
    return;
  }

  // Meals module routes
  if (mealsDogId && request.method === 'GET') {
    try {
      const meals = await mealsModule.getMealsForDog(mealsDogId);
      sendJson(response, 200, meals);
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read meals');
    }
    return;
  }

  if (mealsDogId && request.method === 'PUT') {
    try {
      const meals = await readRequestJson(request);
      if (!Array.isArray(meals)) {
        sendJson(response, 400, { error: 'Meals must be a list of foods and amounts.' });
        return;
      }
      await mealsModule.saveMealsForDog(mealsDogId, meals);
      sendJson(response, 200, { saved: true });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to save meals');
    }
    return;
  }

  if (pathname === '/api/served-meals' && request.method === 'GET') {
    try {
      const query = new URL(request.url, 'http://localhost').searchParams;
      const from = new Date(query.get('from'));
      const to = new Date(query.get('to'));
      if (!query.get('dogId') || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
        sendJson(response, 400, { error: 'Served bowls need a dog and a valid date range.' });
        return;
      }
      sendJson(response, 200, { meals: await mealsModule.getServedMeals(query.get('dogId'), from, to) });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read served bowls');
    }
    return;
  }

  if (pathname === '/api/served-meals' && request.method === 'POST') {
    try {
      const meal = await readRequestJson(request, 512 * 1024);
      if (!meal || typeof meal.dogId !== 'string' || !meal.dogId || !Array.isArray(meal.items)) {
        sendJson(response, 400, { error: 'A served bowl needs a dog and its foods.' });
        return;
      }
      const result = await mealsModule.recordServedMeal(meal);
      sendJson(response, 201, { saved: true, ...result });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to record the served bowl');
    }
    return;
  }

  if (pathname === '/api/plans' && request.method === 'GET') {
    try {
      const plans = await mealsModule.getSavedPlans();
      sendJson(response, 200, plans);
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read plans');
    }
    return;
  }

  if (pathname === '/api/plans' && request.method === 'PUT') {
    try {
      const plan = await readRequestJson(request);
      if (!plan || typeof plan.id !== 'string' || !plan.id || typeof plan.name !== 'string' || !plan.name) {
        sendJson(response, 400, { error: 'A plan needs an id and a name.' });
        return;
      }
      await mealsModule.savePlan(plan);
      sendJson(response, 200, { saved: true });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to save plan');
    }
    return;
  }

  if (planId && request.method === 'DELETE') {
    try {
      await mealsModule.deletePlan(planId);
      sendJson(response, 200, { deleted: true });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to delete plan');
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

async function startServer() {
  try {
    startupFingerprint = await serverCodeFingerprint();
    await initializeDatabase();
    server.listen(port, host, () => {
      console.log(`DoggyFeed is running at http://${host}:${port}`);
    });
  } catch (error) {
    console.error('Unable to start DoggyFeed. Check the MariaDB service and database settings.');
    await recordError('Unable to start DoggyFeed', error);
    await closeDatabase().catch(() => {});
    process.exitCode = 1;
  }
}

startServer();

