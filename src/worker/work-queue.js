import { createId, now } from '../shared/ids.js';

// 动态共享队列：每个平台维护一条待处理问题队列，Worker 以「领取」的方式
// 动态取走任务，而不是按 prompt×platform 静态预分配顺序执行。
//
// 租约（lease）保证 Worker 崩溃后未完成的问题可以回到队列：
// - claim  时写入 lease_id 与 lease_expires_at
// - 心跳 定期延长租约
// - 租约过期（expireClaims）后任务重新变为 queued，由其他 Worker 接手

export const DEFAULT_LEASE_MS = 120_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

function leaseExpiry(leaseMs) {
  return new Date(Date.now() + leaseMs).toISOString();
}

export function createWorkQueue({ repository }) {
  const repo = repository;

  return {
    // 领取一个待处理任务。同一平台同时只允许一个在跑任务，因此按平台串行领取。
    claimNext(runId, platformId, { leaseMs = DEFAULT_LEASE_MS, leaseId = createId() } = {}) {
      return repo.claimNextPlatformRun(runId, platformId, {
        leaseId,
        leaseExpiresAt: leaseExpiry(leaseMs),
      });
    },

    heartbeat(platformRunId, leaseId, { leaseMs = DEFAULT_LEASE_MS } = {}) {
      return repo.heartbeatPlatformRun(platformRunId, {
        leaseId,
        leaseExpiresAt: leaseExpiry(leaseMs),
      });
    },

    complete(platformRunId, leaseId) {
      return repo.completePlatformRunClaim(platformRunId, leaseId);
    },

    // 失败后按剩余尝试次数决定是重新入队还是最终失败。
    fail(platformRunId, leaseId, errorMessage, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
      return repo.failPlatformRunClaim(platformRunId, leaseId, errorMessage, { maxAttempts });
    },

    // 把过期租约的任务放回队列，用于恢复崩溃 Worker 遗留的任务。
    expireClaims() {
      return repo.expirePlatformRunClaims(now());
    },

    // 账号受限时，把该 Profile 名下未完成的任务放回队列并交给其他 Profile。
    requeueForProfile(platformId, profileId, reason) {
      return repo.requeuePlatformRunsForProfile(platformId, profileId, reason);
    },

    summarize(runId) {
      return repo.summarizeRunQueue(runId);
    },
  };
}
