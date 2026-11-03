import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Web search for foods in the Add food form. With TINYFISH_API_KEY set, the server searches the web through the
// TinyFish Search API in the dog house's country and language, then reads each page found (shops, manufacturers)
// for the food's name, picture and analytical constituents. Without the key it asks Open Pet Food Facts, a free
// database of pet foods. Either way the values can be missing or wrong, so the form asks to check them against
// the package. The server asks on behalf of the page, which cannot call other sites itself.

const TINYFISH_URL = 'https://api.search.tinyfish.ai';
const OPEN_PET_FOOD_FACTS_URL = 'https://world.openpetfoodfacts.org/cgi/search.pl';
const OPEN_PET_FOOD_FACTS_PICTURES = 'images.openpetfoodfacts.org';
const USER_AGENT = 'Mozilla/5.0 (compatible; DoggyFeed/1.0; +https://github.com/rdone2018/DoggyFeed)';
const SEARCH_TIMEOUT_MS = 20000;
const PAGE_TIMEOUT_MS = 8000;
const MAX_RESULTS = 24;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PICTURE_BYTES = 3 * 1024 * 1024;
const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const UNAVAILABLE = 'The web search is not available now. Try again later or fill in the food by hand.';

// The search language of a dog house's country, and a word that leads the search to the composition.
const COUNTRY_LANGUAGES = {
  CZ: 'cs', SK: 'sk', PL: 'pl', DE: 'de', AT: 'de', CH: 'de', HU: 'hu', FR: 'fr', BE: 'fr', IT: 'it', ES: 'es',
  NL: 'nl', GB: 'en', IE: 'en', US: 'en', CA: 'en', AU: 'en'
};
const COMPOSITION_WORDS = {
  cs: 'složení', sk: 'zloženie', pl: 'skład', de: 'Zusammensetzung', hu: 'összetétel', fr: 'composition',
  it: 'componenti analitici', es: 'composición', nl: 'samenstelling', en: 'analytical constituents'
};

export async function searchWebFoods(query, { country = '', language = '' } = {}) {
  const text = String(query ?? '').trim().slice(0, 100);
  if (text.length < 2) throw httpError(400, 'Enter at least 2 letters to search.');
  const apiKey = String(process.env.TINYFISH_API_KEY || '').trim();
  if (!apiKey) return { source: 'openpetfoodfacts', foods: await searchOpenPetFoodFacts(text) };
  return { source: 'web', foods: await searchTinyFish(text, apiKey, country, language) };
}

// ---- TinyFish web search -------------------------------------------------------------------------------------

