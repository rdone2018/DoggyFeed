import { getConnection, toFood } from '../database.js';

export async function getFoods() {
  const connection = await getConnection();
  try {
    const rows = await connection.query('SELECT * FROM foods ORDER BY name');
    return rows.map(toFood);
  } finally {
    connection.release();
  }
}

export async function saveFood(food) {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO foods (id, name, category, kcal, protein, fat, fiber, image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), category=VALUES(category),
       kcal=VALUES(kcal), protein=VALUES(protein), fat=VALUES(fat),
       fiber=VALUES(fiber), image=VALUES(image)`,
      [food.id, food.name, food.category || 'Other', Number(food.kcal) || 0,
        Number(food.protein) || 0, Number(food.fat) || 0, Number(food.fiber) || 0, food.image || null]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteFood(id) {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM meal_items WHERE food_id = ?', [id]);
    await connection.query('DELETE FROM foods WHERE id = ?', [id]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}