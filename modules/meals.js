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
    return plans;
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
      'INSERT INTO saved_plans (id, name, saved_at, updated_at) VALUES (?, ?, ?, ?)',
      [plan.id, plan.name, plan.savedAt || null, plan.updatedAt || null]
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
    await connection.query('DELETE FROM saved_plan_items WHERE plan_id = ?', [id]);
    await connection.query('DELETE FROM saved_plans WHERE id = ?', [id]);
  } finally {
    connection.release();
  }
}
```