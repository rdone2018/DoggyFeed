import { getConnection } from '../database.js';

// Food served history. Every served bowl belongs to a dog house, and every function here only reads or changes
// the given dog house's records.

const servedText = (value, maxLength) => String(value ?? '').slice(0, maxLength);
const servedAmount = value => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, 0), 99999999) : 0;
};

// Adds one served bowl, with a copy of each food's details, to the food served history.
export async function recordServedMeal(dogHouseId, meal) {
  const items = (Array.isArray(meal.items) ? meal.items : [])
    .filter(item => item && item.foodId)
    .map(item => {
      const grams = servedAmount(item.grams);
      const per100 = key => servedAmount(item[key]) * grams / 100;
      return {
        foodId: servedText(item.foodId, 80),
        foodName: servedText(item.foodName || 'Food', 120),
        category: servedText(item.category, 50) || null,
        grams,
        kcalPer100g: servedAmount(item.kcal),
        kcal: per100('kcal'),
        protein: per100('protein'),
        fat: per100('fat'),
        fiber: per100('fiber')
      };
    });
  if (!items.length) {
    const error = new Error('The bowl has no foods to record.');
    error.statusCode = 400;
    throw error;
  }

  const servedAt = new Date(meal.servedAt);
  const id = servedText(meal.id, 80) || `served-${Date.now()}`;
  const total = key => items.reduce((sum, item) => sum + item[key], 0);
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO served_meals (id, dog_house_id, dog_id, dog_name, served_at, plan_name, meals_per_day, target_kcal, kcal, protein, fat, fiber)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, dogHouseId, servedText(meal.dogId, 80), servedText(meal.dogName || 'Dog', 100),
        Number.isNaN(servedAt.getTime()) ? new Date() : servedAt, servedText(meal.planName, 120) || null,
        Number(meal.mealsPerDay) > 0 ? Math.round(Number(meal.mealsPerDay)) : null,
        Number(meal.targetKcal) > 0 ? servedAmount(meal.targetKcal) : null,
        total('kcal'), total('protein'), total('fat'), total('fiber')]
    );
    for (const [position, item] of items.entries()) {
      await connection.query(
        `INSERT INTO served_meal_items
           (dog_house_id, served_meal_id, position, food_id, food_name, category, grams, kcal_per_100g, kcal, protein, fat, fiber)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dogHouseId, id, position, item.foodId, item.foodName, item.category, item.grams, item.kcalPer100g,
          item.kcal, item.protein, item.fat, item.fiber]
      );
    }
    await connection.commit();
    return { id, kcal: total('kcal'), items: items.length };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

// Moves a served bowl to another date and time. Returns false when the dog house has no such record.
export async function updateServedMealTime(dogHouseId, id, servedAt) {
  const connection = await getConnection();
  try {
    const result = await connection.query('UPDATE served_meals SET served_at = ? WHERE id = ? AND dog_house_id = ?', [servedAt, id, dogHouseId]);
    return result.affectedRows > 0;
  } finally {
    connection.release();
  }
}

// Deletes a served bowl and its foods from the food served history. Returns false when the dog house has no such
// record.
export async function deleteServedMeal(dogHouseId, id) {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const result = await connection.query('DELETE FROM served_meals WHERE id = ? AND dog_house_id = ?', [id, dogHouseId]);
    if (result.affectedRows > 0) {
      await connection.query('DELETE FROM served_meal_items WHERE served_meal_id = ? AND dog_house_id = ?', [id, dogHouseId]);
    }
    await connection.commit();
    return result.affectedRows > 0;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

// Returns a dog's served bowls with their foods, from (inclusive) to (exclusive), oldest first.
export async function getServedMeals(dogHouseId, dogId, from, to) {
  const connection = await getConnection();
  try {
    const meals = await connection.query(
      `SELECT * FROM served_meals WHERE dog_house_id = ? AND dog_id = ? AND served_at >= ? AND served_at < ? ORDER BY served_at`,
      [dogHouseId, dogId, from, to]
    );
    const items = new Map(meals.map(meal => [meal.id, []]));
    if (meals.length) {
      const rows = await connection.query(
        `SELECT * FROM served_meal_items WHERE dog_house_id = ? AND served_meal_id IN (${meals.map(() => '?').join(', ')})
         ORDER BY served_meal_id, position`,
        [dogHouseId, ...meals.map(meal => meal.id)]
      );
      for (const row of rows) {
        items.get(row.served_meal_id)?.push({
          foodId: row.food_id, foodName: row.food_name, category: row.category, grams: Number(row.grams),
          kcal: Number(row.kcal), protein: Number(row.protein), fat: Number(row.fat), fiber: Number(row.fiber)
        });
      }
    }
    return meals.map(meal => ({
      id: meal.id,
      servedAt: new Date(meal.served_at).toISOString(),
      planName: meal.plan_name || '',
      mealsPerDay: meal.meals_per_day === null ? null : Number(meal.meals_per_day),
      targetKcal: meal.target_kcal === null ? null : Number(meal.target_kcal),
      kcal: Number(meal.kcal), protein: Number(meal.protein), fat: Number(meal.fat), fiber: Number(meal.fiber),
      items: items.get(meal.id) || []
    }));
  } finally {
    connection.release();
  }
}
