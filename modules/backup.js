import { deflateRawSync } from 'node:zlib';
import { getConnection } from '../database.js';

// Backup of one dog house: a ZIP file with DoggyFeed backup.xlsx, which holds all its data on one sheet per kind
// of record, and a Photos folder with the dog house photo, the dog photos and the food pictures stored in the
// database. Each sheet row names its picture's path in the ZIP. Passwords and sign-in sessions are never included.
// The Excel and ZIP files are written here, so DoggyFeed needs no extra packages for them.

// Reads everything of the dog house, limited to that dog house's rows.
export async function readBackupData(dogHouseId) {
  const connection = await getConnection();
  try {
    const house = [dogHouseId];
    const [[dogHouse], users, dogs, foods, mealItems, plans, planItems, weights, events, served, servedItems] = await Promise.all([
      connection.query('SELECT name, contact, email, `country`, photo, created_at FROM dog_house WHERE id = ?', house),
      connection.query('SELECT username, is_admin, is_guest, created_at FROM users WHERE dog_house_id = ? ORDER BY username', house),
      connection.query('SELECT * FROM dogs WHERE dog_house_id = ? ORDER BY name', house),
      connection.query('SELECT * FROM foods WHERE dog_house_id = ? ORDER BY name', house),
      connection.query('SELECT * FROM meal_items WHERE dog_house_id = ? ORDER BY dog_id, position', house),
      connection.query('SELECT * FROM saved_plans WHERE dog_house_id = ? ORDER BY name', house),
      connection.query('SELECT * FROM saved_plan_items WHERE dog_house_id = ? ORDER BY plan_id, position', house),
      connection.query('SELECT * FROM weight_history WHERE dog_house_id = ? ORDER BY dog_id, recorded_at', house),
      connection.query('SELECT * FROM calendar_events WHERE dog_house_id = ? ORDER BY `starts_at`', house),
      connection.query('SELECT * FROM served_meals WHERE dog_house_id = ? ORDER BY served_at', house),
      connection.query('SELECT * FROM served_meal_items WHERE dog_house_id = ? ORDER BY served_meal_id, position', house)
    ]);
    if (!dogHouse) {
      const error = new Error('This dog house was not found.');
      error.statusCode = 404;
      throw error;
    }
    return { dogHouse, users, dogs, foods, mealItems, plans, planItems, weights, events, served, servedItems };
  } finally {
    connection.release();
  }
}

// The ZIP file name, for example "DoggyFeed backup - Novak family - 2026-11-04.zip".
export function backupFileName(houseName, date = new Date()) {
  return `DoggyFeed backup - ${safeName(houseName) || 'Dog house'} - ${localDate(date)}.zip`;
}

