import { getConnection } from '../database.js';

export async function getMealsForDog(dogId) {
  const connection = await getConnection();
  try {
    const rows = await connection.query(
      'SELECT * FROM meal_items WHERE dog_id = ? ORDER BY position',
      [dogId]
    );
    return rows.map(row => ({ foodId: row.food_id, grams: Number(row.grams) }));
  } finally {
    connection.release();
  }
}

export async function saveMealsForDog(dogId, items) {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM meal_items WHERE dog_id = ?', [dogId]);
    for (const [position, item] of (items || []).entries()) {
      await connection.query(
        'INSERT INTO meal_items (dog_id, position, food_id, grams) VALUES (?, ?, ?, ?)',
        [dogId, position, item.foodId, Number(item.grams) || 0]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getSavedPlans() {
  const connection = await getConnection();
  try {
    const plans = await connection.query('SELECT * FROM saved_plans ORDER BY name');
    const rows = await connection.query('SELECT * FROM saved_plan_items ORDER BY plan_id, position');
    const items = new Map(plans.map(plan => [plan.id, []]));
    for (const row of rows) items.get(row.plan_id)?.push({ foodId: row.food_id, grams: Number(row.grams) });
    return plans.map(plan => ({
      id: plan.id, name: plan.name, savedAt: plan.saved_at, updatedAt: plan.updated_at, dogId: plan.dog_id || '',
      items: items.get(plan.id)
    }));
  } finally {
    connection.release();
  }
}

export async function getPlanItems(planId) {
  const connection = await getConnection();
  try {
    const rows = await connection.query(
      'SELECT * FROM saved_plan_items WHERE plan_id = ? ORDER BY position',
      [planId]
    );
    return rows.map(row => ({ foodId: row.food_id, grams: Number(row.grams) }));
  } finally {
    connection.release();
  }
}

export async function savePlan(plan) {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO saved_plans (id, name, saved_at, updated_at, dog_id) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), saved_at = VALUES(saved_at), updated_at = VALUES(updated_at),
       dog_id = VALUES(dog_id)`,
      [plan.id, plan.name, plan.savedAt || null, plan.updatedAt || null, plan.dogId || null]
    );
    await connection.query('DELETE FROM saved_plan_items WHERE plan_id = ?', [plan.id]);
    for (const [position, item] of (plan.items || []).entries()) {
      await connection.query(
        'INSERT INTO saved_plan_items (plan_id, position, food_id, grams) VALUES (?, ?, ?, ?)',
        [plan.id, position, item.foodId, Number(item.grams) || 0]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function deletePlan(id) {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM saved_plan_items WHERE plan_id = ?', [id]);
    await connection.query('DELETE FROM saved_plans WHERE id = ?', [id]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

const servedText = (value, maxLength) => String(value ?? '').slice(0, maxLength);
const servedAmount = value => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, 0), 99999999) : 0;
};

// Adds one served bowl, with a copy of each food's details, to the food served history.
export async function recordServedMeal(meal) {
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
      `INSERT INTO served_meals (id, dog_id, dog_name, served_at, meals_per_day, target_kcal, kcal, protein, fat, fiber)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, servedText(meal.dogId, 80), servedText(meal.dogName || 'Dog', 100),
        Number.isNaN(servedAt.getTime()) ? new Date() : servedAt,
        Number(meal.mealsPerDay) > 0 ? Math.round(Number(meal.mealsPerDay)) : null,
        Number(meal.targetKcal) > 0 ? servedAmount(meal.targetKcal) : null,
        total('kcal'), total('protein'), total('fat'), total('fiber')]
    );
    for (const [position, item] of items.entries()) {
      await connection.query(
        `INSERT INTO served_meal_items
           (served_meal_id, position, food_id, food_name, category, grams, kcal_per_100g, kcal, protein, fat, fiber)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, position, item.foodId, item.foodName, item.category, item.grams, item.kcalPer100g,
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
