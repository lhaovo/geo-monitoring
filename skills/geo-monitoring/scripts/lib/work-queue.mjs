import crypto from 'node:crypto';

function nowIso(value = new Date()) {
  return new Date(value).toISOString();
}

function timeMs(value = new Date()) {
  return new Date(value).getTime();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function questionIds(questions = []) {
  return questions.map((question) => (typeof question === 'string' ? question : question?.id))
    .filter(Boolean)
    .map(String);
}

function platformIds(platforms = []) {
  return [...new Set(platforms.map((platform) => (
    typeof platform === 'string' ? platform : (platform?.id ?? platform?.platformId)
  )).filter(Boolean).map(String))];
}

function createPlatformState(ids) {
  return {
    pending: [...ids],
    claimed: {},
    completed: {},
    failed: {},
    attempts: {},
    retryAfter: {},
  };
}

function ensurePlatformState(state, platformId, ids) {
  const current = state.platforms[platformId] ?? createPlatformState(ids);
  const next = {
    pending: Array.isArray(current.pending) ? current.pending.map(String) : [...ids],
    claimed: current.claimed && typeof current.claimed === 'object' ? deepClone(current.claimed) : {},
    completed: current.completed && typeof current.completed === 'object' ? deepClone(current.completed) : {},
    failed: current.failed && typeof current.failed === 'object' ? deepClone(current.failed) : {},
    attempts: current.attempts && typeof current.attempts === 'object' ? deepClone(current.attempts) : {},
    retryAfter: current.retryAfter && typeof current.retryAfter === 'object' ? deepClone(current.retryAfter) : {},
  };

  const known = new Set(ids);
  next.pending = next.pending.filter((id) => known.has(id));
  for (const key of Object.keys(next.claimed)) if (!known.has(key)) delete next.claimed[key];
  for (const key of Object.keys(next.completed)) if (!known.has(key)) delete next.completed[key];
  for (const key of Object.keys(next.failed)) if (!known.has(key)) delete next.failed[key];
  for (const key of Object.keys(next.attempts)) if (!known.has(key)) delete next.attempts[key];
  for (const key of Object.keys(next.retryAfter)) if (!known.has(key)) delete next.retryAfter[key];

  for (const id of ids) {
    const claimed = Boolean(next.claimed[id]);
    const completed = Boolean(next.completed[id]);
    const failed = Boolean(next.failed[id]);
    if (!claimed && !completed && !failed && !next.pending.includes(id)) next.pending.push(id);
  }
  return next;
}

function persistShape(state, now = new Date()) {
  state.updatedAt = nowIso(now);
  return state;
}

function validLease(claim, { platformId, questionId, bindingId, leaseId }) {
  return Boolean(claim)
    && claim.platformId === platformId
    && claim.questionId === questionId
    && claim.bindingId === bindingId
    && claim.leaseId === leaseId;
}

function removePending(platformState, questionId) {
  platformState.pending = platformState.pending.filter((id) => id !== questionId);
}

function addPending(platformState, questionId) {
  if (!platformState.pending.includes(questionId)) platformState.pending.push(questionId);
}

export function isWorkQueueSnapshot(snapshot, { taskId, questions = [], platforms = [] } = {}) {
  if (!snapshot || snapshot.version !== 1) return false;
  if (taskId && snapshot.taskId !== taskId) return false;
  if (!snapshot.platforms || typeof snapshot.platforms !== 'object') return false;
  const ids = platformIds(platforms);
  for (const platformId of ids) {
    const state = snapshot.platforms[platformId];
    if (!state || typeof state !== 'object') return false;
    if (!Array.isArray(state.pending)) return false;
    for (const key of ['claimed', 'completed', 'failed', 'attempts', 'retryAfter']) {
      if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) return false;
    }
  }
  return true;
}

export function createWorkQueue({ taskId, questions = [], platforms = [], now = new Date() } = {}) {
  const ids = questionIds(questions);
  const states = {};
  for (const platformId of platformIds(platforms)) states[platformId] = createPlatformState(ids);
  return {
    version: 1,
    taskId: taskId ?? null,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    platforms: states,
  };
}

export function restoreWorkQueue(snapshot, { taskId, questions = [], platforms = [], now = new Date() } = {}) {
  if (!snapshot || snapshot.version !== 1 || (taskId && snapshot.taskId !== taskId)) {
    return createWorkQueue({ taskId, questions, platforms, now });
  }
  const ids = questionIds(questions);
  const state = {
    version: 1,
    taskId: taskId ?? snapshot.taskId ?? null,
    createdAt: snapshot.createdAt ?? nowIso(now),
    updatedAt: nowIso(now),
    platforms: {},
  };
  const snapshots = snapshot.platforms && typeof snapshot.platforms === 'object' ? snapshot.platforms : {};
  for (const platformId of platformIds(platforms)) {
    state.platforms[platformId] = ensurePlatformState(
      { platforms: { [platformId]: snapshots[platformId] } },
      platformId,
      ids,
    );
  }
  return persistShape(state, now);
}