// Builds the backup ZIP from readBackupData's records.
export function buildBackupZip(data, createdAt = new Date()) {
  const { dogHouse, users, dogs, foods, mealItems, plans, planItems, weights, events, served, servedItems } = data;
  const files = [];
  const usedPaths = new Set();
  // Stores a data: picture under Photos/<folder>/<name>.<type> and returns its path, '' when there is no picture,
  // or the link itself for a picture kept as a web link.
  const addPicture = (folder, name, value) => {
    if (!value) return '';
    const match = /^data:image\/(jpeg|png|webp|gif);base64,(.*)$/s.exec(value);
    if (!match) return /^https?:\/\//i.test(value) ? value : '';
    const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
    const base = `Photos/${folder}/${safeName(name) || 'Picture'}`;
    let filePath = `${base}.${extension}`;
    for (let number = 2; usedPaths.has(filePath.toLowerCase()); number++) filePath = `${base} (${number}).${extension}`;
    usedPaths.add(filePath.toLowerCase());
    files.push({ path: filePath, data: Buffer.from(match[2], 'base64'), compress: false });
    return filePath;
  };

  const dogNames = new Map(dogs.map(dog => [dog.id, dog.name]));
  const foodNames = new Map(foods.map(food => [food.id, food.name]));
  const planNames = new Map(plans.map(plan => [plan.id, plan.name]));
  const dogName = id => id ? dogNames.get(id) || `(removed dog ${id})` : '';
  const foodName = id => foodNames.get(id) || `(removed food ${id})`;

  const sheets = [
    {
      name: 'Dog house',
      columns: ['Name', 'Contact', 'Email', 'Country', 'Created', 'Photo', 'Backup created'],
      rows: [[dogHouse.name, dogHouse.contact, dogHouse.email, dogHouse.country, dateTime(dogHouse.created_at),
        addPicture('Dog house', dogHouse.name, dogHouse.photo), dateTime(createdAt)]]
    },
    {
      name: 'Users',
      columns: ['Username', 'Administrator', 'Guest', 'Added'],
      rows: users.map(user => [user.username, yesNo(user.is_admin), yesNo(user.is_guest), dateTime(user.created_at)])
    },
    {
      name: 'Dogs',
      columns: ['Dog ID', 'Name', 'Breed', 'Gender', 'Life stage', 'Weight (kg)', 'Desired weight (kg)', 'Activity factor',
        'Meals per day', 'Daily energy (kcal)', 'Heat 1', 'Heat 2', 'Photo'],
      rows: dogs.map(dog => [dog.id, dog.name, dog.breed, dog.gender, dog.life_stage, number(dog.weight), number(dog.desired_weight),
        number(dog.activity), number(dog.meals_per_day), number(dog.daily_energy), dog.heat1, dog.heat2,
        addPicture('Dogs', dog.name, dog.photo)])
    },
    {
      name: 'Foods',
      columns: ['Food ID', 'Name', 'Category', 'kcal per 100 g', 'Protein %', 'Fat %', 'Fiber %', 'Portion (g)', 'Stock',
        'Manufacturer link', 'Shop link', 'Picture'],
      rows: foods.map(food => [food.id, food.name, food.category, number(food.kcal), number(food.protein), number(food.fat),
        number(food.fiber), number(food.portion), number(food.stock), food.manufacturer_url, food.shop_url,
        addPicture('Foods', food.name, food.image)])
    },
    {
      name: 'Bowls',
      columns: ['Dog', 'Position', 'Food', 'Grams', 'Filled automatically', 'Dog ID', 'Food ID'],
      rows: mealItems.map(item => [dogName(item.dog_id), item.position + 1, foodName(item.food_id), number(item.grams),
        yesNo(item.auto_fill), item.dog_id, item.food_id])
    },
    {
      name: 'Saved plans',
      columns: ['Plan', 'Dog', 'Saved', 'Updated', 'Position', 'Food', 'Grams', 'Filled automatically', 'Plan ID', 'Food ID'],
      rows: planItems.map(item => {
        const plan = plans.find(row => row.id === item.plan_id);
        return [planNames.get(item.plan_id) || item.plan_id, dogName(plan?.dog_id), dateTime(plan?.saved_at), dateTime(plan?.updated_at),
          item.position + 1, foodName(item.food_id), number(item.grams), yesNo(item.auto_fill), item.plan_id, item.food_id];
      })
    },
    {
      name: 'Weight history',
      columns: ['Dog', 'Date', 'Weight (kg)', 'Desired weight (kg)', 'Daily energy (kcal)', 'Daily energy set by hand', 'Dog ID'],
      rows: weights.map(row => [dogName(row.dog_id), dateTime(row.recorded_at), number(row.weight), number(row.desired_weight),
        number(row.daily_energy), row.daily_energy === null ? '' : yesNo(row.daily_energy_custom), row.dog_id])
    },
    {
      name: 'Calendar',
      columns: ['Description', 'Dog', 'Start', 'Duration (minutes)', 'Location', 'Link', 'Repeat', 'Repeat every (days)',
        'Reminder', 'Reminder days before', 'Dog ID'],
      rows: events.map(event => [event.description, event.dog_id ? dogName(event.dog_id) : 'All dogs', dateTime(event.starts_at),
        number(event.duration_minutes), event.location, event.url, event.repeat_kind, number(event.repeat_days),
        event.reminder_kind, number(event.reminder_days), event.dog_id])
    },
    {
      name: 'Served bowls',
      columns: ['Served', 'Dog', 'Plan', 'Meals per day', 'Target (kcal)', 'Energy (kcal)', 'Protein (g)', 'Fat (g)', 'Fiber (g)',
        'Served bowl ID', 'Dog ID'],
      rows: served.map(meal => [dateTime(meal.served_at), meal.dog_name, meal.plan_name, number(meal.meals_per_day),
        number(meal.target_kcal), number(meal.kcal), number(meal.protein), number(meal.fat), number(meal.fiber), meal.id, meal.dog_id])
    },
    {
      name: 'Served bowl foods',
      columns: ['Served', 'Dog', 'Position', 'Food', 'Category', 'Grams', 'kcal per 100 g', 'Energy (kcal)', 'Protein (g)',
        'Fat (g)', 'Fiber (g)', 'Served bowl ID', 'Food ID'],
      rows: servedItems.map(item => {
        const meal = served.find(row => row.id === item.served_meal_id);
        return [dateTime(meal?.served_at), meal?.dog_name || '', item.position + 1, item.food_name, item.category, number(item.grams),
          number(item.kcal_per_100g), number(item.kcal), number(item.protein), number(item.fat), number(item.fiber),
          item.served_meal_id, item.food_id];
      })
    }
  ];

  files.unshift({ path: 'DoggyFeed backup.xlsx', data: buildWorkbook(sheets), compress: false });
  return buildZip(files, createdAt);
}

