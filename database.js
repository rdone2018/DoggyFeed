import mariadb from 'mariadb';
import dotenv from 'dotenv';
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
  decimalAsNumber: true
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
    meals_per_day INT NOT NULL DEFAULT 1
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS foods (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    category VARCHAR(50) NOT NULL,
    kcal DECIMAL(10,2) NOT NULL DEFAULT 0,
    protein DECIMAL(10,2) NOT NULL DEFAULT 0,
    fat DECIMAL(10,2) NOT NULL DEFAULT 0,
    fiber DECIMAL(10,2) NOT NULL DEFAULT 0,
    image LONGTEXT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS meal_items (
    dog_id VARCHAR(80) NOT NULL,
    position INT NOT NULL,
    food_id VARCHAR(80) NOT NULL,
    grams DECIMAL(10,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (dog_id, position),
    INDEX meal_items_food_id (food_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS saved_plans (
    id VARCHAR(80) NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    saved_at VARCHAR(40) NULL,
    updated_at VARCHAR(40) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS saved_plan_items (
    plan_id VARCHAR(80) NOT NULL,
    position INT NOT NULL,
    food_id VARCHAR(80) NOT NULL,
    grams DECIMAL(10,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (plan_id, position),
    INDEX saved_plan_items_food_id (food_id)
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
  ['foods', 'image', 'LONGTEXT NULL']
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
    await connection.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    mealsPerDay: Number(dog.meals_per_day) || 1
  };
}

export function toFood(food) {
  return {
    id: food.id, name: food.name, category: food.category, kcal: Number(food.kcal),
    protein: Number(food.protein), fat: Number(food.fat), fiber: Number(food.fiber), image: food.image || ''
  };
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
    .map(item => ({ foodId: text(item.foodId, 80), grams: amount(item.grams, 0, 99999999) }));
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
      photo: text(dog.photo, Infinity), desiredWeight: Number(dog.desiredWeight) > 0 ? amount(dog.desiredWeight, null, 999999) : null,
      mealsPerDay: Math.round(amount(dog.mealsPerDay, 1, 10)) || 1
    })),
    foods: uniqueById(state.foods).map(([id, food]) => ({
      id, name: text(food.name, 120) || 'Food', category: text(food.category, 50) || 'Other',
      kcal: amount(food.kcal, 0, 99999999), protein: amount(food.protein, 0, 99999999),
      fat: amount(food.fat, 0, 99999999), fiber: amount(food.fiber, 0, 99999999), image: text(food.image, Infinity)
    })),
    meals,
    savedPlans: uniqueById(state.savedPlans).map(([id, plan]) => ({
      id, name: text(plan.name, 120) || 'Plan', savedAt: text(plan.savedAt, 40), updatedAt: text(plan.updatedAt, 40),
      items: cleanItems(plan.items)
    })),
    selectedDog: text(state.selectedDog, 255)
  };
}

export async function replaceState(rawState) {
  const state = cleanState(rawState);
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM saved_plan_items');
    await connection.query('DELETE FROM saved_plans');
    await connection.query('DELETE FROM meal_items');
    await connection.query('DELETE FROM dogs');
    await connection.query('DELETE FROM foods');
    await connection.query("DELETE FROM app_settings WHERE setting_key = 'selectedDog'");

    for (const dog of state.dogs) {
      await connection.query(
        `INSERT INTO dogs (id, name, weight, activity, life_stage, breed, gender, heat1, heat2, photo, desired_weight, meals_per_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dog.id, dog.name, dog.weight, dog.activity, dog.lifeStage,
          dog.breed, dog.gender, dog.heat1, dog.heat2, dog.photo, dog.desiredWeight, dog.mealsPerDay]
      );
    }

    for (const food of state.foods) {
      await connection.query(
        `INSERT INTO foods (id, name, category, kcal, protein, fat, fiber, image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [food.id, food.name, food.category, food.kcal, food.protein, food.fat, food.fiber, food.image]
      );
    }

    for (const [dogId, items] of state.meals) {
      for (const [position, item] of items.entries()) {
        await connection.query(
          'INSERT INTO meal_items (dog_id, position, food_id, grams) VALUES (?, ?, ?, ?)',
          [dogId, position, item.foodId, item.grams]
        );
      }
    }

    for (const plan of state.savedPlans) {
      await connection.query(
        'INSERT INTO saved_plans (id, name, saved_at, updated_at) VALUES (?, ?, ?, ?)',
        [plan.id, plan.name, plan.savedAt, plan.updatedAt]
      );
      for (const [position, item] of plan.items.entries()) {
        await connection.query(
          'INSERT INTO saved_plan_items (plan_id, position, food_id, grams) VALUES (?, ?, ?, ?)',
          [plan.id, position, item.foodId, item.grams]
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
    await connection.commit();
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
    const [dogs, foods, mealRows, plans, planRows, settings] = await Promise.all([
      connection.query('SELECT * FROM dogs ORDER BY name'),
      connection.query('SELECT * FROM foods ORDER BY name'),
      connection.query('SELECT * FROM meal_items ORDER BY dog_id, position'),
      connection.query('SELECT * FROM saved_plans ORDER BY name'),
      connection.query('SELECT * FROM saved_plan_items ORDER BY plan_id, position'),
      connection.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('selectedDog', 'hasApplicationState')")
    ]);

    if (!settings.some(setting => setting.setting_key === 'hasApplicationState')) return null;

    const meals = {};
    for (const row of mealRows) {
      meals[row.dog_id] ||= [];
      meals[row.dog_id].push({ foodId: row.food_id, grams: Number(row.grams) });
    }
    for (const dog of dogs) meals[dog.id] ||= [];

    const planItems = new Map(plans.map(plan => [plan.id, []]));
    for (const row of planRows) {
      planItems.get(row.plan_id)?.push({ foodId: row.food_id, grams: Number(row.grams) });
    }

    return {
      dogs: dogs.map(toDog),
      foods: foods.map(toFood),
      meals,
      savedPlans: plans.map(plan => ({
        id: plan.id, name: plan.name, savedAt: plan.saved_at, updatedAt: plan.updated_at,
        items: planItems.get(plan.id) || []
      })),
      selectedDog: settings.find(setting => setting.setting_key === 'selectedDog')?.setting_value || ''
    };
  } finally {
    connection.release();
  }
}

let writeQueue = Promise.resolve();
export function writeState(state) {
  const write = writeQueue.then(() => replaceState(state));
  writeQueue = write.catch(() => {});
  return write;
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

