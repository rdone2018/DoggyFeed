import { getConnection } from '../database.js';

export async function getDogs() {
  const connection = await getConnection();
  try {
    return await connection.query('SELECT * FROM dogs ORDER BY name');
  } finally {
    connection.release();
  }
}

export async function saveDog(dog) {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO dogs (id, name, weight, activity, life_stage, breed, gender, heat1, heat2, photo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), weight=VALUES(weight), activity=VALUES(activity),
       life_stage=VALUES(life_stage), breed=VALUES(breed), gender=VALUES(gender),
       heat1=VALUES(heat1), heat2=VALUES(heat2), photo=VALUES(photo)`,
      [dog.id, dog.name, Number(dog.weight) || 0, Number(dog.activity) || 1.6,
        dog.age || 'Adult', dog.breed || null, dog.gender || null, dog.heat1 || null, dog.heat2 || null, dog.photo || null]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteDog(id) {
  const connection = await getConnection();
  try {
    await connection.query('DELETE FROM dogs WHERE id = ?', [id]);
  } finally {
    connection.release();
  }
}

export async function getSelectedDog() {
  const connection = await getConnection();
  try {
    const rows = await connection.query(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'selectedDog'"
    );
    return rows[0]?.setting_value || '';
  } finally {
    connection.release();
  }
}

export async function setSelectedDog(id) {
  const connection = await getConnection();
  try {
    await connection.query(
      "INSERT INTO app_settings (setting_key, setting_value) VALUES ('selectedDog', ?)",
      [id]
    );
  } finally {
    connection.release();
  }
}