import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createDogHouse, dogHouseTables, firstDogHouseId, getConnection } from '../database.js';

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

async function insertUser(connection, dogHouseId, username, password, isAdmin = false) {
  const name = normalUsername(username);
  const problem = usernameProblem(name) || passwordProblem(password);
  if (problem) throw httpError(400, problem);
  const id = `user-${randomUUID()}`;
  try {
    await connection.query(
      'INSERT INTO users (id, dog_house_id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, dogHouseId, name, await hashPassword(password), isAdmin ? 1 : 0, new Date()]
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw httpError(409, `The username ${name} is already taken.`);
    throw error;
  }
  return id;
}

// The country is changed only when it is sent, so a form without it keeps the stored country.
function houseFields(fields) {
  const house = { name: clean(fields.name, 120), contact: clean(fields.contact, 200), email: clean(fields.email, 200),
    country: 'country' in fields ? clean(fields.country, 60) : undefined };
  if (!house.name) throw httpError(400, 'Give the dog house a name.');
  const problem = emailProblem(house.email);
  if (problem) throw httpError(400, problem);
  return house;
}

const countryColumn = house => house.country === undefined ? '' : ', `country` = ?';
const countryValue = house => house.country === undefined ? [] : [house.country || null];

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
export async function setUpFirstUser({ houseName, contact, email, country, username, password }) {
  return inTransaction(async connection => {
    const [row] = await connection.query('SELECT COUNT(*) AS count FROM users FOR UPDATE');
    if (Number(row.count) > 0) throw httpError(409, 'DoggyFeed is already set up. Sign in instead.');
    const dogHouseId = await firstDogHouseId(connection);
    const house = houseFields({ name: houseName, contact, email, country });
    await connection.query(`UPDATE dog_house SET name = ?, contact = ?, email = ?${countryColumn(house)} WHERE id = ?`,
      [house.name, house.contact || null, house.email || null, ...countryValue(house), dogHouseId]);
    // The first user is the administrator.
    return insertUser(connection, dogHouseId, username, password, true);
  });
}

// A new dog house with its first user. Its data starts empty. A taken username gets the same general answer as
// other details that cannot be used, and costs the same password hashing, so the form cannot be used to find out
// which usernames exist.
export const SIGNUP_REFUSED = 'The dog house could not be created with these details. Try a different username.';
export async function createDogHouseWithUser({ houseName, contact, email, country, username, password }) {
  try {
    return await inTransaction(async connection => {
      const house = houseFields({ name: houseName, contact, email, country });
      const problem = usernameProblem(normalUsername(username)) || passwordProblem(password);
      if (problem) throw httpError(400, problem);
      const dogHouseId = await createDogHouse(connection, house);
      return await insertUser(connection, dogHouseId, username, password);
    });
  } catch (error) {
    if (error.statusCode === 409) throw httpError(400, SIGNUP_REFUSED);
    throw error;
  }
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
      `SELECT s.token_hash, s.expires_at, u.id AS user_id, u.username, u.is_admin, h.id AS house_id, h.name, h.contact, h.email, h.\`country\`
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
      user: { id: row.user_id, username: row.username, isAdmin: Boolean(row.is_admin) },
      house: { id: row.house_id, name: row.name, contact: row.contact || '', email: row.email || '', country: row.country || '' }
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
    const [house] = await connection.query('SELECT id, name, contact, email, `country`, MD5(photo) AS photo_version, created_at FROM dog_house WHERE id = ?', [dogHouseId]);
    if (!house) throw httpError(404, 'This dog house was not found.');
    const users = await connection.query('SELECT id, username, is_admin, created_at FROM users WHERE dog_house_id = ? ORDER BY username', [dogHouseId]);
    return {
      id: house.id, name: house.name, contact: house.contact || '', email: house.email || '', country: house.country || '',
      photo: housePhotoLink(house.id, house.photo_version),
      createdAt: new Date(house.created_at).toISOString(),
      users: users.map(user => ({ id: user.id, username: user.username, isAdmin: Boolean(user.is_admin), createdAt: new Date(user.created_at).toISOString() }))
    };
  } finally {
    connection.release();
  }
}

// The dog house photo is served like dog and food pictures, from a link carrying the photo's version (an MD5 the
// database works out), so browsers can cache it and fetch a changed photo under its new link.
const housePhotoLink = (dogHouseId, version) => version ? `/api/pictures/house/${encodeURIComponent(dogHouseId)}?v=${String(version).slice(0, 12)}` : '';

export async function readHousePhotoLink(dogHouseId) {
  const connection = await getConnection();
  try {
    const [row] = await connection.query('SELECT MD5(photo) AS photo_version FROM dog_house WHERE id = ?', [dogHouseId]);
    return housePhotoLink(dogHouseId, row?.photo_version);
  } finally {
    connection.release();
  }
}

export const MAX_HOUSE_PHOTO_BYTES = 6 * 1024 * 1024;

// Saves the profile. photo is a new picture as a JPEG, PNG or WebP data URL; removePhoto: true deletes the photo;
// without either, the stored photo stays.
export async function updateDogHouse(dogHouseId, fields) {
  const house = houseFields(fields);
  let photo;
  if (fields.removePhoto === true) {
    photo = null;
  } else if (typeof fields.photo === 'string' && fields.photo) {
    if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(fields.photo)) throw httpError(400, 'Choose a JPG, PNG or WebP picture.');
    if (fields.photo.length > MAX_HOUSE_PHOTO_BYTES) throw httpError(413, 'The photo is too large. Choose a smaller picture.');
    photo = fields.photo;
  }
  const connection = await getConnection();
  try {
    await connection.query(
      `UPDATE dog_house SET name = ?, contact = ?, email = ?${countryColumn(house)}${photo === undefined ? '' : ', photo = ?'} WHERE id = ?`,
      [house.name, house.contact || null, house.email || null, ...countryValue(house), ...(photo === undefined ? [] : [photo]), dogHouseId]
    );
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
    if (await isLastAdmin(connection, userId)) throw httpError(400, 'This is the only administrator of DoggyFeed, so it cannot be removed.');
    await connection.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
    await connection.query('DELETE FROM users WHERE id = ? AND dog_house_id = ?', [userId, dogHouseId]);
  });
}

// Administration of all dog houses and users, for users with is_admin (the routes check that). An administrator
// cannot delete or demote themselves or delete their own dog house, and DoggyFeed always keeps one administrator.

async function isLastAdmin(connection, userId) {
  const admins = await connection.query('SELECT id FROM users WHERE is_admin = 1 FOR UPDATE');
  return admins.length === 1 && admins[0].id === userId;
}

async function requireDogHouse(connection, dogHouseId) {
  const [house] = await connection.query('SELECT id, name FROM dog_house WHERE id = ? FOR UPDATE', [dogHouseId]);
  if (!house) throw httpError(404, 'This dog house was not found.');
  return house;
}

// Every dog house with how much data it holds, and every user with their dog house.
export async function adminOverview() {
  const connection = await getConnection();
  try {
    const houses = await connection.query('SELECT id, name, contact, email, `country`, created_at FROM dog_house ORDER BY name, created_at');
    const users = await connection.query(
      `SELECT u.id, u.username, u.is_admin, u.created_at, u.dog_house_id, h.name AS house_name
       FROM users u LEFT JOIN dog_house h ON h.id = u.dog_house_id ORDER BY u.username`
    );
    const counts = new Map(houses.map(house => [house.id, {}]));
    for (const [key, table] of [['dogs', 'dogs'], ['foods', 'foods'], ['plans', 'saved_plans'], ['weights', 'weight_history'],
      ['events', 'calendar_events'], ['servedBowls', 'served_meals']]) {
      for (const row of await connection.query(`SELECT dog_house_id, COUNT(*) AS count FROM \`${table}\` GROUP BY dog_house_id`)) {
        const houseCounts = counts.get(row.dog_house_id);
        if (houseCounts) houseCounts[key] = Number(row.count);
      }
    }
    return {
      houses: houses.map(house => ({
        id: house.id, name: house.name, contact: house.contact || '', email: house.email || '', country: house.country || '',
        createdAt: new Date(house.created_at).toISOString(),
        counts: { users: users.filter(user => user.dog_house_id === house.id).length, ...counts.get(house.id) }
      })),
      users: users.map(user => ({
        id: user.id, username: user.username, isAdmin: Boolean(user.is_admin), createdAt: new Date(user.created_at).toISOString(),
        houseId: user.dog_house_id, houseName: user.house_name || ''
      }))
    };
  } finally {
    connection.release();
  }
}

