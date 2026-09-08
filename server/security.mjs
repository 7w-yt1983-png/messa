import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, options);
  return `scrypt-v1$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [version, salt, expected] = encoded.split('$');
  if (version !== 'scrypt-v1' || !salt || expected?.length !== 128) return false;
  const hash = await scrypt(password, salt, 64, options);
  return timingSafeEqual(hash, Buffer.from(expected, 'hex'));
}
export function text(value, name, min = 1, max = 4000) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /\u0000/.test(value)) fail(400, `${name}: допустимо от ${min} до ${max} символов.`);
  return value.trim();
}
export function username(value) {
  const result = text(value, 'Имя пользователя', 3, 24).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(result)) fail(400, 'В имени пользователя допустимы латинские буквы, цифры и _.');
  return result;
}
export function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) fail(400, 'Пароль должен содержать от 12 до 128 символов.');
  return value;
}
export function integer(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(400, 'Некорректное числовое значение.');
  return n;
}
export async function readBody(req, limit = 32 * 1024) {
  if (Number(req.headers['content-length'] || 0) > limit) fail(413, 'Превышен допустимый размер запроса.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Превышен допустимый размер запроса.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'Требуется application/json.');
  let value;
  try { value = JSON.parse((await readBody(req)).toString()); }
  catch (error) { if (error instanceof HttpError) throw error; fail(400, 'Некорректный JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Ожидается JSON-объект.');
  return value;
}
export function cookieValue(req, name) {
  return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
}
export class RateLimiter {
  buckets = new Map();
  take(key, limit, windowMs) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) bucket = { count: 0, until: now + windowMs };
    bucket.count++; this.buckets.set(key, bucket);
    if (bucket.count > limit) fail(429, 'Слишком много запросов. Подождите немного и повторите.');
  }
  prune() { const now = Date.now(); for (const [k, v] of this.buckets) if (v.until <= now) this.buckets.delete(k); }
}
export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}
