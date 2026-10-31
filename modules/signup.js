import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Abuse protection for creating a new dog house from the sign-in screen, which anyone who can reach DoggyFeed
// may use. Everything is kept in memory, so it resets when the server restarts.

// Timing check: when the form opens, the page gets a form token holding the time it was issued, signed with a
// secret known only to this server process. A form sent back too quickly (a script), much later, with a token that
// was changed, or with a token already used, is refused.
const secret = randomBytes(32);
export const FORM_MIN_SECONDS = 3;
export const FORM_MAX_SECONDS = 60 * 60;
const usedTokens = new Map();

const sign = issued => createHmac('sha256', secret).update(issued).digest('base64url');

export function formToken(now = Date.now()) {
  const issued = String(now);
  return `${issued}.${sign(issued)}`;
}

// '' when the token is fine, otherwise why it is not: missing, invalid, used, too-fast or expired.
export function formTokenProblem(token, now = Date.now()) {
  const [issued, signature] = String(token || '').split('.');
  if (!issued || !signature) return 'missing';
  const expected = Buffer.from(sign(issued));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  const ageSeconds = (now - Number(issued)) / 1000;
  if (!(ageSeconds >= FORM_MIN_SECONDS)) return 'too-fast';
  if (ageSeconds > FORM_MAX_SECONDS) return 'expired';
  if (usedTokens.has(signature)) return 'used';
  return '';
}

// A token can be used for one sign-up only.
export function useFormToken(token, now = Date.now()) {
  const [issued, signature] = String(token || '').split('.');
  usedTokens.set(signature, Number(issued));
  for (const [key, issuedAt] of usedTokens) {
    if (now - issuedAt > FORM_MAX_SECONDS * 1000) usedTokens.delete(key);
  }
}

// Honeypot: a field people never see or fill in, but form-filling bots do.
export const HONEYPOT_FIELD = 'website';
export const honeypotFilled = body => String(body?.[HONEYPOT_FIELD] ?? '').trim() !== '';

// Hard limits. Every attempt counts, whether it succeeds or not.
export const LIMITS = {
  attemptsPerHour: 5, // per network address
  attemptsPerDay: 20, // per network address
  createdPerDay: 3, // new dog houses per network address
  createdAllPerDay: 50 // new dog houses from everyone together
};
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const attempts = new Map();
const created = new Map();
let createdAll = [];

const recent = (times, window, now) => (times || []).filter(time => now - time < window);

// Seconds to wait before this address may try again, or 0 when it may try now.
export function signupWaitSeconds(address, now = Date.now()) {
  const tried = recent(attempts.get(address), DAY, now);
  const made = recent(created.get(address), DAY, now);
  const madeAll = recent(createdAll, DAY, now);
  const waits = [];
  const lastHour = tried.filter(time => now - time < HOUR);
  if (lastHour.length >= LIMITS.attemptsPerHour) waits.push(lastHour[0] + HOUR - now);
  if (tried.length >= LIMITS.attemptsPerDay) waits.push(tried[0] + DAY - now);
  if (made.length >= LIMITS.createdPerDay) waits.push(made[0] + DAY - now);
  if (madeAll.length >= LIMITS.createdAllPerDay) waits.push(madeAll[0] + DAY - now);
  return waits.length ? Math.ceil(Math.max(...waits) / 1000) : 0;
}

export function noteSignupAttempt(address, now = Date.now()) {
  attempts.set(address, [...recent(attempts.get(address), DAY, now), now]);
  // Keep the memory small: forget addresses with nothing in the last day.
  if (attempts.size > 5000) {
    for (const [key, times] of attempts) if (!recent(times, DAY, now).length) attempts.delete(key);
  }
}

export function noteDogHouseCreated(address, now = Date.now()) {
  created.set(address, [...recent(created.get(address), DAY, now), now]);
  createdAll = [...recent(createdAll, DAY, now), now];
}
