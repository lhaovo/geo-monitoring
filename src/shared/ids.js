import { randomUUID } from 'node:crypto';

export function createId() {
  return randomUUID();
}

export function now() {
  return new Date().toISOString();
}