async function searchTinyFish(text, apiKey, country, uiLanguage) {
  const location = /^[A-Z]{2}$/.test(String(country)) && country !== 'XK' ? country : '';
  const language = COUNTRY_LANGUAGES[location] || (/^[a-z]{2}$/.test(String(uiLanguage)) ? uiLanguage : '');
  const ask = async page => {
    const url = new URL(TINYFISH_URL);
    url.searchParams.set('query', `${text} ${COMPOSITION_WORDS[language] || ''}`.trim());
    if (location) url.searchParams.set('location', location);
    if (language) url.searchParams.set('language', language);
    url.searchParams.set('page', String(page));
    let response;
    try {
      response = await fetch(url, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    } catch {
      throw httpError(502, UNAVAILABLE);
    }
    if (response.status === 401 || response.status === 403) throw httpError(502, 'The web search key on the server is not valid. Check TINYFISH_API_KEY.');
    if (!response.ok) throw httpError(502, UNAVAILABLE);
    const body = await response.json().catch(() => null);
    return Array.isArray(body?.results) ? body.results : [];
  };
  // Two pages of results; the second one is left out when it fails.
  const [first, second] = await Promise.all([ask(0), ask(1).catch(() => [])]);
  const seen = new Set();
  const results = [...first, ...second].filter(result => {
    if (!/^https?:\/\//.test(String(result?.url || '')) || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  }).slice(0, MAX_RESULTS);
  // Results with more nutrition values come first; otherwise the search order stays.
  const filled = food => ['kcal', 'protein', 'fat', 'fiber'].filter(key => food[key] !== '').length;
  return (await Promise.all(results.map(readResult))).filter(food => food.name).sort((a, b) => filled(b) - filled(a));
}

// One search result: the snippet often lists the analytical constituents already; the page adds its picture,
// its product name and the values the snippet does not have.
async function readResult(result) {
  const page = await readPage(result.url).catch(() => null);
  const title = cleanTitle(result.title || page?.title);
  const values = nutrition(`${result.snippet || ''} ${page?.text || ''}`);
  if (page?.picture) rememberPicture(page.picture);
  return {
    name: title.slice(0, 60), category: category(`${result.title || ''} ${result.snippet || ''} ${page?.title || ''}`), ...values,
    picture: page?.picture || '', site: String(result.site_name || new URL(result.url).hostname).replace(/^www\./, ''),
    sourceUrl: result.url
  };
}

async function readPage(link) {
  const { response, finalUrl, bytes } = await fetchPublic(link, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES });
  if (!response.ok || !/html/i.test(response.headers.get('content-type') || '')) return null;
  const html = bytes.toString('utf8');
  const meta = (name) => {
    const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'))?.[0] || '';
    return decodeEntities(tag.match(/content=["']([^"']*)["']/i)?.[1] || '').trim();
  };
  let picture = meta('og:image') || meta('twitter:image');
  try {
    picture = picture ? new URL(picture, finalUrl).href : '';
  } catch {
    picture = '';
  }
  const text = decodeEntities(html.slice(0, 1500000)
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  return { title: meta('og:title') || decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), picture, text };
}

function decodeEntities(text) {
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", percnt: '%', ndash: '–', mdash: '—' };
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') {
      const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(number) && number > 0 && number < 0x110000 ? String.fromCodePoint(number) : ' ';
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

// "Brit Care Adult Salmon 12 kg - Granule pro psy | Shop" → "Brit Care Adult Salmon 12 kg"
function cleanTitle(title) {
  const text = decodeEntities(title || '').replace(/\s+/g, ' ').trim();
  const first = text.split(/\s[|–—-]\s/)[0].trim();
  return first.length >= 6 ? first : text;
}

// Analytical constituents in the languages of the dog houses. Labels for the crude values come first, so
// "salmon protein (10 %)" in a composition list does not win over "crude protein 26 %".
const LABELS = {
  protein: [
    ['hrubý protein', 'hrubé proteiny', 'hrubé bílkoviny', 'hrubé bielkoviny', 'hrubý proteín', 'białko surowe', 'surowe białko',
      'rohprotein', 'crude protein', 'protéines brutes', 'proteine grezze', 'proteína bruta', 'nyersfehérje', 'ruw eiwit'],
    ['bílkoviny', 'bielkoviny', 'proteiny', 'proteíny', 'protein', 'proteín', 'białko', 'proteine', 'protéines', 'proteína', 'fehérje', 'eiwit']
  ],
  fat: [
    ['hrubý tuk', 'hrubé tuky', 'hrubé oleje a tuky', 'hrubý olej a tuk', 'hrubé tuky a oleje', 'tłuszcz surowy', 'surowy tłuszcz',
      'oleje i tłuszcze surowe', 'rohfett', 'rohöle und -fette', 'crude fat', 'crude oils and fats', 'matières grasses brutes',
      'grassi grezzi', 'oli e grassi grezzi', 'grasa bruta', 'aceites y grasas brutos', 'nyerszsír', 'ruw vet'],
    ['tuky', 'tuk', 'oleje a tuky', 'tłuszcz', 'fett', 'fat', 'matières grasses', 'grassi', 'grasa', 'zsír', 'vet']
  ],
  fiber: [
    ['hrubá vláknina', 'hrubé vlákno', 'włókno surowe', 'surowe włókno', 'rohfaser', 'crude fibre', 'crude fiber', 'cellulose brute',
      'fibra grezza', 'fibra bruta', 'nyersrost', 'ruwe celstof'],
    ['vláknina', 'vlákno', 'włókno', 'błonnik', 'faser', 'fibre', 'fiber', 'fibra', 'rost', 'celstof']
  ]
};
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = Object.fromEntries(Object.entries(LABELS).map(([key, tiers]) => [key, tiers.map(labels =>
  new RegExp(`(?<!\\p{L})(?:${labels.map(escapeRegExp).join('|')})(?!\\p{L})\\s*(?:\\(%\\))?\\s*[:\\-–]?\\s*(\\d{1,2}(?:[.,]\\d{1,2})?)\\s*(?:%|g(?!\\p{L}))`, 'giu'))]));

// A value counts most when another constituent is listed right around it, as in an analysis table, and not in
// a description or a composition list.
function nutrition(text) {
  const values = { kcal: energy(text), protein: '', fat: '', fiber: '' };
  const nearOther = (key, index) => Object.entries(PATTERNS).some(([other, tiers]) => other !== key && tiers.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(text.slice(Math.max(0, index - 150), index + 200));
  }));
  for (const [key, tiers] of Object.entries(PATTERNS)) {
    let found = null;
    for (const pattern of tiers) {
      const matches = [...text.matchAll(pattern)].slice(0, 50);
      found = matches.find(match => nearOther(key, match.index)) || matches[0];
      if (found) break;
    }
    if (found) values[key] = Number(found[1].replace(',', '.'));
  }
  return values;
}

// Energy per 100 g, from "385 kcal/100 g", "3 850 kcal/kg" or "16,1 MJ/kg".
function energy(text) {
  const number = value => Number(String(value).replace(/[\s ]/g, '').replace(/\.(?=\d{3}(?!\d))/, '').replace(',', '.'));
  const checked = kcal => kcal >= 30 && kcal <= 700 ? Math.round(kcal) : '';
  const per100g = text.match(/(\d{2,3}(?:[.,]\d{1,2})?)\s*kcal\s*(?:\/|na|per|pro|w|je|in)?\s*100\s*g/i);
  if (per100g && checked(number(per100g[1])) !== '') return checked(number(per100g[1]));
  const perKg = text.match(/(\d[\s .]?\d{3}(?:[.,]\d{1,2})?)\s*kcal\s*(?:\/|na|per|pro|w|je|in)?\s*(?:1\s*)?kg/i);
  if (perKg && checked(number(perKg[1]) / 10) !== '') return checked(number(perKg[1]) / 10);
  const megajoules = text.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*MJ\s*(?:\/|na|per|pro|w|je|in)?\s*(?:1\s*)?kg/i);
  return megajoules ? checked(number(megajoules[1]) * 23.9) : '';
}

function category(text) {
  const words = text.toLowerCase();
  if (/pamls|treat|snack|przysmak|leckerli|kausnack|dental|tyčink|sticks?\b|friandise|jutalomfalat/.test(words)) return 'Treat';
  if (/konzerv|kapsičk|paštik|pâté|pate\b|wet|mokr|nassfutter|dose\b|puszk|saszet|pouch|vaničk|alutác|umido|húmedo|nedves/.test(words)) return 'Wet food';
  if (/granul|kibble|dry|such|trocken|krokiet|croquette|crocchett|pienso|száraz/.test(words)) return 'Dry food';
  return '';
}

// ---- Fetching other sites -------------------------------------------------------------------------------------

// Pages and pictures are fetched only from public internet addresses, never from this server's own network,
// and redirects are checked the same way.
function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const text = address.toLowerCase();
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return text === '::' || text === '::1' || /^f[cd]/.test(text) || /^fe[89ab]/.test(text);
}

