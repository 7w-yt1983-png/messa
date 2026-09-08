import path from 'node:path';

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const origin = env.APP_ORIGIN || 'http://localhost:3000';
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('APP_ORIGIN must be a bare http(s) origin, without a trailing slash.');
  if (production && parsed.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN.');
  const registration = env.ALLOW_REGISTRATION ? env.ALLOW_REGISTRATION === 'true' : !production;
  const registrationCode = env.REGISTRATION_CODE || '';
  if (production && registration && registrationCode.length < 20) throw new Error('Public registration requires a REGISTRATION_CODE of at least 20 characters.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT.');
  return {
    production, origin, port, host: env.HOST || '127.0.0.1', registration, registrationCode,
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    cookie: production ? '__Host-messa' : 'messa_session',
    sessionMs: 7 * 24 * 60 * 60 * 1000,
    maxFileBytes: 10 * 1024 * 1024,
    userQuota: 200 * 1024 * 1024,
    totalQuota: 5 * 1024 * 1024 * 1024,
  };
}
