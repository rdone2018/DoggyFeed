import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase, readDatabaseDiagnostics, readState, writeState } from './database.js';
import * as dogsModule from './modules/dogs.js';
import * as foodsModule from './modules/foods.js';
import * as mealsModule from './modules/meals.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const maxBodyBytes = 20 * 1024 * 1024;

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

function isLoopbackRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
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

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');

  if ((pathname === '/diagnostics' || pathname === '/api/diagnostics') && !isLoopbackRequest(request)) {
    sendJson(response, 403, { error: 'Database diagnostics are available only from this computer.' });
    return;
  }

  if (pathname === '/api/diagnostics' && request.method === 'GET') {
    try {
      sendJson(response, 200, await readDatabaseDiagnostics());
    } catch (error) {
      console.error('Unable to read database diagnostics:', error);
      sendJson(response, 500, { error: 'Unable to read database diagnostics.' });
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

  // Dogs module routes
  if (pathname === '/api/dogs' && request.method === 'GET') {
    try {
      const dogs = await dogsModule.getDogs();
      sendJson(response, 200, dogs);
    } catch (error) {
      console.error('Unable to read dogs:', error);
      sendJson(response, 500, { error: 'Unable to read dogs.' });
    }
    return;
  }

  if (pathname === '/api/dogs' && request.method === 'PUT') {
    try {
      const dog = await readRequestJson(request);
      await dogsModule.saveDog(dog);
      sendJson(response, 200, { saved: true });
  } catch (error) {
      console.error('Unable to save dog:', error);
      sendJson(response, 500, { error: 'Unable to save dog.' });
  }
    return;
}

  if (pathname === '/api/dogs/:id' && request.method === 'DELETE') {
    try {
      const id = pathname.split('/').pop();
      await dogsModule.deleteDog(id);
      sendJson(response, 200, { deleted: true });
    } catch (error) {
      console.error('Unable to delete dog:', error);
      sendJson(response, 500, { error: 'Unable to delete dog.' });
    }
    return;
  }

  // Foods module routes
  if (pathname === '/api/foods' && request.method === 'GET') {
    try {
      const foods = await foodsModule.getFoods();
      sendJson(response, 200, foods);
    } catch (error) {
      console.error('Unable to read foods:', error);
      sendJson(response, 500, { error: 'Unable to read foods.' });
    }
    return;
  }

  if (pathname === '/api/foods' && request.method === 'PUT') {
    try {
      const food = await readRequestJson(request);
      await foodsModule.saveFood(food);
      sendJson(response, 200, { saved: true });
    } catch (error) {
      console.error('Unable to save food:', error);
      sendJson(response, 500, { error: 'Unable to save food.' });
    }
    return;
  }

  if (pathname === '/api/foods/:id' && request.method === 'DELETE') {
    try {
      const id = pathname.split('/').pop();
      await foodsModule.deleteFood(id);
      sendJson(response, 200, { deleted: true });
    } catch (error) {
      console.error('Unable to delete food:', error);
      sendJson(response, 500, { error: 'Unable to delete food.' });
    }
    return;
  }

  // Meals module routes
  if (pathname.startsWith('/api/meals/') && request.method === 'GET') {
    try {
      const dogId = pathname.split('/').pop();
      const meals = await mealsModule.getMealsForDog(dogId);
      sendJson(response, 200, meals);
    } catch (error) {
      console.error('Unable to read meals:', error);
      sendJson(response, 500, { error: 'Unable to read meals.' });
    }
    return;
  }

  if (pathname.startsWith('/api/meals/') && request.method === 'PUT') {
    try {
      const dogId = pathname.split('/').pop();
      const meals = await readRequestJson(request);
      await mealsModule.saveMealsForDog(dogId, meals);
      sendJson(response, 200, { saved: true });
    } catch (error) {
      console.error('Unable to save meals:', error);
      sendJson(response, 500, { error: 'Unable to save meals.' });
    }
    return;
  }

  if (pathname === '/api/plans' && request.method === 'GET') {
    try {
      const plans = await mealsModule.getSavedPlans();
      sendJson(response, 200, plans);
    } catch (error) {
      console.error('Unable to read plans:', error);
      sendJson(response, 500, { error: 'Unable to read plans.' });
    }
    return;
  }

  if (pathname === '/api/plans' && request.method === 'PUT') {
    try {
      const plan = await readRequestJson(request);
      await mealsModule.savePlan(plan);
      sendJson(response, 200, { saved: true });
    } catch (error) {
      console.error('Unable to save plan:', error);
      sendJson(response, 500, { error: 'Unable to save plan.' });
    }
    return;
  }

  if (pathname === '/api/plans/:id' && request.method === 'DELETE') {
    try {
      const id = pathname.split('/').pop();
      await mealsModule.deletePlan(id);
      sendJson(response, 200, { deleted: true });
    } catch (error) {
      console.error('Unable to delete plan:', error);
      sendJson(response, 500, { error: 'Unable to delete plan.' });
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
    await initializeDatabase();
    server.listen(port, host, () => {
      console.log(`DoggyFeed is running at http://${host}:${port}`);
    });
  } catch (error) {
    console.error('Unable to start DoggyFeed. Check the MariaDB service and database settings.');
    console.error(error.message);
    await closeDatabase().catch(() => {});
    process.exitCode = 1;
  }
}

startServer();