async function checkPublicUrl(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw httpError(400, 'This web address cannot be loaded.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw httpError(400, 'This web address cannot be loaded.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw httpError(400, 'This web address cannot be loaded.');
  return url;
}

async function fetchPublic(link, { timeoutMs, maxBytes, accept = '*/*' }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = await checkPublicUrl(link);
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (redirects >= 4) throw httpError(502, 'Too many redirects.');
      url = await checkPublicUrl(new URL(location, url).href);
      continue;
    }
    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw httpError(502, 'The page is too large.');
        chunks.push(chunk);
      }
    }
    return { response, finalUrl: url.href, bytes: Buffer.concat(chunks) };
  }
}

// Only pictures found by a recent search are loaded, so this server cannot be used to fetch anything else.
const foundPictures = new Map();
function rememberPicture(link) {
  foundPictures.delete(link);
  foundPictures.set(link, Date.now());
  while (foundPictures.size > 2000) foundPictures.delete(foundPictures.keys().next().value);
}
const isFoundPicture = link => Date.now() - (foundPictures.get(link) || 0) < 6 * 60 * 60 * 1000;

function isOpenPetFoodFactsPicture(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === OPEN_PET_FOOD_FACTS_PICTURES;
  } catch {
    return false;
  }
}

// A food picture from the search results, for the form's picture field.
export async function readWebFoodPicture(link) {
  if (!isOpenPetFoodFactsPicture(link) && !isFoundPicture(link)) throw httpError(400, 'This picture cannot be loaded.');
  let result;
  try {
    result = await fetchPublic(link, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: MAX_PICTURE_BYTES, accept: 'image/*' });
  } catch (error) {
    throw error.statusCode ? error : httpError(502, 'The picture could not be loaded.');
  }
  const type = String(result.response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!result.response.ok || !PICTURE_TYPES.includes(type)) throw httpError(502, 'The picture could not be loaded.');
  return { type, bytes: result.bytes };
}

// ---- Open Pet Food Facts, without a TinyFish key --------------------------------------------------------------

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

function openPetFoodFactsFood(product) {
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
    name: name.slice(0, 60), category: category(tags.join(' ').replace(/-/g, ' ')), ...values,
    picture: isOpenPetFoodFactsPicture(picture) ? picture : '', site: 'openpetfoodfacts.org',
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

async function searchOpenPetFoodFacts(text) {
  const url = new URL(OPEN_PET_FOOD_FACTS_URL);
  for (const [key, value] of Object.entries({
    search_terms: text, search_simple: '1', action: 'process', json: '1', page_size: '50',
    fields: 'product_name,brands,categories_tags,nutriments,image_front_url,image_url,url'
  })) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  } catch {
    throw httpError(502, UNAVAILABLE);
  }
  if (!response.ok) throw httpError(502, UNAVAILABLE);
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body?.products)) throw httpError(502, UNAVAILABLE);
  return body.products.filter(product => String(product.product_name || '').trim() && forDogs(product))
    .slice(0, MAX_RESULTS).map(openPetFoodFactsFood);
}