export function expireClaims(state, { now = new Date() } = {}) {
  const current = timeMs(now);
  const expired = [];
  for (const [platformId, platformState] of Object.entries(state.platforms)) {
    for (const [questionId, claim] of Object.entries(platformState.claimed)) {
      if (timeMs(claim.expiresAt) > current) continue;
      delete platformState.claimed[questionId];
      if (!platformState.completed[questionId] && !platformState.failed[questionId]) addPending(platformState, questionId);
      expired.push({ platformId, ...claim });
    }
  }
  if (expired.length) persistShape(state, now);
  return expired;
}

export function claimNext(state, { platformId, bindingId, leaseMs = 360000, now = new Date() } = {}) {
  const platformState = state.platforms[platformId];
  if (!platformState) return null;
  const current = timeMs(now);
  const questionId = platformState.pending.find((id) => {
    if (platformState.completed[id] || platformState.failed[id] || platformState.claimed[id]) return false;
    const retryAt = platformState.retryAfter[id];
    return !retryAt || timeMs(retryAt) <= current;
  });
  if (!questionId) return null;

  removePending(platformState, questionId);
  const attempt = (Number(platformState.attempts[questionId]) || 0) + 1;
  const lease = {
    platformId,
    questionId,
    bindingId,
    leaseId: crypto.randomUUID(),
    attempt,
    claimedAt: nowIso(now),
    expiresAt: new Date(current + Math.max(1, Number(leaseMs) || 360000)).toISOString(),
  };
  platformState.attempts[questionId] = attempt;
  platformState.claimed[questionId] = lease;
  delete platformState.retryAfter[questionId];
  persistShape(state, now);
  return { ...lease };
}

export function heartbeatClaim(state, { platformId, questionId, bindingId, leaseId, leaseMs = 360000, now = new Date() } = {}) {
  const platformState = state.platforms[platformId];
  const claim = platformState?.claimed[questionId];
  if (!validLease(claim, { platformId, questionId, bindingId, leaseId })) return false;
  if (timeMs(claim.expiresAt) <= timeMs(now)) return false;
  claim.expiresAt = new Date(timeMs(now) + Math.max(1, Number(leaseMs) || 360000)).toISOString();
  persistShape(state, now);
  return true;
}

export function completeClaim(state, { platformId, questionId, bindingId, leaseId, now = new Date() } = {}) {
  const platformState = state.platforms[platformId];
  const claim = platformState?.claimed[questionId];
  if (!validLease(claim, { platformId, questionId, bindingId, leaseId })) return null;
  if (timeMs(claim.expiresAt) <= timeMs(now)) return null;
  delete platformState.claimed[questionId];
  delete platformState.retryAfter[questionId];
  platformState.completed[questionId] = {
    bindingId,
    attempt: claim.attempt,
    completedAt: nowIso(now),
  };
  persistShape(state, now);
  return { ...platformState.completed[questionId], questionId };
}

export function failClaim(state, {
  platformId,
  questionId,
  bindingId,
  leaseId,
  category = 'platform_error',
  message = '',
  retryable = true,
  forceRetry = false,
  maxAttempts = 3,
  retryDelayMs = 0,
  now = new Date(),
} = {}) {
  const platformState = state.platforms[platformId];
  const claim = platformState?.claimed[questionId];
  if (!validLease(claim, { platformId, questionId, bindingId, leaseId })) return null;
  if (timeMs(claim.expiresAt) <= timeMs(now)) return null;
  delete platformState.claimed[questionId];
  const attempt = Number(claim.attempt) || Number(platformState.attempts[questionId]) || 1;
  const canRetry = Boolean(retryable) && (forceRetry || attempt < Math.max(1, Number(maxAttempts) || 3));
  if (canRetry) {
    addPending(platformState, questionId);
    const baseDelay = Math.max(0, Number(retryDelayMs) || 0);
    const delay = forceRetry ? 0 : baseDelay * Math.max(1, 2 ** (attempt - 1));
    if (delay > 0) platformState.retryAfter[questionId] = new Date(timeMs(now) + delay).toISOString();
    else delete platformState.retryAfter[questionId];
    persistShape(state, now);
    return { retried: true, attempt, category, message, questionId };
  }
  delete platformState.retryAfter[questionId];
  platformState.failed[questionId] = {
    bindingId,
    attempt,
    category,
    message,
    failedAt: nowIso(now),
  };
  persistShape(state, now);
  return { retried: false, attempt, category, message, questionId };
}

export function requeueClaimsForBinding(state, { bindingId, now = new Date() } = {}) {
  const requeued = [];
  for (const [platformId, platformState] of Object.entries(state.platforms)) {
    for (const [questionId, claim] of Object.entries(platformState.claimed)) {
      if (claim.bindingId !== bindingId) continue;
      delete platformState.claimed[questionId];
      if (!platformState.completed[questionId] && !platformState.failed[questionId]) addPending(platformState, questionId);
      requeued.push({ platformId, ...claim });
    }
  }
  if (requeued.length) persistShape(state, now);
  return requeued;
}

