async function request(url, options) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
  });
  if (response.status === 204) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? '请求失败。');
  return payload;
}

export const api = {
  listBrands: () => request('/api/brands'),
  createBrand: (body) => request('/api/brands', { method: 'POST', body: JSON.stringify(body) }),
  getBrandOverview: (brandId, days = 30) => request(`/api/brands/${brandId}/overview?days=${days}`),
  getBrandSources: (brandId, days = 30, platformId = '') => request(`/api/brands/${brandId}/sources?days=${days}${platformId ? `&platformId=${encodeURIComponent(platformId)}` : ''}`),
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
  listRuns: (projectId) => request(`/api/runs?projectId=${encodeURIComponent(projectId)}`),
  createRun: (body) => request('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  createMonitoringRun: (body) => request('/api/monitoring-runs', { method: 'POST', body: JSON.stringify(body) }),
  getRun: (runId) => request(`/api/runs/${runId}`),
  cancelRun: (runId) => request(`/api/runs/${runId}/cancel`, { method: 'POST' }),
};
