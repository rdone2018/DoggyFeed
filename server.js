import http from 'node:http';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { closeDatabase, initializeDatabase, readDatabaseDiagnostics, readPicture, readRevision, readState, writeState } from './database.js';
import { readErrors, readSaves, recordError, recordSave } from './errorlog.js';
import * as housesModule from './modules/houses.js';
import * as mealsModule from './modules/meals.js';
import * as formGuard from './modules/form-guard.js';
import * as globalFoods from './modules/global-foods.js';
import * as languagesModule from './modules/languages.js';

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

// Returns the number of bytes sent. Larger answers (the app data carries the pictures) are gzip-compressed
// when the browser accepts it.
function sendJson(response, statusCode, value) {
  const json = Buffer.from(JSON.stringify(value) ?? 'null');
  const gzip = json.length > 1024 && /\bgzip\b/.test(response.req?.headers['accept-encoding'] || '');
  const body = gzip ? gzipSync(json) : json;
  // Proxies and CDNs in front of DoggyFeed must never serve stored API answers, or reloads show old data.
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Vary': 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Surrogate-Control': 'no-store',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
  return body.length;
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

// Sign-in. The session cookie is HttpOnly (page scripts cannot read it) and SameSite=Lax (other sites cannot send
// it along with their requests); it is marked Secure when DoggyFeed is reached over https.
const SESSION_COOKIE = 'doggyfeed_session';

function sessionToken(request) {
  for (const part of String(request.headers.cookie || '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join('='));
  }
  return '';
}

function sessionCookie(request, token, maxAgeSeconds) {
  const secure = request.socket.encrypted || String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

// The signed-in user and their dog house, or null after answering 401 (the page then shows the sign-in screen).
async function requireSession(request, response) {
  const session = await housesModule.readSession(sessionToken(request));
  if (!session) sendJson(response, 401, { error: 'Sign in to DoggyFeed.', signedIn: false });
  return session;
}

// The browser's network address, for sign-in and sign-up limits. Behind a reverse proxy every request comes from the
// proxy, so with DOGGYFEED_TRUST_PROXY=1 the first address in X-Forwarded-For is used instead. Only set it when a
// proxy you control always sets that header, as browsers could otherwise send any address in it.
function clientAddress(request) {
  if (process.env.DOGGYFEED_TRUST_PROXY === '1') {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress || 'unknown';
}

const waitText = seconds => seconds >= 5400 ? `${Math.ceil(seconds / 3600)} hours` : seconds >= 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;

const pause = () => new Promise(resolve => setTimeout(resolve, 400 + Math.random() * 800));

// Answers for a form token that was refused (see modules/form-guard.js). The page then fetches a new token.
const formTokenAnswer = problem => problem === 'too-fast'
  ? { error: 'Please take a moment to fill in the form, then send it again.', formRefresh: true }
  : { error: 'This form has expired, so it was refreshed. Please send it again.', formRefresh: true };

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
        'Cache-Control': 'no-store, max-age=0',
        'Pragma': 'no-cache',
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
      const kind = { startup: ['Page start failed', 'Page load'], load: ['Slow or failed data load', 'Load from /api/state'] }[report?.kind] || ['Browser save failed', 'Save to /api/state'];
      await recordError(kind[0], error, {
        request: `${kind[1]} (reported by the browser)`,
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

  // The languages of the page texts and each language's texts, also before signing in (the sign-in screen).
  if (pathname === '/api/languages' && request.method === 'GET') {
    try {
      sendJson(response, 200, { languages: await languagesModule.listLanguages() });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read the languages');
    }
    return;
  }

  const translationsMatch = pathname.match(/^\/api\/translations\/([a-z]{2,3}(?:-[A-Za-z]{2,4})?)$/);
  if (translationsMatch && request.method === 'GET') {
    try {
      sendJson(response, 200, { code: translationsMatch[1], texts: await languagesModule.readTexts(translationsMatch[1]) });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read the page texts');
    }
    return;
  }

  // Who is signed in. Without a session it says whether DoggyFeed still needs its first user (setupNeeded).
  if (pathname === '/api/session' && request.method === 'GET') {
    try {
      const session = await housesModule.readSession(sessionToken(request));
      if (session) {
        sendJson(response, 200, { signedIn: true, ...session });
      } else {
        const setupNeeded = await housesModule.userCount() === 0;
        sendJson(response, 200, { signedIn: false, setupNeeded, setupHouseName: setupNeeded ? await housesModule.setupDogHouseName() : '' });
      }
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to check the sign-in');
    }
    return;
  }

  // A form token for the Sign in and New dog house forms; see modules/form-guard.js.
  if ((pathname === '/api/form-token' || pathname === '/api/dog-houses/form-token') && request.method === 'GET') {
    sendJson(response, 200, { token: formGuard.formToken() });
    return;
  }

  // Sign in, set up the first user, or create a new dog house with its first user. Each starts a session.
  if (['/api/session', '/api/setup', '/api/dog-houses'].includes(pathname) && request.method === 'POST') {
    const address = clientAddress(request);
    // New dog houses: hard limits on attempts per address and on dog houses created per day.
    if (pathname === '/api/dog-houses') {
      const wait = formGuard.signupWaitSeconds(address);
      if (wait) {
        response.setHeader('Retry-After', String(wait));
        sendJson(response, 429, { error: `Too many attempts to create a dog house. Try again in ${waitText(wait)}.` });
        return;
      }
      formGuard.noteSignupAttempt(address);
    }
    try {
      const body = await readRequestJson(request, 16 * 1024);
      let userId;
      if (pathname === '/api/session') {
        // Sign-in: hard limits on failed sign-ins, a honeypot and a timing check. A wrong username and a wrong
        // password get the same answer after the same password hashing, so no answer shows which usernames exist.
        const username = housesModule.normalUsername(body?.username);
        const wait = formGuard.signInWaitSeconds(address, username);
        if (wait) {
          response.setHeader('Retry-After', String(wait));
          sendJson(response, 429, { error: `Too many failed sign-ins. Try again in ${waitText(wait)}.` });
          return;
        }
        // Honeypot filled in: answer like a wrong password, so the bot learns nothing.
        if (formGuard.honeypotFilled(body)) {
          console.log(`Sign-in refused: the hidden honeypot field was filled in (from ${address}).`);
          formGuard.noteFailedSignIn(address, username);
          await pause();
          sendJson(response, 401, { error: 'The username or password is wrong.', formRefresh: true });
          return;
        }
        const problem = formGuard.formTokenProblem(body?.formToken, Date.now(), formGuard.SIGN_IN_MIN_SECONDS);
        if (problem) {
          formGuard.noteFailedSignIn(address, username);
          sendJson(response, 400, formTokenAnswer(problem));
          return;
        }
        formGuard.useFormToken(body.formToken);
        userId = await housesModule.checkSignIn(body?.username, body?.password);
        if (!userId) {
          formGuard.noteFailedSignIn(address, username);
          sendJson(response, 401, { error: 'The username or password is wrong.', formRefresh: true });
          return;
        }
        formGuard.noteSignedIn(address, username);
      } else if (pathname === '/api/setup') {
        userId = await housesModule.setUpFirstUser(body || {});
      } else {
        // Honeypot filled in: answer as if it worked (after a short pause), so the bot learns nothing, but create
        // nothing and start no session.
        if (formGuard.honeypotFilled(body)) {
          console.log(`New dog house refused: the hidden honeypot field was filled in (from ${address}).`);
          await pause();
          sendJson(response, 200, { signedIn: true });
          return;
        }
        const problem = formGuard.formTokenProblem(body?.formToken);
        if (problem) {
          sendJson(response, 400, formTokenAnswer(problem));
          return;
        }
        formGuard.useFormToken(body.formToken);
        userId = await housesModule.createDogHouseWithUser(body || {});
        formGuard.noteDogHouseCreated(address);
        console.log(`New dog house ${String(body.houseName || '').slice(0, 120)} created (from ${address}).`);
      }
      const token = await housesModule.startSession(userId);
      response.setHeader('Set-Cookie', sessionCookie(request, token, housesModule.SESSION_DAYS * 86400));
      sendJson(response, 200, { signedIn: true, ...await housesModule.readSession(token) });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to sign in');
    }
    return;
  }

  if (pathname === '/api/session/sign-out' && request.method === 'POST') {
    try {
      await housesModule.endSession(sessionToken(request));
      response.setHeader('Set-Cookie', sessionCookie(request, '', 0));
      sendJson(response, 200, { signedIn: false });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to sign out');
    }
    return;
  }

  // The signed-in user's dog house profile and its users. Changes use POST, as some proxies block PUT and DELETE.
  if (pathname === '/api/dog-house' || pathname.startsWith('/api/dog-house/')) {
    const session = await requireSession(request, response).catch(error => {
      sendRouteError(request, response, error, 'Unable to check the sign-in');
      return null;
    });
    if (!session) return;
    const houseId = session.house.id;
    const userMatch = /^\/api\/dog-house\/users\/([^/]+)\/(password|delete)$/.exec(pathname);
    try {
      if (pathname === '/api/dog-house' && request.method === 'GET') {
        sendJson(response, 200, await housesModule.readDogHouse(houseId));
      } else if (pathname === '/api/dog-house' && request.method === 'POST') {
        // Room for the dog house photo, which the page shrinks before sending.
        await housesModule.updateDogHouse(houseId, await readRequestJson(request, housesModule.MAX_HOUSE_PHOTO_BYTES + 64 * 1024) || {});
        sendJson(response, 200, await housesModule.readDogHouse(houseId));
      } else if (pathname === '/api/dog-house/users' && request.method === 'POST') {
        const body = await readRequestJson(request, 16 * 1024);
        await housesModule.addUser(houseId, body?.username, body?.password);
        sendJson(response, 200, await housesModule.readDogHouse(houseId));
      } else if (userMatch && request.method === 'POST') {
        const userId = decodeURIComponent(userMatch[1]);
        if (userMatch[2] === 'password') {
          const body = await readRequestJson(request, 16 * 1024);
          await housesModule.setPassword(houseId, userId, body?.password, userId === session.user.id ? sessionToken(request) : '');
        } else {
          await housesModule.removeUser(houseId, userId, session.user.id);
        }
        sendJson(response, 200, await housesModule.readDogHouse(houseId));
      } else {
        sendJson(response, 404, { error: 'Not found.' });
      }
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to change the dog house');
    }
    return;
  }

  // Admin console: all dog houses and users. Only for signed-in administrators. Changes use POST.
  if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
    const session = await requireSession(request, response).catch(error => {
      sendRouteError(request, response, error, 'Unable to check the sign-in');
      return null;
    });
    if (!session) return;
    if (!session.user.isAdmin) {
      sendJson(response, 403, { error: 'Only administrators can use the admin console.' });
      return;
    }
    const decode = value => decodeURIComponent(value);
    const houseMatch = /^\/api\/admin\/dog-houses\/([^/]+)(?:\/(delete))?$/.exec(pathname);
    const userMatch = /^\/api\/admin\/users\/([^/]+)\/(password|admin|move|delete)$/.exec(pathname);
    try {
      if (request.method === 'GET' && pathname === '/api/admin') {
        sendJson(response, 200, await housesModule.adminOverview());
        return;
      }
      // Global food library: list, add or change (with a picture), delete selected foods, and import CSV rows.
      if (pathname === '/api/admin/global-foods' || pathname.startsWith('/api/admin/global-foods/')) {
        if (request.method === 'GET' && pathname === '/api/admin/global-foods') {
          sendJson(response, 200, { foods: await globalFoods.listGlobalFoods() });
          return;
        }
        const action = pathname.slice('/api/admin/global-foods/'.length);
        if (request.method !== 'POST' || !['save', 'delete', 'import'].includes(action)) {
          sendJson(response, 404, { error: 'Not found.' });
          return;
        }
        const body = await readRequestJson(request, 8 * 1024 * 1024) || {};
        let result = {};
        if (action === 'save') result = { id: await globalFoods.saveGlobalFood(body) };
        if (action === 'delete') result = { deleted: await globalFoods.deleteGlobalFoods(body.ids) };
        if (action === 'import') {
          result = await globalFoods.importGlobalFoods(body.foods);
          console.log(`Global food library import by ${session.user.username}: ${result.added} added, ${result.updated} updated.`);
        }
        sendJson(response, 200, { ...result, foods: await globalFoods.listGlobalFoods() });
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      const body = await readRequestJson(request, 16 * 1024) || {};
      if (pathname === '/api/admin/dog-houses') {
        await housesModule.adminCreateDogHouse(body);
      } else if (houseMatch && houseMatch[2] === 'delete') {
        const name = await housesModule.adminDeleteDogHouse(decode(houseMatch[1]), body.confirmName, session.house.id);
        console.log(`Dog house ${name} and all its data were deleted by ${session.user.username}.`);
      } else if (houseMatch) {
        await housesModule.adminUpdateDogHouse(decode(houseMatch[1]), body);
      } else if (pathname === '/api/admin/users') {
        await housesModule.adminAddUser(body);
      } else if (userMatch) {
        const userId = decode(userMatch[1]);
        if (userMatch[2] === 'password') await housesModule.adminSetPassword(userId, body.password, userId === session.user.id ? sessionToken(request) : '');
        if (userMatch[2] === 'admin') await housesModule.adminSetAdmin(userId, body.isAdmin === true, session.user.id);
        if (userMatch[2] === 'move') await housesModule.adminMoveUser(userId, String(body.houseId || ''), session.user.id);
        if (userMatch[2] === 'delete') await housesModule.adminDeleteUser(userId, session.user.id);
      } else {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      sendJson(response, 200, await housesModule.adminOverview());
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to change the administration data');
    }
    return;
  }

  // Everything below reads or changes a dog house's data, so it needs a signed-in user. It only ever reaches the
  // data of that user's dog house.
  const needsSession = pathname === '/api/state' || pathname === '/api/state/revision' ||
    pathname.startsWith('/api/pictures/') || pathname === '/api/served-meals' || pathname.startsWith('/api/served-meals/');
  const isConnectionTest = pathname === '/api/state' && request.method === 'POST' &&
    new URL(request.url, 'http://localhost').searchParams.get('connectionTest') === '1';
  let session = null;
  if (needsSession && !isConnectionTest) {
    try {
      session = await requireSession(request, response);
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to check the sign-in');
      return;
    }
    if (!session) return;
  }
  const dogHouseId = session?.house.id;

  if (pathname === '/api/state' && request.method === 'GET') {
    // Loads taking over 5 seconds are logged, split into the MariaDB read and sending the answer, to tell a slow
    // database from a slow connection to the browser.
    const started = Date.now();
    try {
      // A dog house without saved data answers { empty: true }; the page then starts it with sample data.
      const state = await readState(dogHouseId);
      const readMs = Date.now() - started;
      const house = { ...session.house, photo: await housesModule.readHousePhotoLink(dogHouseId) };
      const bytes = sendJson(response, 200, { ...(state || { empty: true, revision: 0 }), session: { ...session, house } });
      response.once('close', () => {
        const totalMs = Date.now() - started;
        if (totalMs <= 5000) return;
        const error = new Error(`Loading the data took ${(totalMs / 1000).toFixed(1)} s: reading MariaDB ${(readMs / 1000).toFixed(1)} s, sending ${Math.round(bytes / 1024)} KB ${((totalMs - readMs) / 1000).toFixed(1)} s${response.writableFinished ? '' : ' (not finished, the browser closed the connection)'}`);
        error.statusCode = 200;
        recordError('Slow data load', error, { request: 'GET /api/state', bodyBytes: bytes }).catch(() => {});
      });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read application data');
    }
    return;
  }

  // Dog photos and food pictures, linked from the app data. Each link carries the picture's version, so the
  // browser may keep it for good and fetches a changed picture under its new link.
  const pictureMatch = /^\/api\/pictures\/(dog|food|house|global)\/([^/]+)$/.exec(pathname);
  if (pictureMatch && request.method === 'GET') {
    try {
      const picture = await readPicture(dogHouseId, pictureMatch[1], decodeURIComponent(pictureMatch[2]));
      if (!picture) {
        sendJson(response, 404, { error: 'Picture not found.' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': picture.type,
        'Content-Length': picture.data.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(picture.data);
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read the picture');
    }
    return;
  }

  if (pathname === '/api/state/revision' && request.method === 'GET') {
    try {
      sendJson(response, 200, { revision: await readRevision(dogHouseId), startedAt: serverInfo.startedAt });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to read the save number');
    }
    return;
  }

  // Connection test: the page sends requests of different sizes, content and addresses. They are only read
  // and answered, never saved, to find what a proxy or firewall between the browser and DoggyFeed holds back.
  if ((pathname === '/api/connection-test' && request.method === 'POST') || isConnectionTest) {
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
      const result = await writeState(dogHouseId, state, Number.isInteger(state.baseRevision) ? state.baseRevision : null);
      console.log(`Save #${result.revision} of ${session.house.name} written after ${Date.now() - started} ms`);
      stage = 'recording the save';
      await recordSave({
        ...result,
        dogHouse: session.house.name,
        user: session.user.username,
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

  if (pathname === '/api/served-meals' && request.method === 'GET') {
    try {
      const query = new URL(request.url, 'http://localhost').searchParams;
      const from = new Date(query.get('from'));
      const to = new Date(query.get('to'));
      if (!query.get('dogId') || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
        sendJson(response, 400, { error: 'Served bowls need a dog and a valid date range.' });
        return;
      }
      sendJson(response, 200, { meals: await mealsModule.getServedMeals(dogHouseId, query.get('dogId'), from, to) });
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
      const result = await mealsModule.recordServedMeal(dogHouseId, meal);
      sendJson(response, 201, { saved: true, ...result });
    } catch (error) {
      sendRouteError(request, response, error, 'Unable to record the served bowl');
    }
    return;
  }

  // Changing the date of a served bowl, or deleting it. Both use POST, as some proxies in front of DoggyFeed
  // block PUT and DELETE requests.
  const servedMatch = /^\/api\/served-meals\/([^/]+)\/(date|delete)$/.exec(pathname);
  if (servedMatch && request.method === 'POST') {
    const id = decodeURIComponent(servedMatch[1]);
    try {
      let found;
      if (servedMatch[2] === 'date') {
        const body = await readRequestJson(request, 4 * 1024);
        const servedAt = new Date(body?.servedAt);
        if (Number.isNaN(servedAt.getTime())) {
          sendJson(response, 400, { error: 'Choose a valid date and time.' });
          return;
        }
        found = await mealsModule.updateServedMealTime(dogHouseId, id, servedAt);
      } else {
        found = await mealsModule.deleteServedMeal(dogHouseId, id);
      }
      sendJson(response, found ? 200 : 404, found ? { saved: true } : { error: 'This served bowl was not found.' });
    } catch (error) {
      sendRouteError(request, response, error, servedMatch[2] === 'date' ? 'Unable to change the served bowl' : 'Unable to delete the served bowl');
    }
    return;
  }

  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      // Compressed when the browser accepts it: the page is about a quarter of the size, so a slow or
      // unsteady connection (such as a phone's first one) is less likely to stall before the app script.
      const html = await readFile(path.join(root, 'index.html'));
      const gzip = /\bgzip\b/.test(request.headers['accept-encoding'] || '');
      const body = gzip ? gzipSync(html) : html;
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        // Never kept by the browser or a proxy, so a reload after an update always gets the new page.
        'Cache-Control': 'no-store, max-age=0',
        'Pragma': 'no-cache',
        'Vary': 'Accept-Encoding',
        'X-Content-Type-Options': 'nosniff',
        ...(gzip ? { 'Content-Encoding': 'gzip' } : {})
      });
      response.end(body);
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
    await languagesModule.seedTexts().catch(async error => {
      console.error('Unable to write the page texts to the database:', error.message);
      await recordError('Unable to write the page texts', error);
    });
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

