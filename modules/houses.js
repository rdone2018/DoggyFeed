import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createDogHouse, firstDogHouseId, getConnection } from '../database.js';

// Dog houses, their users and sign-in sessions. Passwords are stored only as scrypt hashes with a random salt.
// A session is a random token in an HttpOnly cookie; the database keeps only the token's SHA-256 hash.

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 16384, r: 8, p: 1 };
export const SESSION_DAYS = 30;

const clean = (value, maxLength) => String(value ?? '').trim().slice(0, maxLength);
const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export const normalUsername = value => String(value ?? '').trim().toLowerCase();

// Returns an error message, or '' when the username can be used.
export function usernameProblem(username) {
  return /^[a-z0-9._@-]{3,80}$/.test(username) ? '' : 'Use 3 to 80 letters, digits or . _ @ - for the username.';
}

export function passwordProblem(password) {
  const length = String(password ?? '').length;
  return length >= 8 && length <= 200 ? '' : 'Use a password of at least 8 characters.';
}

function emailProblem(email) {
  return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Enter a valid email address, or leave it empty.';
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function passwordMatches(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Checked when a username does not exist, so a wrong username takes as long as a wrong password.
const unknownUserHash = hashPassword(randomUUID());

async function insertUser(connection, dogHouseId, username, password) {
  const name = normalUsername(username);
  const problem = usernameProblem(name) || passwordProblem(password);
  if (problem) throw httpError(400, problem);
  const id = `user-${randomUUID()}`;
  try {
    await connection.query(
      'INSERT INTO users (id, dog_house_id, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, dogHouseId, name, await hashPassword(password), new Date()]
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw httpError(409, `The username ${name} is already taken.`);
    throw error;
  }
  return id;
}

function houseFields(fields) {
  const house = { name: clean(fields.name, 120), contact: clean(fields.contact, 200), email: clean(fields.email, 200) };
  if (!house.name) throw httpError(400, 'Give the dog house a name.');
  const problem = emailProblem(house.email);
  if (problem) throw httpError(400, problem);
  return house;
}

async function inTransaction(work) {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export async function userCount() {
  const connection = await getConnection();
  try {
    const [row] = await connection.query('SELECT COUNT(*) AS count FROM users');
    return Number(row.count) || 0;
  } finally {
    connection.release();
  }
}

// The name of the dog house the first user will join (the one holding data from before dog houses), if any.
export async function setupDogHouseName() {
  const connection = await getConnection();
  try {
    const [house] = await connection.query('SELECT name FROM dog_house ORDER BY created_at, id LIMIT 1');
    return house?.name || '';
  } finally {
    connection.release();
  }
}

// First start: while there are no users, the first one is created for the oldest dog house (which holds the data
// from before dog houses), or for a new dog house when there is none.
export async function setUpFirstUser({ houseName, contact, email, username, password }) {
  return inTransaction(async connection => {
    const [row] = await connection.query('SELECT COUNT(*) AS count FROM users FOR UPDATE');
    if (Number(row.count) > 0) throw httpError(409, 'DoggyFeed is already set up. Sign in instead.');
    const dogHouseId = await firstDogHouseId(connection);
    const house = houseFields({ name: houseName, contact, email });
    await connection.query('UPDATE dog_house SET name = ?, contact = ?, email = ? WHERE id = ?',
      [house.name, house.contact || null, house.email || null, dogHouseId]);
    return insertUser(connection, dogHouseId, username, password);
  });
}

// A new dog house with its first user. Its data starts empty.
export async function createDogHouseWithUser({ houseName, contact, email, username, password }) {
  return inTransaction(async connection => {
    const house = houseFields({ name: houseName, contact, email });
    const problem = usernameProblem(normalUsername(username)) || passwordProblem(password);
    if (problem) throw httpError(400, problem);
    const dogHouseId = await createDogHouse(connection, house);
    return insertUser(connection, dogHouseId, username, password);
  });
}

// Returns the user's id when the username and password match, otherwise null.
export async function checkSignIn(username, password) {
  const connection = await getConnection();
  let user;
  try {
    [user] = await connection.query('SELECT id, password_hash FROM users WHERE username = ?', [normalUsername(username)]);
  } finally {
    connection.release();
  }
  if (!user) {
    await passwordMatches(password, await unknownUserHash);
    return null;
  }
  return await passwordMatches(password, user.password_hash) ? user.id : null;
}

export async function startSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const connection = await getConnection();
  try {
    await connection.query('DELETE FROM sessions WHERE expires_at < ?', [new Date()]);
    await connection.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      [tokenHash(token), userId, new Date(Date.now() + SESSION_DAYS * 86400000)]);
  } finally {
    connection.release();
  }
  return token;
}

// The signed-in user and their dog house for a session token, or null. A session in use is extended, so it only
// ends after SESSION_DAYS without use.
export async function readSession(token) {
  if (!token) return null;
  const connection = await getConnection();
  try {
    const [row] = await connection.query(
      `SELECT s.token_hash, s.expires_at, u.id AS user_id, u.username, h.id AS house_id, h.name, h.contact, h.email
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN dog_house h ON h.id = u.dog_house_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      [tokenHash(token), new Date()]
    );
    if (!row) return null;
    if (new Date(row.expires_at).getTime() - Date.now() < (SESSION_DAYS - 1) * 86400000) {
      await connection.query('UPDATE sessions SET expires_at = ? WHERE token_hash = ?',
        [new Date(Date.now() + SESSION_DAYS * 86400000), row.token_hash]);
    }
    return {
      user: { id: row.user_id, username: row.username },
      house: { id: row.house_id, name: row.name, contact: row.contact || '', email: row.email || '' }
    };
  } finally {
    connection.release();
  }
}

export async function endSession(token) {
  if (!token) return;
  const connection = await getConnection();
  try {
    await connection.query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
  } finally {
    connection.release();
  }
}

// The dog house profile with its users (never their password hashes).
export async function readDogHouse(dogHouseId) {
  const connection = await getConnection();
  try {
    const [house] = await connection.query('SELECT id, name, contact, email, created_at FROM dog_house WHERE id = ?', [dogHouseId]);
    if (!house) throw httpError(404, 'This dog house was not found.');
    const users = await connection.query('SELECT id, username, created_at FROM users WHERE dog_house_id = ? ORDER BY username', [dogHouseId]);
    return {
      id: house.id, name: house.name, contact: house.contact || '', email: house.email || '',
      createdAt: new Date(house.created_at).toISOString(),
      users: users.map(user => ({ id: user.id, username: user.username, createdAt: new Date(user.created_at).toISOString() }))
    };
  } finally {
    connection.release();
  }
}

export async function updateDogHouse(dogHouseId, fields) {
  const house = houseFields(fields);
  const connection = await getConnection();
  try {
    await connection.query('UPDATE dog_house SET name = ?, contact = ?, email = ? WHERE id = ?',
      [house.name, house.contact || null, house.email || null, dogHouseId]);
  } finally {
    connection.release();
  }
}

export async function addUser(dogHouseId, username, password) {
  return inTransaction(connection => insertUser(connection, dogHouseId, username, password));
}

// Sets a new password for a user of the dog house and signs that user out everywhere else.
export async function setPassword(dogHouseId, userId, password, keepToken) {
  const problem = passwordProblem(password);
  if (problem) throw httpError(400, problem);
  return inTransaction(async connection => {
    const result = await connection.query('UPDATE users SET password_hash = ? WHERE id = ? AND dog_house_id = ?',
      [await hashPassword(password), userId, dogHouseId]);
    if (!result.affectedRows) throw httpError(404, 'This user was not found.');
    await connection.query('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, keepToken ? tokenHash(keepToken) : '']);
  });
}

// Removes a user of the dog house. Users cannot remove themselves, and a dog house keeps at least one user.
export async function removeUser(dogHouseId, userId, currentUserId) {
  if (userId === currentUserId) throw httpError(400, 'You cannot remove yourself. Ask another user of this dog house.');
  return inTransaction(async connection => {
    const users = await connection.query('SELECT id FROM users WHERE dog_house_id = ? FOR UPDATE', [dogHouseId]);
    if (!users.some(user => user.id === userId)) throw httpError(404, 'This user was not found.');
    if (users.length <= 1) throw httpError(400, 'A dog house needs at least one user.');
    await connection.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
    await connection.query('DELETE FROM users WHERE id = ? AND dog_house_id = ?', [userId, dogHouseId]);
  });
}
