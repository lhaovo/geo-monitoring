import { ValidationError } from '../shared/errors.js';

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/u;
const RESERVED_PROFILE_IDS = new Set(['chrome', 'index', 'profile']);

export function normalizeProfileId(profileId) {
  const normalized = String(profileId ?? '').trim().toLowerCase();
  if (!PROFILE_ID_PATTERN.test(normalized) || RESERVED_PROFILE_IDS.has(normalized)) {
    throw new ValidationError('Profile 标识只能包含小写字母、数字、下划线或连字符，长度不超过 48 个字符。');
  }
  return normalized;
}

function normalizePhone(value) {
  let phone = String(value ?? '').trim().replace(/[\s()-]/gu, '');
  if (!/^\+?\d{7,20}$/u.test(phone)) return null;
  if (phone.startsWith('+')) phone = `+${phone.slice(1).replace(/\D/gu, '')}`;
  if (!phone.startsWith('+') && phone.length === 13 && phone.startsWith('86')) phone = phone.slice(2);
  if (phone.startsWith('+86') && phone.length === 14) phone = phone.slice(3);
  return phone;
}

// 账号标识是 Profile 的唯一身份来源：手机号归一化成 E.164 形式，其他账号
// 使用 NFKC 归一化后的小写形式，保证同一账号始终映射到同一个 Profile。
export function normalizeAccountIdentity(account) {
  const text = String(account ?? '').trim();
  if (!text) return '';
  const phone = normalizePhone(text);
  if (phone) return phone;
  return text.normalize('NFKC').toLowerCase();
}

export function profileIdFromAccount(account) {
  const identity = normalizeAccountIdentity(account);
  if (!identity) throw new ValidationError('必须提供账号或手机号。');
  const slug = identity
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  if (!slug || !PROFILE_ID_PATTERN.test(slug) || RESERVED_PROFILE_IDS.has(slug)) {
    throw new ValidationError(`无法从账号「${account}」推导 Profile 标识，请改用手机号，或由字母、数字、点、连字符组成的账号。`);
  }
  return slug;
}

export function profileBindingId(platformId, profileId) {
  return `${platformId}:${normalizeProfileId(profileId)}`;
}