// File and folder names without characters Windows, macOS or Linux refuse.
function safeName(value) {
  return String(value ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80);
}

const pad = value => String(value).padStart(2, '0');
const localDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const yesNo = value => value ? 'Yes' : 'No';
const number = value => value === null || value === undefined || value === '' ? '' : Number(value);

// Dates as text, so every Excel shows them the same: times as "YYYY-MM-DD HH:MM:SS" in the server's time zone, and
// local dates the app stores as text (weight history, calendar) with the T replaced.
function dateTime(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && !Number.isNaN(Date.parse(value))) value = new Date(value);
  if (value instanceof Date) {
    return `${localDate(value)} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  return String(value).replace('T', ' ').replace(/\.\d+Z?$|Z$/, '');
}

// ----- Excel workbook (Office Open XML): one sheet per entry of sheets, the first row bold and kept in view. -----

function buildWorkbook(sheets) {
  const parts = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`],
    ...sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, worksheet(sheet)])
  ];
  return buildZip(parts.map(([path, text]) => ({ path, data: Buffer.from(text, 'utf8'), compress: true })));
}

function worksheet({ columns, rows }) {
  const all = [columns, ...rows];
  // Column widths from the longest value, between 8 and 60 characters.
  const widths = columns.map((column, index) => Math.min(60, Math.max(8, ...all.map(row => String(row[index] ?? '').length + 2))));
  const cell = (value, column, row, header) => {
    const reference = `${columnName(column)}${row}`;
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"${header ? ' s="1"' : ''}><v>${value}</v></c>`;
    if (value === null || value === undefined || value === '') return '';
    // Inline text is never read as a formula, so a value such as "=1+1" stays plain text.
    return `<c r="${reference}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  };
  const sheetRows = all.map((row, rowIndex) =>
    `<row r="${rowIndex + 1}">${row.map((value, column) => cell(value, column, rowIndex + 1, rowIndex === 0)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows}</sheetData>${rows.length ? `<autoFilter ref="A1:${columnName(columns.length - 1)}${rows.length + 1}"/>` : ''}</worksheet>`;
}

const columnName = index => index < 26 ? String.fromCharCode(65 + index) : columnName(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26);

// Text for XML, without the control characters XML does not allow.
function xml(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ----- ZIP file: deflated or stored entries, UTF-8 names. -----

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Pictures are already compressed, so they are stored as they are; text is deflated.
function buildZip(files, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const data = file.compress ? deflateRawSync(file.data) : file.data;
    const method = file.compress ? 8 : 0;
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
