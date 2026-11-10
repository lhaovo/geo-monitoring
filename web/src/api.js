async function request(url, options = {}) {
  // 没有请求体时不要带 content-type，否则服务端会因「空的 JSON 体」直接拒绝。
  const { headers: extraHeaders, body, ...rest } = options;
  const headers = { ...(extraHeaders ?? {}) };
  if (body !== undefined && body !== null && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(url, { ...rest, headers, ...(body === undefined || body === null ? {} : { body }) });
  if (response.status === 204) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? '请求失败。');
  return payload;
}

export const api = {
  listBrands: () => request('/api/brands'),
  createBrand: (body) => request('/api/brands', { method: 'POST', body: JSON.stringify(body) }),
  getBrandOverview: (brandId, days = 30) => request(`/api/brands/${brandId}/overview?days=${days}`),
  getBrandSources: (brandId, params = {}) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      query.set(key, String(value));
    });
    const suffix = query.toString();
    return request(`/api/brands/${brandId}/sources${suffix ? `?${suffix}` : ''}`);
  },
  recomputeBrandAnalysis: (brandId) => request(`/api/brands/${brandId}/recompute-analysis`, { method: 'POST' }),
  getBrandOwnedLinks: (brandId, params = {}) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      query.set(key, String(value));
    });
    const suffix = query.toString();
    return request(`/api/brands/${brandId}/owned-links${suffix ? `?${suffix}` : ''}`);
  },
  importBrandLinks: (brandId, body) => request(`/api/brands/${brandId}/owned-links`, { method: 'POST', body: JSON.stringify(body) }),
  updateBrandLink: (linkId, body) => request(`/api/brands/owned-links/${linkId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteBrandLink: (linkId) => request(`/api/brands/owned-links/${linkId}`, { method: 'DELETE' }),
  recomputeBrandLinkCitations: (brandId) => request(`/api/brands/${brandId}/owned-links/recompute`, { method: 'POST', body: '{}' }),
  listQuestions: (brandId) => request(`/api/brands/${brandId}/questions`),
  createQuestions: (brandId, body) => request(`/api/brands/${brandId}/questions`, { method: 'POST', body: JSON.stringify(body) }),
  updateQuestion: (questionId, body) => request(`/api/brands/questions/${questionId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteQuestion: (questionId) => request(`/api/brands/questions/${questionId}`, { method: 'DELETE' }),
  listProjects: () => request('/api/projects'),
  createProject: (body) => request('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  listPrompts: (projectId) => request(`/api/projects/${projectId}/prompts`),
  createPrompt: (projectId, body) => request(`/api/projects/${projectId}/prompts`, { method: 'POST', body: JSON.stringify(body) }),
  listPlatforms: () => request('/api/platforms'),
  listPlatformStatus: () => request('/api/platforms/status'),
  listProfiles: (platformId = '') => request(`/api/profiles${platformId ? `?platformId=${encodeURIComponent(platformId)}` : ''}`),
  clearPlatformCooldown: (platformId) => request(`/api/platforms/${encodeURIComponent(platformId)}/cooldown/clear`, { method: 'POST', body: '{}' }),
  clearPlatformManualWindow: (platformId) => request(`/api/platforms/${encodeURIComponent(platformId)}/manual-window/clear`, { method: 'POST', body: '{}' }),
  createProfile: (body) => request('/api/profiles', { method: 'POST', body: JSON.stringify(body) }),
  updateProfile: (profileId, body) => request(`/api/profiles/${profileId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  disableProfile: (profileId) => request(`/api/profiles/${profileId}/disable`, { method: 'POST' }),
  startLoginSession: (body) => request('/api/login-sessions', { method: 'POST', body: JSON.stringify(body) }),
  listLoginSessions: () => request('/api/login-sessions'),
  getLoginSession: (sessionId) => request(`/api/login-sessions/${sessionId}`),
  closeLoginSession: (sessionId) => request(`/api/login-sessions/${sessionId}/close`, { method: 'POST' }),
  listRuns: (projectId) => request(`/api/runs?projectId=${encodeURIComponent(projectId)}`),
  createRun: (body) => request('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  createMonitoringRun: (body) => request('/api/monitoring-runs', { method: 'POST', body: JSON.stringify(body) }),
  getRun: (runId) => request(`/api/runs/${runId}`),
  cancelRun: (runId) => request(`/api/runs/${runId}/cancel`, { method: 'POST' }),
};