export function requeueAllClaims(state, { now = new Date() } = {}) {
  const requeued = [];
  for (const [platformId, platformState] of Object.entries(state.platforms)) {
    for (const [questionId, claim] of Object.entries(platformState.claimed)) {
      delete platformState.claimed[questionId];
      if (!platformState.completed[questionId] && !platformState.failed[questionId]) addPending(platformState, questionId);
      requeued.push({ platformId, ...claim });
    }
  }
  if (requeued.length) persistShape(state, now);
  return requeued;
}

export function seedCompleted(state, { platformId, questionId, bindingId = null, attempt = 1, now = new Date() } = {}) {
  const platformState = state.platforms[platformId];
  if (!platformState) return false;
  const previous = platformState.completed[questionId];
  if (previous) return false;
  removePending(platformState, questionId);
  delete platformState.claimed[questionId];
  delete platformState.failed[questionId];
  delete platformState.retryAfter[questionId];
  platformState.completed[questionId] = {
    bindingId,
    attempt: Number(attempt) || Number(platformState.attempts[questionId]) || 1,
    completedAt: nowIso(now),
  };
  platformState.attempts[questionId] = Math.max(
    Number(platformState.attempts[questionId]) || 0,
    platformState.completed[questionId].attempt,
  );
  persistShape(state, now);
  return true;
}

export function markPendingFailed(state, { platformId, category = 'no_available_profile', message = '', now = new Date() } = {}) {
  const platformState = state.platforms[platformId];
  if (!platformState) return 0;
  let count = 0;
  for (const questionId of [...platformState.pending]) {
    if (platformState.completed[questionId] || platformState.failed[questionId] || platformState.claimed[questionId]) continue;
    removePending(platformState, questionId);
    delete platformState.retryAfter[questionId];
    platformState.failed[questionId] = {
      bindingId: null,
      attempt: Number(platformState.attempts[questionId]) || 0,
      category,
      message,
      failedAt: nowIso(now),
    };
    count += 1;
  }
  if (count) persistShape(state, now);
  return count;
}

export function hasImmediateWork(state, { platformId, now = new Date() } = {}) {
  const platformState = state.platforms[platformId];
  if (!platformState) return false;
  const current = timeMs(now);
  return platformState.pending.some((questionId) => {
    if (platformState.completed[questionId] || platformState.failed[questionId] || platformState.claimed[questionId]) return false;
    const retryAt = platformState.retryAfter[questionId];
    return !retryAt || timeMs(retryAt) <= current;
  });
}

export function hasOutstandingWork(state, { platformId } = {}) {
  const platformState = state.platforms[platformId];
  if (!platformState) return false;
  const pending = platformState.pending.some((id) => !platformState.completed[id] && !platformState.failed[id] && !platformState.claimed[id]);
  return pending || Object.keys(platformState.claimed).length > 0;
}

export function nextAvailableAt(state, { platformIds: selectedPlatformIds, now = new Date() } = {}) {
  const ids = selectedPlatformIds ?? Object.keys(state.platforms);
  const current = timeMs(now);
  let earliest = null;
  for (const platformId of ids) {
    const platformState = state.platforms[platformId];
    if (!platformState) continue;
    for (const questionId of platformState.pending) {
      if (platformState.completed[questionId] || platformState.failed[questionId] || platformState.claimed[questionId]) continue;
      const retryAt = timeMs(platformState.retryAfter[questionId] ?? now);
      earliest = earliest === null ? retryAt : Math.min(earliest, retryAt);
    }
    for (const claim of Object.values(platformState.claimed)) {
      const expiresAt = timeMs(claim.expiresAt);
      earliest = earliest === null ? expiresAt : Math.min(earliest, expiresAt);
    }
  }
  if (earliest === null) return null;
  return new Date(Math.max(current, earliest));
}

export function summarizeQueue(state, { platformIds: selectedPlatformIds } = {}) {
  const ids = [...new Set(selectedPlatformIds ?? Object.keys(state.platforms))];
  return ids.filter((id) => state.platforms[id]).map((platformId) => {
    const platformState = state.platforms[platformId];
    const completedByBinding = {};
    const failedByBinding = {};
    for (const item of Object.values(platformState.completed)) {
      if (!item.bindingId) continue;
      completedByBinding[item.bindingId] = (completedByBinding[item.bindingId] ?? 0) + 1;
    }
    for (const item of Object.values(platformState.failed)) {
      if (!item.bindingId) continue;
      failedByBinding[item.bindingId] = (failedByBinding[item.bindingId] ?? 0) + 1;
    }
    return {
      platformId,
      total: platformState.pending.length + Object.keys(platformState.claimed).length
        + Object.keys(platformState.completed).length + Object.keys(platformState.failed).length,
      pending: platformState.pending.length,
      claimed: Object.keys(platformState.claimed).length,
      completed: Object.keys(platformState.completed).length,
      failed: Object.keys(platformState.failed).length,
      attempts: Object.values(platformState.attempts).reduce((sum, value) => sum + (Number(value) || 0), 0),
      completedByBinding,
      failedByBinding,
    };
  });
}

export function snapshotWorkQueue(state) {
  return deepClone(persistShape(state, new Date()));
}