export async function adminCreateDogHouse(fields) {
  return inTransaction(connection => createDogHouse(connection, houseFields(fields)));
}

export async function adminUpdateDogHouse(dogHouseId, fields) {
  const house = houseFields(fields);
  return inTransaction(async connection => {
    await requireDogHouse(connection, dogHouseId);
    await connection.query(`UPDATE dog_house SET name = ?, contact = ?, email = ?${countryColumn(house)} WHERE id = ?`,
      [house.name, house.contact || null, house.email || null, ...countryValue(house), dogHouseId]);
  });
}

// Deletes a dog house with all its data (dogs, foods, bowls, plans, weight history, calendar, served bowls and
// settings) and its users. confirmName must be the dog house's name, as a guard against deleting the wrong one.
export async function adminDeleteDogHouse(dogHouseId, confirmName, currentHouseId) {
  if (dogHouseId === currentHouseId) throw httpError(400, 'You cannot delete your own dog house. Move your user to another dog house first.');
  return inTransaction(async connection => {
    const house = await requireDogHouse(connection, dogHouseId);
    if (clean(confirmName, 120) !== house.name) throw httpError(400, 'Type the dog house name exactly as shown to delete it.');
    const [otherAdmins] = await connection.query('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1 AND dog_house_id <> ?', [dogHouseId]);
    if (Number(otherAdmins.count) === 0) throw httpError(400, 'This dog house has the only administrator of DoggyFeed, so it cannot be deleted.');
    for (const table of dogHouseTables()) {
      await connection.query(`DELETE FROM \`${table}\` WHERE dog_house_id = ?`, [dogHouseId]);
    }
    await connection.query('DELETE FROM app_settings WHERE LEFT(setting_key, ?) = ?', [dogHouseId.length + 1, `${dogHouseId}:`]);
    await connection.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE dog_house_id = ?)', [dogHouseId]);
    await connection.query('DELETE FROM users WHERE dog_house_id = ?', [dogHouseId]);
    await connection.query('DELETE FROM dog_house WHERE id = ?', [dogHouseId]);
    return house.name;
  });
}

