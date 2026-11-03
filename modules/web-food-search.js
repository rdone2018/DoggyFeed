// Web search for foods in the Add food form. It asks Open Pet Food Facts (openpetfoodfacts.org), a free, open
// database of pet foods filled in by its users, so the values can be missing or wrong and the form asks to check
// them against the package. The server asks on behalf of the page, which cannot call another site itself.

const SEARCH_URL = 'https://world.openpetfoodfacts.org/cgi/search.pl';
const PICTURE_HOST = 'images.openpetfoodfacts.org';
const USER_AGENT = 'DoggyFeed/1.0 (https://github.com/rdone2018/DoggyFeed)';
const TIMEOUT_MS = 20000;
const MAX_RESULTS = 24;
const MAX_PICTURE_BYTES = 3 * 1024 * 1024;
const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const UNAVAILABLE = 'The web search is not available now. Try again later or fill in the food by hand.';

async function askWeb(url) {
  try {
    return await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw httpError(502, UNAVAILABLE);
  }
}

// Values per 100 g, rounded to one decimal. Pet foods often list crude protein, fat and fibre instead.
function per100g(nutriments, ...keys) {
  for (const key of keys) {
    const value = Number(nutriments?.[`${key}_100g`]);
    if (Number.isFinite(value) && value >= 0 && value <= 10000) return Math.round(value * 10) / 10;
  }
  return '';
}

function energyKcal(nutriments) {
  const kcal = per100g(nutriments, 'energy-kcal');
  if (kcal !== '') return Math.round(kcal);
  const kj = per100g(nutriments, 'energy-kj');
  return kj === '' ? '' : Math.round(kj / 4.184);
}

function category(tags) {
  const text = tags.join(' ');
  if (/treat|snack|biscuit|chew/.test(text)) return 'Treat';
  if (/wet|canned|pouch|pate/.test(text)) return 'Wet food';
  if (/dry/.test(text)) return 'Dry food';
  return '';
}

function toFood(product) {
  const tags = Array.isArray(product.categories_tags) ? product.categories_tags : [];
  const brand = String(product.brands || '').split(',')[0].trim();
  const productName = String(product.product_name || '').trim();
  const name = brand && !productName.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${productName}` : productName;
  const picture = String(product.image_front_url || product.image_url || '');
  const n = product.nutriments;
  const values = { kcal: energyKcal(n), protein: per100g(n, 'proteins', 'crude-protein'), fat: per100g(n, 'fat', 'crude-fat'),
    fiber: per100g(n, 'fiber', 'crude-fibre') };
  // Only zeros means the values were never filled in.
  if (Object.values(values).every(value => value === 0 || value === '')) for (const key in values) values[key] = '';
  return {
    name: name.slice(0, 60), brand, category: category(tags), ...values,
    picture: isPictureUrl(picture) ? picture : '',
    sourceUrl: /^https:\/\/[a-z.]*openpetfoodfacts\.org\//.test(String(product.url || '')) ? product.url : ''
  };
}

// Cat foods are left out, by category or name, unless they are marked as dog food too.
const forDogs = product => {
  const tags = Array.isArray(product.categories_tags) ? product.categories_tags : [];
  const name = String(product.product_name || '');
  if (/\b(cats?|kittens?|babycat|chats?|gatt[io]|katzen?|kočk[ay]|koty?|kot[aó]w)\b/iu.test(name)) return /\b(dogs?|pupp(y|ies)|hund|pes|psy?)\b/iu.test(name);
  if (tags.some(tag => /dog/.test(tag) && !/dog-and-cat/.test(tag))) return true;
  return !tags.some(tag => /cat/.test(tag));
};

export async function searchWebFoods(query) {
  const text = String(query ?? '').trim().slice(0, 100);
  if (text.length < 2) throw httpError(400, 'Enter at least 2 letters to search.');
  const url = new URL(SEARCH_URL);
  for (const [key, value] of Object.entries({
    search_terms: text, search_simple: '1', action: 'process', json: '1', page_size: '50',
    fields: 'product_name,brands,categories_tags,nutriments,image_front_url,image_url,url'
  })) url.searchParams.set(key, value);
  const response = await askWeb(url);
  if (!response.ok) throw httpError(502, UNAVAILABLE);
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body?.products)) throw httpError(502, UNAVAILABLE);
  return body.products.filter(product => String(product.product_name || '').trim() && forDogs(product))
    .slice(0, MAX_RESULTS).map(toFood);
}

function isPictureUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === PICTURE_HOST;
  } catch {
    return false;
  }
}

// A food picture from the search results, for the form's picture field. Only pictures of that database are fetched.
export async function readWebFoodPicture(link) {
  if (!isPictureUrl(link)) throw httpError(400, 'This picture cannot be loaded.');
  const response = await askWeb(link);
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim();
  if (!response.ok || !PICTURE_TYPES.includes(type)) throw httpError(502, 'The picture could not be loaded.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_PICTURE_BYTES) throw httpError(502, 'The picture is too large.');
  return { type, bytes };
}
