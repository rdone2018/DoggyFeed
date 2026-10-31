import { randomUUID } from 'node:crypto';
import { getConnection, portionGrams, webUrl } from '../database.js';

// Global food library: foods shared by all dog houses, kept by administrators from the Admin page. The routes
// check the administrator rights. Pictures are not part of the list; each food carries a versioned link instead.

export const CATEGORIES = ['Dry food', 'Wet food', 'Protein', 'Produce', 'Dairy', 'Treat', 'Other'];
export const MAX_IMPORT_ROWS = 5000;
const MAX_PICTURE_BYTES = 3 * 1024 * 1024;

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const clean = (value, maxLength) => String(value ?? '').trim().slice(0, maxLength);
const nutrient = value => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number * 100) / 100, 0), 10000) : 0;
};

const pictureLink = (id, version) => version ? `/api/pictures/global/${encodeURIComponent(id)}?v=${String(version).slice(0, 12)}` : '';

const toFood = row => ({
  id: row.id, name: row.name, category: row.category, country: row.country || '',
  kcal: Number(row.kcal), protein: Number(row.protein), fat: Number(row.fat), fiber: Number(row.fiber),
  portion: row.portion === null || row.portion === undefined ? '' : Number(row.portion),
  manufacturerUrl: row.manufacturer_url || '', shopUrl: row.shop_url || '',
  image: pictureLink(row.id, row.image_version), updatedAt: new Date(row.updated_at).toISOString()
});

// The values of a food from the Admin page or a CSV row, checked and limited like the dog houses' foods.
function foodFields(food) {
  const fields = {
    name: clean(food.name, 120), category: CATEGORIES.includes(food.category) ? food.category : 'Other',
    country: clean(food.country, 60) || null,
    kcal: nutrient(food.kcal), protein: nutrient(food.protein), fat: nutrient(food.fat), fiber: nutrient(food.fiber),
    portion: portionGrams(food.portion), manufacturerUrl: webUrl(food.manufacturerUrl), shopUrl: webUrl(food.shopUrl)
  };
  if (!fields.name) throw httpError(400, 'Give the food a name.');
  return fields;
}

export async function listGlobalFoods() {
  const connection = await getConnection();
  try {
    const rows = await connection.query(
      `SELECT id, name, category, kcal, protein, fat, fiber, manufacturer_url, shop_url, \`portion\`, \`country\`,
       MD5(image) AS image_version, updated_at FROM global_food_library ORDER BY name, \`country\``
    );
    return rows.map(toFood);
  } finally {
    connection.release();
  }
}

