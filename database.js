import mariadb from 'mariadb';
import dotenv from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// dotenv never overrides values that are already set, so the first file that defines a value wins.
// The project .env is a fallback for local development, for example on Windows where /etc does not exist.
if (process.env.DOGGYFEED_ENV_FILE) {
  dotenv.config({ path: process.env.DOGGYFEED_ENV_FILE });
} else {
  dotenv.config({ path: ['/etc/doggyfeed/doggyfeed.env', path.join(root, '.env')] });
}

const legacyStateFile = path.join(root, 'data', 'state.json');
export const pool = mariadb.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME || 'doggyfeed',
  user: process.env.DB_USER || 'doggyfeed',
  password: process.env.DB_PASSWORD,
  connectionLimit: 5,
  decimalAsNumber: true,
  // Fail with an error instead of waiting forever for a free connection or a blocked query.
  acquireTimeout: 15000,
  queryTimeout: 30000
});

export async function getConnection() {
  return pool.getConnection();
}

// Every row of app data belongs to one dog house (dog_house_id), and every read and write is limited to the dog
// house of the signed-in user. app_settings keys of a dog house are stored as "<dog house id>:<key>".
const schema = [
  `CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(80) NOT NULL PRIMARY KEY,
    setting_value VARCHAR(255) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS dog_house (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    contact VARCHAR(200) NULL,
    email VARCHAR(200) NULL,
    \`country\` VARCHAR(60) NULL,
    photo LONGTEXT NULL,
    created_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Usernames are stored in lower case and are unique across all dog houses, so signing in needs no dog house.
  // password_hash is an scrypt hash with its own salt; passwords are never stored.
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    dog_house_id VARCHAR(80) NOT NULL,
    username VARCHAR(80) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_admin TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY users_username (username),
    INDEX users_dog_house (dog_house_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Signed-in browsers. The cookie holds a random token; only its SHA-256 hash is stored here.
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    user_id VARCHAR(80) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    INDEX sessions_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS dogs (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    dog_house_id VARCHAR(80) NULL,
    name VARCHAR(100) NOT NULL,
    weight DECIMAL(8,2) NOT NULL,
    activity DECIMAL(5,2) NOT NULL,
    life_stage VARCHAR(30) NOT NULL,
    breed VARCHAR(120) NULL,
    gender VARCHAR(20) NULL,
    heat1 VARCHAR(10) NULL,
    heat2 VARCHAR(10) NULL,
    photo LONGTEXT NULL,
    desired_weight DECIMAL(8,2) NULL,
    meals_per_day INT NOT NULL DEFAULT 1,
    daily_energy DECIMAL(10,2) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS foods (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    dog_house_id VARCHAR(80) NULL,
    name VARCHAR(120) NOT NULL,
    category VARCHAR(50) NOT NULL,
    kcal DECIMAL(10,2) NOT NULL DEFAULT 0,
    protein DECIMAL(10,2) NOT NULL DEFAULT 0,
    fat DECIMAL(10,2) NOT NULL DEFAULT 0,
    fiber DECIMAL(10,2) NOT NULL DEFAULT 0,
    image LONGTEXT NULL,
    manufacturer_url VARCHAR(500) NULL,
    shop_url VARCHAR(500) NULL,
    \`portion\` DECIMAL(8,1) NULL,
    \`stock\` DECIMAL(10,2) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Global food library: foods shared by all dog houses, kept by administrators. Same columns as foods, without
  // dog_house_id (it belongs to no dog house) and stock (a dog house's own count), plus the country.
  `CREATE TABLE IF NOT EXISTS global_food_library (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    category VARCHAR(50) NOT NULL,
    kcal DECIMAL(10,2) NOT NULL DEFAULT 0,
    protein DECIMAL(10,2) NOT NULL DEFAULT 0,
    fat DECIMAL(10,2) NOT NULL DEFAULT 0,
    fiber DECIMAL(10,2) NOT NULL DEFAULT 0,
    image LONGTEXT NULL,
    manufacturer_url VARCHAR(500) NULL,
    shop_url VARCHAR(500) NULL,
    \`portion\` DECIMAL(8,1) NULL,
    \`country\` VARCHAR(60) NULL,
    updated_at DATETIME(3) NOT NULL,
    INDEX global_food_library_name (name),
    INDEX global_food_library_country (\`country\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Languages of the page texts, and every visible text per language, keyed by its English text. key_hash is the
  // MD5 of text_key, which keeps the key short enough for an index. modules/languages.js fills both at start.
  `CREATE TABLE IF NOT EXISTS languages (
    code VARCHAR(10) NOT NULL PRIMARY KEY,
    name VARCHAR(60) NOT NULL,
    native_name VARCHAR(60) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    enabled TINYINT(1) NOT NULL DEFAULT 1
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS translations (
    language_code VARCHAR(10) NOT NULL,
    key_hash CHAR(32) NOT NULL,
    text_key TEXT NOT NULL,
    translation TEXT NOT NULL,
    edited TINYINT(1) NOT NULL DEFAULT 0,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (language_code, key_hash),
    CONSTRAINT translations_language FOREIGN KEY (language_code) REFERENCES languages (code) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Countries a dog house can be in (ISO 3166-1 alpha-2 codes); modules/countries.js fills it while it is empty.
  `CREATE TABLE IF NOT EXISTS countries (
    code CHAR(2) NOT NULL PRIMARY KEY,
    name VARCHAR(100) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS meal_items (
    dog_house_id VARCHAR(80) NULL,
    dog_id VARCHAR(80) NOT NULL,
    position INT NOT NULL,
    food_id VARCHAR(80) NOT NULL,
    grams DECIMAL(10,2) NOT NULL DEFAULT 0,
    auto_fill TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (dog_id, position),
    INDEX meal_items_food_id (food_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS saved_plans (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    dog_house_id VARCHAR(80) NULL,
    name VARCHAR(120) NOT NULL,
    saved_at VARCHAR(40) NULL,
    updated_at VARCHAR(40) NULL,
    dog_id VARCHAR(80) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS saved_plan_items (
    dog_house_id VARCHAR(80) NULL,
    plan_id VARCHAR(80) NOT NULL,
    position INT NOT NULL,
    food_id VARCHAR(80) NOT NULL,
    grams DECIMAL(10,2) NOT NULL DEFAULT 0,
    auto_fill TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (plan_id, position),
    INDEX saved_plan_items_food_id (food_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS weight_history (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    dog_house_id VARCHAR(80) NULL,
    dog_id VARCHAR(80) NOT NULL,
    recorded_at VARCHAR(40) NOT NULL,
    weight DECIMAL(8,2) NOT NULL,
    desired_weight DECIMAL(8,2) NULL,
    daily_energy DECIMAL(10,2) NULL,
    daily_energy_custom TINYINT(1) NULL,
    INDEX weight_history_dog_id (dog_id, recorded_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Dog's calendar. dog_id is NULL for an event that is for all dogs. starts_at is local wall time
  // (YYYY-MM-DDTHH:MM), so an event keeps its time whatever the server's time zone. repeat_kind is none, daily,
  // weekly, yearly or custom (every repeat_days days). Names are quoted, as some are SQL keywords.
  `CREATE TABLE IF NOT EXISTS calendar_events (
    \`id\` VARCHAR(80) NOT NULL PRIMARY KEY,
    \`dog_house_id\` VARCHAR(80) NULL,
    \`dog_id\` VARCHAR(80) NULL,
    \`description\` VARCHAR(200) NOT NULL,
    \`location\` VARCHAR(200) NULL,
    \`starts_at\` VARCHAR(16) NOT NULL,
    \`duration_minutes\` INT NOT NULL DEFAULT 60,
    \`url\` VARCHAR(500) NULL,
    \`repeat_kind\` VARCHAR(10) NOT NULL DEFAULT 'none',
    \`repeat_days\` INT NULL,
    \`reminder_kind\` VARCHAR(10) NULL,
    \`reminder_days\` INT NULL,
    INDEX calendar_events_starts_at (\`starts_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Food served history. Rows are only added when a bowl is served and are not part of the
  // application data that every save replaces. Food details are copied so the history stays
  // correct after foods are edited or deleted.
  `CREATE TABLE IF NOT EXISTS served_meals (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    dog_house_id VARCHAR(80) NULL,
    dog_id VARCHAR(80) NOT NULL,
    dog_name VARCHAR(100) NOT NULL,
    served_at DATETIME(3) NOT NULL,
    plan_name VARCHAR(120) NULL,
    meals_per_day INT NULL,
    target_kcal DECIMAL(10,2) NULL,
    kcal DECIMAL(10,2) NOT NULL DEFAULT 0,
    protein DECIMAL(10,2) NOT NULL DEFAULT 0,
    fat DECIMAL(10,2) NOT NULL DEFAULT 0,
    fiber DECIMAL(10,2) NOT NULL DEFAULT 0,
    INDEX served_meals_dog_id (dog_id, served_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS served_meal_items (
    dog_house_id VARCHAR(80) NULL,
    served_meal_id VARCHAR(80) NOT NULL,
    position INT NOT NULL,
    food_id VARCHAR(80) NOT NULL,
    food_name VARCHAR(120) NOT NULL,
    category VARCHAR(50) NULL,
    grams DECIMAL(10,2) NOT NULL DEFAULT 0,
    kcal_per_100g DECIMAL(10,2) NOT NULL DEFAULT 0,
    kcal DECIMAL(10,2) NOT NULL DEFAULT 0,
    protein DECIMAL(10,2) NOT NULL DEFAULT 0,
    fat DECIMAL(10,2) NOT NULL DEFAULT 0,
    fiber DECIMAL(10,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (served_meal_id, position)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

// Columns added after the tables were first created. CREATE TABLE IF NOT EXISTS does not add
// them to an existing table, so they are added here when missing.
const laterColumns = [
  ['dogs', 'breed', 'VARCHAR(120) NULL'],
  ['dogs', 'gender', 'VARCHAR(20) NULL'],
  ['dogs', 'heat1', 'VARCHAR(10) NULL'],
  ['dogs', 'heat2', 'VARCHAR(10) NULL'],
  ['dogs', 'photo', 'LONGTEXT NULL'],
  ['dogs', 'desired_weight', 'DECIMAL(8,2) NULL'],
  ['dogs', 'meals_per_day', 'INT NOT NULL DEFAULT 1'],
  ['dogs', 'daily_energy', 'DECIMAL(10,2) NULL'],
  ['foods', 'image', 'LONGTEXT NULL'],
  ['foods', 'manufacturer_url', 'VARCHAR(500) NULL'],
  ['foods', 'shop_url', 'VARCHAR(500) NULL'],
  ['foods', 'portion', 'DECIMAL(8,1) NULL'],
  ['foods', 'stock', 'DECIMAL(10,2) NULL'],
  ['saved_plans', 'dog_id', 'VARCHAR(80) NULL'],
  ['served_meals', 'plan_name', 'VARCHAR(120) NULL'],
  ['weight_history', 'daily_energy', 'DECIMAL(10,2) NULL'],
  ['weight_history', 'daily_energy_custom', 'TINYINT(1) NULL'],
  ['calendar_events', 'reminder_kind', 'VARCHAR(10) NULL'],
  ['calendar_events', 'reminder_days', 'INT NULL'],
  ['meal_items', 'auto_fill', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['saved_plan_items', 'auto_fill', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ...dogHouseTables().map(table => [table, 'dog_house_id', 'VARCHAR(80) NULL']),
  ['users', 'is_admin', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['dog_house', 'photo', 'LONGTEXT NULL'],
  ['dog_house', 'country', 'VARCHAR(60) NULL']
];

// Tables whose rows belong to a dog house.
export function dogHouseTables() {
  return ['dogs', 'foods', 'meal_items', 'saved_plans', 'saved_plan_items', 'weight_history', 'calendar_events',
    'served_meals', 'served_meal_items'];
}

const houseKey = (dogHouseId, key) => `${dogHouseId}:${key}`;

// The oldest dog house, or a new one called "My dog house" when there is none yet.
export async function firstDogHouseId(connection) {
  const [house] = await connection.query('SELECT id FROM dog_house ORDER BY created_at, id LIMIT 1');
  if (house) return house.id;
  return createDogHouse(connection, { name: 'My dog house' });
}

export async function createDogHouse(connection, { name, contact = '', email = '', country = '' }) {
  const id = `house-${randomUUID()}`;
  await connection.query(
    'INSERT INTO dog_house (id, name, contact, email, `country`, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, text(name, 120) || 'My dog house', text(contact, 200) || null, text(email, 200) || null, text(country, 60) || null, new Date()]
  );
  return id;
}

// There is always an administrator once users exist: when none is left (for example users made before the admin
// role existed), the oldest user becomes one.
async function ensureAnAdmin(connection) {
  const [admins] = await connection.query('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1');
  if (Number(admins.count) > 0) return;
  const [oldest] = await connection.query('SELECT id, username FROM users ORDER BY created_at, id LIMIT 1');
  if (!oldest) return;
  await connection.query('UPDATE users SET is_admin = 1 WHERE id = ?', [oldest.id]);
  console.log(`${oldest.username} is now the DoggyFeed administrator.`);
}

// Data from before dog houses (rows without dog_house_id, and the settings selectedDog, hasApplicationState and
// stateRevision) is moved into the oldest dog house, which is created as "My dog house" when needed.
async function assignDataToDogHouse(connection) {
  let unassigned = false;
  for (const table of dogHouseTables()) {
    const [row] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE dog_house_id IS NULL`);
    if (Number(row.count) > 0) unassigned = true;
  }
  const legacySettings = await connection.query(
    "SELECT setting_key FROM app_settings WHERE setting_key IN ('selectedDog', 'hasApplicationState', 'stateRevision')"
  );
  if (!unassigned && !legacySettings.length) return;
  const dogHouseId = await firstDogHouseId(connection);
  for (const table of dogHouseTables()) {
    await connection.query(`UPDATE \`${table}\` SET dog_house_id = ? WHERE dog_house_id IS NULL`, [dogHouseId]);
  }
  for (const { setting_key: key } of legacySettings) {
    await connection.query(
      `INSERT INTO app_settings (setting_key, setting_value) SELECT ?, setting_value FROM app_settings WHERE setting_key = ?
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [houseKey(dogHouseId, key), key]
    );
    await connection.query('DELETE FROM app_settings WHERE setting_key = ?', [key]);
  }
  console.log(`Moved the existing DoggyFeed data into the dog house ${dogHouseId}.`);
}

async function addMissingColumns(connection) {
  const rows = await connection.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()`
  );
  const existing = new Set(rows.map(row => `${row.tableName}.${row.columnName}`.toLowerCase()));
  for (const [table, column, definition] of laterColumns) {
    if (existing.has(`${table}.${column}`)) continue;
    // Names in backticks: some column names, such as portion, are reserved words in MariaDB.
    await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`Added missing column ${table}.${column} to the database.`);
  }
}

// Convert database rows to the shape the browser app uses.
export function toDog(dog) {
  return {
    id: dog.id, name: dog.name, weight: Number(dog.weight), activity: Number(dog.activity),
    age: dog.life_stage, breed: dog.breed || '', gender: dog.gender || '',
    heat1: dog.heat1 || '', heat2: dog.heat2 || '', photo: dog.photo || '',
    desiredWeight: dog.desired_weight === null || dog.desired_weight === undefined ? '' : Number(dog.desired_weight),
    mealsPerDay: Number(dog.meals_per_day) || 1,
    dailyEnergy: dog.daily_energy === null || dog.daily_energy === undefined ? '' : Number(dog.daily_energy)
  };
}

export function toFood(food) {
  return {
    id: food.id, name: food.name, category: food.category, kcal: Number(food.kcal),
    protein: Number(food.protein), fat: Number(food.fat), fiber: Number(food.fiber), image: food.image || '',
    manufacturerUrl: food.manufacturer_url || '', shopUrl: food.shop_url || '',
    portion: food.portion === null || food.portion === undefined ? '' : Number(food.portion),
    stock: food.stock === null || food.stock === undefined ? '' : Number(food.stock)
  };
}

// How many pieces of a food are in stock, or null when its stock is not tracked.
export function stockCount(value) {
  if (value === '' || value === null || value === undefined) return null;
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(Math.max(Math.round(count * 100) / 100, 0), 99999999) : null;
}

// A food's usual portion in grams, or null when it has none.
export function portionGrams(value) {
  const grams = Number(value);
  return Number.isFinite(grams) && grams > 0 ? Math.min(Math.round(grams * 10) / 10, 9999999) : null;
}

function validState(state) {
  return state && Array.isArray(state.dogs) && Array.isArray(state.foods) &&
    state.meals && typeof state.meals === 'object' && !Array.isArray(state.meals) &&
    Array.isArray(state.savedPlans);
}

// Limits match the column sizes in the schema. Cleaning the data first keeps one bad or oversized
// value (for example from old browser storage) from making MariaDB reject the whole save.
function text(value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, maxLength);
}

// Only http and https links are stored, so a saved link can never run script when opened.
export function webUrl(value) {
  const textValue = String(value ?? '').trim();
  if (!textValue || textValue.length > 500) return null;
  try {
    const url = new URL(textValue);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href.slice(0, 500) : null;
  } catch {
    return null;
  }
}

function amount(value, fallback, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, 0), max) : fallback;
}

function uniqueById(items) {
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = text(item?.id, 80);
    if (id) byId.set(id, item);
  }
  return [...byId.entries()];
}

function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter(item => text(item?.foodId, 80))
    .map(item => ({ foodId: text(item.foodId, 80), grams: amount(item.grams, 0, 99999999), auto: item.auto === true ? 1 : 0 }));
}

function cleanState(state) {
  const meals = new Map();
  for (const [dogId, items] of Object.entries(state.meals)) {
    if (text(dogId, 80)) meals.set(text(dogId, 80), cleanItems(items));
  }
  return {
    dogs: uniqueById(state.dogs).map(([id, dog]) => ({
      id, name: text(dog.name, 100) || 'Dog', weight: amount(dog.weight, 0, 999999),
      activity: amount(dog.activity, 1.6, 999) || 1.6, lifeStage: text(dog.age, 30) || 'Adult',
      breed: text(dog.breed, 120), gender: text(dog.gender, 20), heat1: text(dog.heat1, 10), heat2: text(dog.heat2, 10),
      photo: text(dog.photo, Infinity), keepPhoto: dog.keepPhoto === true || isPictureLink(dog.photo, 'dog', id), desiredWeight: Number(dog.desiredWeight) > 0 ? amount(dog.desiredWeight, null, 999999) : null,
      mealsPerDay: Math.round(amount(dog.mealsPerDay, 1, 10)) || 1,
      dailyEnergy: Number(dog.dailyEnergy) > 0 ? amount(dog.dailyEnergy, null, 99999999) : null
    })),
    foods: uniqueById(state.foods).map(([id, food]) => ({
      id, name: text(food.name, 120) || 'Food', category: text(food.category, 50) || 'Other',
      kcal: amount(food.kcal, 0, 99999999), protein: amount(food.protein, 0, 99999999),
      fat: amount(food.fat, 0, 99999999), fiber: amount(food.fiber, 0, 99999999), image: text(food.image, Infinity),
      keepImage: food.keepImage === true || isPictureLink(food.image, 'food', id), manufacturerUrl: webUrl(food.manufacturerUrl), shopUrl: webUrl(food.shopUrl),
      portion: portionGrams(food.portion), stock: stockCount(food.stock)
    })),
    meals,
    savedPlans: uniqueById(state.savedPlans).map(([id, plan]) => ({
      id, name: text(plan.name, 120) || 'Plan', savedAt: text(plan.savedAt, 40), updatedAt: text(plan.updatedAt, 40),
      dogId: text(plan.dogId, 80), items: cleanItems(plan.items)
    })),
    weightHistory: uniqueById(state.weightHistory)
      .filter(([, entry]) => text(entry.dogId, 80) && text(entry.date, 40) && Number(entry.weight) > 0)
      .map(([id, entry]) => ({
        id, dogId: text(entry.dogId, 80), date: text(entry.date, 40), weight: amount(entry.weight, 0, 999999),
        desiredWeight: Number(entry.desiredWeight) > 0 ? amount(entry.desiredWeight, null, 999999) : null,
        dailyEnergy: Number(entry.dailyEnergy) > 0 ? amount(entry.dailyEnergy, null, 99999999) : null,
        dailyEnergyCustom: Number(entry.dailyEnergy) > 0 ? (entry.dailyEnergyCustom ? 1 : 0) : null
      })),
    // null when the browser sent no events (a page from before the calendar), so stored events are kept.
    events: Array.isArray(state.events) ? uniqueById(state.events)
      .filter(([, event]) => text(event.description, 200) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(event.start || '')))
      .map(([id, event]) => {
        const repeat = ['daily', 'weekly', 'yearly', 'custom'].includes(event.repeat) ? event.repeat : 'none';
        const repeatDays = repeat === 'custom' ? Math.round(amount(event.repeatDays, 0, 3650)) : 0;
        // Reminder before the event: day, week, month, or custom (reminderDays days before).
        let reminder = ['day', 'week', 'month', 'custom'].includes(event.reminder) ? event.reminder : null;
        const reminderDays = reminder === 'custom' ? Math.round(amount(event.reminderDays, 0, 3650)) : 0;
        if (reminder === 'custom' && reminderDays < 1) reminder = null;
        return {
          reminder, reminderDays: reminder === 'custom' ? reminderDays : null,
          id, dogId: text(event.dogId, 80) || null, description: text(event.description, 200),
          location: text(event.location, 200) || null, start: String(event.start),
          duration: Math.round(amount(event.duration, 60, 525600)), url: webUrl(event.url),
          repeat: repeat === 'custom' && repeatDays < 1 ? 'none' : repeat, repeatDays: repeatDays >= 1 ? repeatDays : null
        };
      }) : null,
    selectedDog: text(state.selectedDog, 255)
  };
}

// baseRevision is the save number the browser's data was loaded from. Every save replaces all data, so a
// browser holding older data (another tab, computer or phone) would silently undo newer saves; such a save is
// refused instead. Leaving baseRevision out skips the check, for example to keep a version on purpose.
// Only the given dog house's rows are replaced; other dog houses are not touched.
export async function replaceState(dogHouseId, rawState, baseRevision = null) {
  if (!dogHouseId) throw new Error('A dog house is needed to save data.');
  const state = cleanState(rawState);
  const connection = await getConnection();
  try {
    await connection.beginTransaction();

    if (Number.isInteger(baseRevision)) {
      const [current] = await connection.query(
        'SELECT setting_value FROM app_settings WHERE setting_key = ? FOR UPDATE',
        [houseKey(dogHouseId, 'stateRevision')]
      );
      const currentRevision = Number(current?.setting_value) || 0;
      if (currentRevision !== baseRevision) {
        const error = new Error(
          `DoggyFeed was saved somewhere else (save #${currentRevision}) after this page loaded save #${baseRevision}.`
        );
        error.statusCode = 409;
        error.currentRevision = currentRevision;
        throw error;
      }
    }

    // The browser leaves out pictures that are already stored and marks them to keep.
    const storedPhotos = new Map();
    const storedImages = new Map();
    if (state.dogs.some(dog => dog.keepPhoto)) {
      for (const row of await connection.query('SELECT id, photo FROM dogs WHERE dog_house_id = ?', [dogHouseId])) storedPhotos.set(row.id, row.photo);
    }
    if (state.foods.some(food => food.keepImage)) {
      for (const row of await connection.query('SELECT id, image FROM foods WHERE dog_house_id = ?', [dogHouseId])) storedImages.set(row.id, row.image);
    }

    for (const table of ['saved_plan_items', 'saved_plans', 'weight_history', 'meal_items', 'dogs', 'foods']) {
      await connection.query(`DELETE FROM \`${table}\` WHERE dog_house_id = ?`, [dogHouseId]);
    }
    await connection.query('DELETE FROM app_settings WHERE setting_key = ?', [houseKey(dogHouseId, 'selectedDog')]);

    for (const dog of state.dogs) {
      await connection.query(
        `INSERT INTO dogs (id, dog_house_id, name, weight, activity, life_stage, breed, gender, heat1, heat2, photo, desired_weight, meals_per_day, daily_energy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dog.id, dogHouseId, dog.name, dog.weight, dog.activity, dog.lifeStage,
          dog.breed, dog.gender, dog.heat1, dog.heat2, dog.keepPhoto ? storedPhotos.get(dog.id) ?? null : dog.photo,
          dog.desiredWeight, dog.mealsPerDay, dog.dailyEnergy]
      );
    }

    for (const food of state.foods) {
      await connection.query(
        `INSERT INTO foods (id, dog_house_id, name, category, kcal, protein, fat, fiber, image, manufacturer_url, shop_url, \`portion\`, \`stock\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [food.id, dogHouseId, food.name, food.category, food.kcal, food.protein, food.fat, food.fiber,
          food.keepImage ? storedImages.get(food.id) ?? null : food.image, food.manufacturerUrl, food.shopUrl, food.portion, food.stock]
      );
    }

    for (const [dogId, items] of state.meals) {
      for (const [position, item] of items.entries()) {
        await connection.query(
          'INSERT INTO meal_items (dog_house_id, dog_id, position, food_id, grams, auto_fill) VALUES (?, ?, ?, ?, ?, ?)',
          [dogHouseId, dogId, position, item.foodId, item.grams, item.auto]
        );
      }
    }

    for (const plan of state.savedPlans) {
      await connection.query(
        'INSERT INTO saved_plans (id, dog_house_id, name, saved_at, updated_at, dog_id) VALUES (?, ?, ?, ?, ?, ?)',
        [plan.id, dogHouseId, plan.name, plan.savedAt, plan.updatedAt, plan.dogId]
      );
      for (const [position, item] of plan.items.entries()) {
        await connection.query(
          'INSERT INTO saved_plan_items (dog_house_id, plan_id, position, food_id, grams, auto_fill) VALUES (?, ?, ?, ?, ?, ?)',
          [dogHouseId, plan.id, position, item.foodId, item.grams, item.auto]
        );
      }
    }

    for (const entry of state.weightHistory) {
      await connection.query(
        `INSERT INTO weight_history (id, dog_house_id, dog_id, recorded_at, weight, desired_weight, daily_energy, daily_energy_custom)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, dogHouseId, entry.dogId, entry.date, entry.weight, entry.desiredWeight, entry.dailyEnergy, entry.dailyEnergyCustom]
      );
    }

    if (state.events) {
      await connection.query('DELETE FROM calendar_events WHERE dog_house_id = ?', [dogHouseId]);
      for (const event of state.events) {
        await connection.query(
          `INSERT INTO calendar_events (\`id\`, \`dog_house_id\`, \`dog_id\`, \`description\`, \`location\`, \`starts_at\`, \`duration_minutes\`, \`url\`, \`repeat_kind\`, \`repeat_days\`, \`reminder_kind\`, \`reminder_days\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [event.id, dogHouseId, event.dogId, event.description, event.location, event.start, event.duration, event.url, event.repeat, event.repeatDays, event.reminder, event.reminderDays]
        );
      }
    }

    if (state.selectedDog) {
      await connection.query(
        'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)',
        [houseKey(dogHouseId, 'selectedDog'), state.selectedDog]
      );
    }
    await connection.query(
      "INSERT INTO app_settings (setting_key, setting_value) VALUES (?, '1') ON DUPLICATE KEY UPDATE setting_value = '1'",
      [houseKey(dogHouseId, 'hasApplicationState')]
    );
    // Every save gets a higher revision, so the browser can tell when it is shown older data.
    await connection.query(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, '1')
       ON DUPLICATE KEY UPDATE setting_value = CAST(setting_value AS UNSIGNED) + 1`,
      [houseKey(dogHouseId, 'stateRevision')]
    );
    const [revisionRow] = await connection.query('SELECT setting_value FROM app_settings WHERE setting_key = ?', [houseKey(dogHouseId, 'stateRevision')]);
    await connection.commit();
    return {
      revision: Number(revisionRow?.setting_value) || 0,
      dogs: state.dogs.length,
      foods: state.foods.length,
      plans: state.savedPlans.length
    };
  } catch (error) {
    // A failed rollback (for example on a dropped connection) must not hide the original error.
    await connection.rollback().catch(rollbackError => console.error('Rollback failed:', rollbackError.message));
    throw error;
  } finally {
    connection.release();
  }
}

async function readLegacyState() {
  try {
    const state = JSON.parse(await readFile(legacyStateFile, 'utf8'));
    return validState(state) ? state : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function initializeDatabase() {
  if (!process.env.DB_PASSWORD) {
    throw new Error('DB_PASSWORD must be set in the environment or .env file.');
  }

  const connection = await getConnection();
  try {
    for (const statement of schema) await connection.query(statement);
    await addMissingColumns(connection);
    await assignDataToDogHouse(connection);
    await ensureAnAdmin(connection);
    const rows = await connection.query(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'schemaInitialized'"
    );
    if (rows.length) return;
  } finally {
    connection.release();
  }

  const legacyState = await readLegacyState();
  if (legacyState) {
    const connection = await getConnection();
    const dogHouseId = await firstDogHouseId(connection).finally(() => connection.release());
    await replaceState(dogHouseId, legacyState);
  }
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES ('schemaInitialized', '1')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`
  );
  if (legacyState) console.log('Imported existing JSON application data into MariaDB.');
}

// Returns the dog house's app data, or null when nothing has been saved for it yet.
export async function readState(dogHouseId) {
  const connection = await getConnection();
  try {
    const house = [dogHouseId];
    const [dogs, foods, mealRows, plans, planRows, settingRows, weightRows, eventRows] = await Promise.all([
      connection.query('SELECT * FROM dogs WHERE dog_house_id = ? ORDER BY name', house),
      connection.query('SELECT * FROM foods WHERE dog_house_id = ? ORDER BY name', house),
      connection.query('SELECT * FROM meal_items WHERE dog_house_id = ? ORDER BY dog_id, position', house),
      connection.query('SELECT * FROM saved_plans WHERE dog_house_id = ? ORDER BY name', house),
      connection.query('SELECT * FROM saved_plan_items WHERE dog_house_id = ? ORDER BY plan_id, position', house),
      connection.query('SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?, ?, ?)',
        ['selectedDog', 'hasApplicationState', 'stateRevision'].map(key => houseKey(dogHouseId, key))),
      connection.query('SELECT * FROM weight_history WHERE dog_house_id = ? ORDER BY recorded_at', house),
      connection.query('SELECT * FROM calendar_events WHERE dog_house_id = ? ORDER BY `starts_at`', house)
    ]);
    // Setting keys without the "<dog house id>:" prefix.
    const settings = settingRows.map(row => ({ ...row, setting_key: row.setting_key.slice(dogHouseId.length + 1) }));

    if (!settings.some(setting => setting.setting_key === 'hasApplicationState')) return null;

    const meals = {};
    for (const row of mealRows) {
      meals[row.dog_id] ||= [];
      meals[row.dog_id].push({ foodId: row.food_id, grams: Number(row.grams), auto: Boolean(row.auto_fill) });
    }
    for (const dog of dogs) meals[dog.id] ||= [];

    const planItems = new Map(plans.map(plan => [plan.id, []]));
    for (const row of planRows) {
      planItems.get(row.plan_id)?.push({ foodId: row.food_id, grams: Number(row.grams), auto: Boolean(row.auto_fill) });
    }

    return {
      dogs: dogs.map(dog => ({ ...toDog(dog), photo: pictureUrl('dog', dog.id, dog.photo) })),
      foods: foods.map(food => ({ ...toFood(food), image: pictureUrl('food', food.id, food.image) })),
      meals,
      savedPlans: plans.map(plan => ({
        id: plan.id, name: plan.name, savedAt: plan.saved_at, updatedAt: plan.updated_at, dogId: plan.dog_id || '',
        items: planItems.get(plan.id) || []
      })),
      weightHistory: weightRows.map(row => ({
        id: row.id, dogId: row.dog_id, date: row.recorded_at, weight: Number(row.weight),
        desiredWeight: row.desired_weight === null || row.desired_weight === undefined ? null : Number(row.desired_weight),
        dailyEnergy: row.daily_energy === null || row.daily_energy === undefined ? null : Number(row.daily_energy),
        dailyEnergyCustom: Boolean(row.daily_energy_custom)
      })),
      events: eventRows.map(row => ({
        id: row.id, dogId: row.dog_id || '', description: row.description, location: row.location || '',
        start: row.starts_at, duration: Number(row.duration_minutes) || 0, url: row.url || '',
        repeat: row.repeat_kind || 'none', repeatDays: row.repeat_days === null || row.repeat_days === undefined ? '' : Number(row.repeat_days),
        reminder: row.reminder_kind || '', reminderDays: row.reminder_days === null || row.reminder_days === undefined ? '' : Number(row.reminder_days)
      })),
      selectedDog: settings.find(setting => setting.setting_key === 'selectedDog')?.setting_value || '',
      revision: Number(settings.find(setting => setting.setting_key === 'stateRevision')?.setting_value) || 0
    };
  } finally {
    connection.release();
  }
}

// The app data carries links to the pictures instead of the pictures themselves, so it stays a few KB instead of
// several MB; a large answer is more likely to stall on an unsteady connection such as a phone's first one. The
// version is a hash of the picture, so a changed picture gets a new link and browsers can cache each link for good.
// A save that leaves a picture unchanged sends it back with keepPhoto/keepImage, so the stored picture stays.
export function pictureUrl(kind, id, value) {
  if (!value) return '';
  if (!value.startsWith('data:')) return value;
  const version = createHash('sha1').update(value).digest('hex').slice(0, 12);
  return `/api/pictures/${kind}/${encodeURIComponent(id)}?v=${version}`;
}

// A picture sent back as its own link means "unchanged", so the stored picture is kept instead of the link.
function isPictureLink(value, kind, id) {
  return typeof value === 'string' && value.startsWith(`/api/pictures/${kind}/${encodeURIComponent(id)}?`);
}

// Returns { type, data } for a stored dog photo, food picture or dog house photo, or null when there is none. A dog
// house photo is only given to users of that dog house.
export async function readPicture(dogHouseId, kind, id) {
  const connection = await getConnection();
  try {
    // Global food library pictures are shared by all dog houses, so any signed-in user may load them.
    const [row] = kind === 'house'
      ? await connection.query('SELECT photo AS picture FROM dog_house WHERE id = ? AND id = ?', [id, dogHouseId])
      : kind === 'global'
        ? await connection.query('SELECT image AS picture FROM global_food_library WHERE id = ?', [id])
        : await connection.query(`SELECT ${kind === 'dog' ? 'photo' : 'image'} AS picture FROM ${kind === 'dog' ? 'dogs' : 'foods'} WHERE id = ? AND dog_house_id = ?`, [id, dogHouseId]);
    // Only image types: anything else stored here is not served, so it can never run as a page on this address.
    const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.*)$/s.exec(row?.picture || '');
    return match ? { type: match[1], data: Buffer.from(match[2], 'base64') } : null;
  } finally {
    connection.release();
  }
}

let writeQueue = Promise.resolve();
export function writeState(dogHouseId, state, baseRevision = null) {
  const write = writeQueue.then(() => replaceState(dogHouseId, state, baseRevision));
  writeQueue = write.catch(() => {});
  return write;
}

export async function readRevision(dogHouseId) {
  const rows = await pool.query('SELECT setting_value FROM app_settings WHERE setting_key = ?', [houseKey(dogHouseId, 'stateRevision')]);
  return Number(rows[0]?.setting_value) || 0;
}

export async function readDatabaseDiagnostics() {
  const connection = await getConnection();
  try {
    const [{ databaseName }] = await connection.query('SELECT DATABASE() AS databaseName');
    const tableRows = await connection.query(
      `SELECT TABLE_NAME AS tableName
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`
    );
    const tables = [];

    for (const { tableName } of tableRows) {
      const identifier = `\`${tableName.replaceAll('`', '``')}\``;
      const columns = await connection.query(
        `SELECT COLUMN_NAME AS columnName
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [tableName]
      );
      const [{ rowCount }] = await connection.query(`SELECT COUNT(*) AS rowCount FROM ${identifier}`);
      const rows = await connection.query(`SELECT * FROM ${identifier} ORDER BY 1`);
      tables.push({
        name: tableName,
        rowCount: Number(rowCount),
        columns: columns.map(column => column.columnName),
        rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
          // Password hashes and session tokens are never shown, not even on this local page.
          if (key === 'password_hash' || key === 'token_hash') return [key, '(hidden)'];
          if ((key === 'image' || key === 'photo') && typeof value === 'string' && value.startsWith('data:image/')) {
            return [key, {
              type: 'image',
              preview: value,
              sizeBytes: Buffer.byteLength(value, 'utf8')
            }];
          }
          if (Buffer.isBuffer(value)) return [key, { type: 'binary', sizeBytes: value.length }];
          return [key, value];
        })))
      });
    }

    return { databaseName, tables };
  } finally {
    connection.release();
  }
}

export async function closeDatabase() {
  await pool.end();
}