export async function adminAddUser({ houseId, username, password, isAdmin }) {
  return inTransaction(async connection => {
    await requireDogHouse(connection, houseId);
    return insertUser(connection, houseId, username, password, isAdmin === true);
  });
}

async function requireUser(connection, userId) {
  const [user] = await connection.query('SELECT id, username, dog_house_id, is_admin FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!user) throw httpError(404, 'This user was not found.');
  return user;
}

// Sets a new password and signs the user out everywhere, except in the administrator's own browser.
export async function adminSetPassword(userId, password, keepToken) {
  const problem = passwordProblem(password);
  if (problem) throw httpError(400, problem);
  return inTransaction(async connection => {
    await requireUser(connection, userId);
    await connection.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), userId]);
    await connection.query('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, keepToken ? tokenHash(keepToken) : '']);
  });
}

export async function adminSetAdmin(userId, isAdmin, currentUserId) {
  if (!isAdmin && userId === currentUserId) throw httpError(400, 'You cannot remove your own administrator rights.');
  return inTransaction(async connection => {
    await requireUser(connection, userId);
    if (!isAdmin && await isLastAdmin(connection, userId)) throw httpError(400, 'DoggyFeed needs at least one administrator.');
    await connection.query('UPDATE users SET is_admin = ? WHERE id = ?', [isAdmin ? 1 : 0, userId]);
  });
}

// Moves a user to another dog house. They are signed out, so their next sign-in opens the new dog house; an
// administrator moving themselves stays signed in.
export async function adminMoveUser(userId, dogHouseId, currentUserId) {
  return inTransaction(async connection => {
    await requireUser(connection, userId);
    await requireDogHouse(connection, dogHouseId);
    await connection.query('UPDATE users SET dog_house_id = ? WHERE id = ?', [dogHouseId, userId]);
    if (userId !== currentUserId) await connection.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
  });
}

export async function adminDeleteUser(userId, currentUserId) {
  if (userId === currentUserId) throw httpError(400, 'You cannot delete yourself.');
  return inTransaction(async connection => {
    await requireUser(connection, userId);
    if (await isLastAdmin(connection, userId)) throw httpError(400, 'DoggyFeed needs at least one administrator.');
    await connection.query('DELETE FROM sessions WHERE user_id = ?', [userId]);
    await connection.query('DELETE FROM users WHERE id = ?', [userId]);
  });
}