// Adds a food, or changes it when its id exists. image is a new JPEG, PNG or WebP data URL; removeImage: true
// deletes the picture; without either the stored picture stays.
export async function saveGlobalFood(food) {
  const fields = foodFields(food || {});
  let image;
  if (food.removeImage === true) {
    image = null;
  } else if (typeof food.image === 'string' && food.image.startsWith('data:')) {
    if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(food.image)) throw httpError(400, 'Choose a JPG, PNG or WebP picture.');
    if (food.image.length > MAX_PICTURE_BYTES) throw httpError(413, 'The picture is too large. Choose a smaller one.');
    image = food.image;
  }
  const values = [fields.name, fields.category, fields.kcal, fields.protein, fields.fat, fields.fiber,
    fields.manufacturerUrl, fields.shopUrl, fields.portion, fields.country, new Date()];
  const connection = await getConnection();
  try {
    const id = clean(food.id, 80);
    if (id) {
      const result = await connection.query(
        `UPDATE global_food_library SET name = ?, category = ?, kcal = ?, protein = ?, fat = ?, fiber = ?,
         manufacturer_url = ?, shop_url = ?, \`portion\` = ?, \`country\` = ?, updated_at = ?${image === undefined ? '' : ', image = ?'}
         WHERE id = ?`,
        [...values, ...(image === undefined ? [] : [image]), id]
      );
      if (!result.affectedRows) throw httpError(404, 'This food was not found in the global food library.');
      return id;
    }
    const newId = `global-${randomUUID()}`;
    await connection.query(
      `INSERT INTO global_food_library (name, category, kcal, protein, fat, fiber, manufacturer_url, shop_url, \`portion\`, \`country\`, updated_at, image, id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, image ?? null, newId]
    );
    return newId;
  } finally {
    connection.release();
  }
}

// Deletes the foods with these ids. Returns how many were deleted.
export async function deleteGlobalFoods(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(id => clean(id, 80)).filter(Boolean))].slice(0, MAX_IMPORT_ROWS);
  if (!list.length) return 0;
  const connection = await getConnection();
  try {
    const result = await connection.query(`DELETE FROM global_food_library WHERE id IN (${list.map(() => '?').join(', ')})`, list);
    return result.affectedRows;
  } finally {
    connection.release();
  }
}

// Copies a dog house's food, with its picture, into the global food library. The country is the dog house's, or
// fallbackCountry (the browser's) when the dog house has none. A food with the same name and country already there
// is only replaced when replace is true (administrators); otherwise the answer is status 'exists'.
export async function exportFoodToGlobal(dogHouseId, foodId, fallbackCountry, { replace = false } = {}) {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const [food] = await connection.query(
      'SELECT name, category, kcal, protein, fat, fiber, image, manufacturer_url, shop_url, `portion` FROM foods WHERE id = ? AND dog_house_id = ?',
      [clean(foodId, 80), dogHouseId]
    );
    if (!food) throw httpError(404, 'This food is not saved in the database yet. Try again in a moment.');
    const [house] = await connection.query('SELECT `country` FROM dog_house WHERE id = ?', [dogHouseId]);
    const fields = foodFields({
      name: food.name, category: food.category, country: house?.country || fallbackCountry,
      kcal: food.kcal, protein: food.protein, fat: food.fat, fiber: food.fiber, portion: food.portion,
      manufacturerUrl: food.manufacturer_url, shopUrl: food.shop_url
    });
    const [existing] = await connection.query(
      'SELECT id FROM global_food_library WHERE LOWER(name) = LOWER(?) AND LOWER(COALESCE(`country`, \'\')) = LOWER(?) FOR UPDATE',
      [fields.name, fields.country || '']
    );
    const result = { name: fields.name, country: fields.country || '' };
    if (existing && !replace) {
      await connection.rollback();
      return { ...result, status: 'exists', id: existing.id };
    }
    const values = [fields.name, fields.category, fields.kcal, fields.protein, fields.fat, fields.fiber,
      fields.manufacturerUrl, fields.shopUrl, fields.portion, fields.country, new Date()];
    if (existing) {
      // A food without a picture keeps the global food's picture.
      await connection.query(
        `UPDATE global_food_library SET name = ?, category = ?, kcal = ?, protein = ?, fat = ?, fiber = ?,
         manufacturer_url = ?, shop_url = ?, \`portion\` = ?, \`country\` = ?, updated_at = ?${food.image ? ', image = ?' : ''} WHERE id = ?`,
        [...values, ...(food.image ? [food.image] : []), existing.id]
      );
      await connection.commit();
      return { ...result, status: 'updated', id: existing.id };
    }
    const id = `global-${randomUUID()}`;
    await connection.query(
      `INSERT INTO global_food_library (name, category, kcal, protein, fat, fiber, manufacturer_url, shop_url, \`portion\`, \`country\`, updated_at, image, id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, food.image || null, id]
    );
    await connection.commit();
    return { ...result, status: 'added', id };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

// Imports CSV rows read by the page. A row whose name and country match a food in the library (ignoring case)
// updates it and keeps its picture; other rows are added. A link or portion column left out keeps the stored value.
export async function importGlobalFoods(rows) {
  if (!Array.isArray(rows) || !rows.length) throw httpError(400, 'There are no foods to import.');
  if (rows.length > MAX_IMPORT_ROWS) throw httpError(400, `Import at most ${MAX_IMPORT_ROWS} foods at once.`);
  const foods = rows.map(row => ({ row, fields: foodFields(row || {}) }));
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const existing = new Map();
    for (const row of await connection.query('SELECT id, name, `country` FROM global_food_library FOR UPDATE')) {
      existing.set(`${row.name.toLowerCase()}|${(row.country || '').toLowerCase()}`, row.id);
    }
    let added = 0;
    let updated = 0;
    const now = new Date();
    for (const { row, fields } of foods) {
      const key = `${fields.name.toLowerCase()}|${(fields.country || '').toLowerCase()}`;
      const id = existing.get(key);
      if (id) {
        const optional = [['manufacturerUrl', 'manufacturer_url'], ['shopUrl', 'shop_url'], ['portion', '`portion`']].filter(([name]) => name in row);
        await connection.query(
          `UPDATE global_food_library SET name = ?, category = ?, kcal = ?, protein = ?, fat = ?, fiber = ?, updated_at = ?
           ${optional.map(([, column]) => `, ${column} = ?`).join('')} WHERE id = ?`,
          [fields.name, fields.category, fields.kcal, fields.protein, fields.fat, fields.fiber, now, ...optional.map(([name]) => fields[name]), id]
        );
        updated++;
      } else {
        const newId = `global-${randomUUID()}`;
        await connection.query(
          `INSERT INTO global_food_library (id, name, category, kcal, protein, fat, fiber, manufacturer_url, shop_url, \`portion\`, \`country\`, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId, fields.name, fields.category, fields.kcal, fields.protein, fields.fat, fields.fiber,
            fields.manufacturerUrl, fields.shopUrl, fields.portion, fields.country, now]
        );
        existing.set(key, newId);
        added++;
      }
    }
    await connection.commit();
    return { added, updated };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
