import mariadb from 'mariadb';
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
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

const schema = [
  `CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(80) NOT NULL PRIMARY KEY,
    setting_value VARCHAR(255) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS dogs (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
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
  `CREATE TABLE IF NOT EXISTS meal_items (
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
    name VARCHAR(120) NOT NULL,
    saved_at VARCHAR(40) NULL,
    updated_at VARCHAR(40) NULL,
    dog_id VARCHAR(80) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS saved_plan_items (
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
  ['saved_plan_items', 'auto_fill', 'TINYINT(1) NOT NULL DEFAULT 0']
];

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
export async function replaceState(rawState, baseRevision = null) {
  const state = cleanState(rawState);
  const connection = await getConnection();
  try {
    await connection.beginTransaction();

    if (Number.isInteger(baseRevision)) {
      const [current] = await connection.query(
        "SELECT setting_value FROM app_settings WHERE setting_key = 'stateRevision' FOR UPDATE"
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
      for (const row of await connection.query('SELECT id, photo FROM dogs')) storedPhotos.set(row.id, row.photo);
    }
    if (state.foods.some(food => food.keepImage)) {
      for (const row of await connection.query('SELECT id, image FROM foods')) storedImages.set(row.id, row.image);
    }

    await connection.query('DELETE FROM saved_plan_items');
    await connection.query('DELETE FROM saved_plans');
    await connection.query('DELETE FROM weight_history');
    await connection.query('DELETE FROM meal_items');
    await connection.query('DELETE FROM dogs');
    await connection.query('DELETE FROM foods');
    await connection.query("DELETE FROM app_settings WHERE setting_key = 'selectedDog'");

    for (const dog of state.dogs) {
      await connection.query(
        `INSERT INTO dogs (id, name, weight, activity, life_stage, breed, gender, heat1, heat2, photo, desired_weight, meals_per_day, daily_energy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dog.id, dog.name, dog.weight, dog.activity, dog.lifeStage,
          dog.breed, dog.gender, dog.heat1, dog.heat2, dog.keepPhoto ? storedPhotos.get(dog.id) ?? null : dog.photo,
          dog.desiredWeight, dog.mealsPerDay, dog.dailyEnergy]
      );
    }

    for (const food of state.foods) {
      await connection.query(
        `INSERT INTO foods (id, name, category, kcal, protein, fat, fiber, image, manufacturer_url, shop_url, \`portion\`, \`stock\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [food.id, food.name, food.category, food.kcal, food.protein, food.fat, food.fiber,
          food.keepImage ? storedImages.get(food.id) ?? null : food.image, food.manufacturerUrl, food.shopUrl, food.portion, food.stock]
      );
    }

    for (const [dogId, items] of state.meals) {
      for (const [position, item] of items.entries()) {
        await connection.query(
          'INSERT INTO meal_items (dog_id, position, food_id, grams, auto_fill) VALUES (?, ?, ?, ?, ?)',
          [dogId, position, item.foodId, item.grams, item.auto]
        );
      }
    }

    for (const plan of state.savedPlans) {
      await connection.query(
        'INSERT INTO saved_plans (id, name, saved_at, updated_at, dog_id) VALUES (?, ?, ?, ?, ?)',
        [plan.id, plan.name, plan.savedAt, plan.updatedAt, plan.dogId]
      );
      for (const [position, item] of plan.items.entries()) {
        await connection.query(
          'INSERT INTO saved_plan_items (plan_id, position, food_id, grams, auto_fill) VALUES (?, ?, ?, ?, ?)',
          [plan.id, position, item.foodId, item.grams, item.auto]
        );
      }
    }

    for (const entry of state.weightHistory) {
      await connection.query(
        `INSERT INTO weight_history (id, dog_id, recorded_at, weight, desired_weight, daily_energy, daily_energy_custom)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.dogId, entry.date, entry.weight, entry.desiredWeight, entry.dailyEnergy, entry.dailyEnergyCustom]
      );
    }

    if (state.events) {
      await connection.query('DELETE FROM calendar_events');
      for (const event of state.events) {
        await connection.query(
          `INSERT INTO calendar_events (\`id\`, \`dog_id\`, \`description\`, \`location\`, \`starts_at\`, \`duration_minutes\`, \`url\`, \`repeat_kind\`, \`repeat_days\`, \`reminder_kind\`, \`reminder_days\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [event.id, event.dogId, event.description, event.location, event.start, event.duration, event.url, event.repeat, event.repeatDays, event.reminder, event.reminderDays]
        );
      }
    }

    if (state.selectedDog) {
      await connection.query(
        "INSERT INTO app_settings (setting_key, setting_value) VALUES ('selectedDog', ?)",
        [state.selectedDog]
      );
    }
    await connection.query(
      "INSERT INTO app_settings (setting_key, setting_value) VALUES ('hasApplicationState', '1') ON DUPLICATE KEY UPDATE setting_value = '1'"
    );
    // Every save gets a higher revision, so the browser can tell when it is shown older data.
    await connection.query(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES ('stateRevision', '1')
       ON DUPLICATE KEY UPDATE setting_value = CAST(setting_value AS UNSIGNED) + 1`
    );
    const [revisionRow] = await connection.query("SELECT setting_value FROM app_settings WHERE setting_key = 'stateRevision'");
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
    const rows = await connection.query(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'schemaInitialized'"
    );
    if (rows.length) return;
  } finally {
    connection.release();
  }

  const legacyState = await readLegacyState();
  if (legacyState) await replaceState(legacyState);
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES ('schemaInitialized', '1')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`
  );
  if (legacyState) console.log('Imported existing JSON application data into MariaDB.');
}

export async function readState() {
  const connection = await getConnection();
  try {
    const [dogs, foods, mealRows, plans, planRows, settings, weightRows, eventRows] = await Promise.all([
      connection.query('SELECT * FROM dogs ORDER BY name'),
      connection.query('SELECT * FROM foods ORDER BY name'),
      connection.query('SELECT * FROM meal_items ORDER BY dog_id, position'),
      connection.query('SELECT * FROM saved_plans ORDER BY name'),
      connection.query('SELECT * FROM saved_plan_items ORDER BY plan_id, position'),
      connection.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('selectedDog', 'hasApplicationState', 'stateRevision')"),
      connection.query('SELECT * FROM weight_history ORDER BY recorded_at'),
      connection.query('SELECT * FROM calendar_events ORDER BY `starts_at`')
    ]);

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
function pictureUrl(kind, id, value) {
  if (!value) return '';
  if (!value.startsWith('data:')) return value;
  const version = createHash('sha1').update(value).digest('hex').slice(0, 12);
  return `/api/pictures/${kind}/${encodeURIComponent(id)}?v=${version}`;
}

// A picture sent back as its own link means "unchanged", so the stored picture is kept instead of the link.
function isPictureLink(value, kind, id) {
  return typeof value === 'string' && value.startsWith(`/api/pictures/${kind}/${encodeURIComponent(id)}?`);
}

// Returns { type, data } for a stored dog photo or food picture, or null when there is none.
export async function readPicture(kind, id) {
  const [table, column] = kind === 'dog' ? ['dogs', 'photo'] : ['foods', 'image'];
  const connection = await getConnection();
  try {
    const [row] = await connection.query(`SELECT ${column} AS picture FROM ${table} WHERE id = ?`, [id]);
    // Only image types: anything else stored here is not served, so it can never run as a page on this address.
    const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.*)$/s.exec(row?.picture || '');
    return match ? { type: match[1], data: Buffer.from(match[2], 'base64') } : null;
  } finally {
    connection.release();
  }
}

let writeQueue = Promise.resolve();
export function writeState(state, baseRevision = null) {
  const write = writeQueue.then(() => replaceState(state, baseRevision));
  writeQueue = write.catch(() => {});
  return write;
}

export async function readRevision() {
  const rows = await pool.query("SELECT setting_value FROM app_settings WHERE setting_key = 'stateRevision'");
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

