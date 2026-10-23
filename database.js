import mariadb from 'mariadb';
import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: process.env.DOGGYFEED_ENV_FILE || '/etc/doggyfeed/doggyfeed.env' });

const root = path.dirname(fileURLToPath(import.meta.url));
const legacyStateFile = path.join(root, 'data', 'state.json');
const pool = mariadb.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME || 'doggyfeed',
  user: process.env.DB_USER || 'doggyfeed',
  password: process.env.DB_PASSWORD,
  connectionLimit: 5,
  decimalAsNumber: true
});

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
    heat2 VARCHAR(10) NULL
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

function validState(state) {
  return state && Array.isArray(state.dogs) && Array.isArray(state.foods) &&
    state.meals && typeof state.meals === 'object' && !Array.isArray(state.meals) &&
    Array.isArray(state.savedPlans);
}

async function replaceState(state) {
  const connection = await pool.getConnection();
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
        `INSERT INTO dogs (id, name, weight, activity, life_stage, breed, gender, heat1, heat2)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dog.id, dog.name, Number(dog.weight) || 0, Number(dog.activity) || 1.6,
          dog.age || 'Adult', dog.breed || null, dog.gender || null, dog.heat1 || null, dog.heat2 || null]
      );
    }

    for (const food of state.foods) {
      await connection.query(
        `INSERT INTO foods (id, name, category, kcal, protein, fat, fiber, image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [food.id, food.name, food.category || 'Other', Number(food.kcal) || 0,
          Number(food.protein) || 0, Number(food.fat) || 0, Number(food.fiber) || 0, food.image || null]
      );
    }

    for (const [dogId, items] of Object.entries(state.meals)) {
      for (const [position, item] of (items || []).entries()) {
        await connection.query(
          'INSERT INTO meal_items (dog_id, position, food_id, grams) VALUES (?, ?, ?, ?)',
          [dogId, position, item.foodId, Number(item.grams) || 0]
        );
      }
    }

    for (const plan of state.savedPlans) {
      await connection.query(
        'INSERT INTO saved_plans (id, name, saved_at, updated_at) VALUES (?, ?, ?, ?)',
        [plan.id, plan.name, plan.savedAt || null, plan.updatedAt || null]
      );
      for (const [position, item] of (plan.items || []).entries()) {
        await connection.query(
          'INSERT INTO saved_plan_items (plan_id, position, food_id, grams) VALUES (?, ?, ?, ?)',
          [plan.id, position, item.foodId, Number(item.grams) || 0]
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
    await connection.rollback();
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

  const connection = await pool.getConnection();
  try {
    for (const statement of schema) await connection.query(statement);
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
  const connection = await pool.getConnection();
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
      dogs: dogs.map(dog => ({
        id: dog.id, name: dog.name, weight: Number(dog.weight), activity: Number(dog.activity),
        age: dog.life_stage, breed: dog.breed || '', gender: dog.gender || '',
        heat1: dog.heat1 || '', heat2: dog.heat2 || ''
      })),
      foods: foods.map(food => ({
        id: food.id, name: food.name, category: food.category, kcal: Number(food.kcal),
        protein: Number(food.protein), fat: Number(food.fat), fiber: Number(food.fiber), image: food.image || ''
      })),
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
  const connection = await pool.getConnection();
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
          if (key === 'image' && typeof value === 'string' && value.startsWith('data:image/')) {
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
