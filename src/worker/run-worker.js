import { EventEmitter } from 'node:events';
import { executePlatformRun } from '../infrastructure/platform-runner.js';
import { getPlatformAdapter } from '../platforms/index.js';
import { createWorkQueue, DEFAULT_HEARTBEAT_MS, DEFAULT_MAX_ATTEMPTS } from './work-queue.js';
import { createId } from '../shared/ids.js';

// 每个平台是一条独立的共享队列，Worker 动态从中领取任务：
// - 全局并发上限由 run.concurrency 控制（1–6）
// - 同一平台同时只跑一个任务
// - 领取时写入租约，执行中用心跳续租，崩溃后由过期回收重新入队
export class RunWorker extends EventEmitter {
  constructor({ repository, paths, execute = executePlatformRun }) {
    super();
    this.repository = repository;
    this.paths = paths;
    this.execute = execute;
    this.workQueue = createWorkQueue({ repository });
    this.runQueue = [];
    this.processing = false;
    this.idleWaiters = [];
    this.activeRunStates = new Map();
    this.heartbeatTimer = setInterval(() => this.pulseHeartbeats(), DEFAULT_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  async cancelRun(runId) {
    const state = this.activeRunStates.get(runId);
    if (!state) return;
    state.cancelling = true;
    for (const controller of state.controllers) controller.abort();
    const activeTasks = [...state.tasks];
    if (!activeTasks.length) return;
    await Promise.race([
      Promise.allSettled(activeTasks),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  enqueue(runId) {
    if (!this.runQueue.includes(runId)) this.runQueue.push(runId);
    void this.process();
  }

  // 定期续租所有正在执行的任务，避免长回答被误判为中断。
  pulseHeartbeats() {
    for (const state of this.activeRunStates.values()) {
      for (const task of state.leases) {
        try {
          this.workQueue.heartbeat(task.platformRunId, task.leaseId);
        } catch {
          // 心跳失败不影响正在执行的任务，下一次心跳会重试。
        }
      }
    }
  }

  async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.runQueue.length > 0) {
        const runId = this.runQueue.shift();
        await this.processRun(runId);
      }
    } finally {
      this.processing = false;
      if (this.runQueue.length === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  whenIdle() {
    if (!this.processing && this.runQueue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  emitEvent(event) {
    this.repository.addEvent(event);
    this.emit('event', event);
  }

  async processRun(runId) {
    const run = this.repository.getRun(runId);
    if (run.status === 'cancelled' || this.repository.isCancellationRequested(runId)) return;
    const state = { controllers: new Set(), tasks: new Set(), leases: new Set(), cancelling: false };
    this.activeRunStates.set(runId, state);
    try {
      this.repository.startRun(runId);
      this.emitEvent({ runId, message: `监测任务开始执行，全局最多并发 ${run.concurrency} 项，同平台最多运行 1 项${run.appendSearchPrompt ? '，已附加搜索提示词' : ''}。` });
      await this.processPlatformQueue(runId, run.targetPlatforms, run.concurrency, run.appendSearchPrompt);
      const completed = this.repository.finishRun(runId);
      this.emitEvent({ runId, message: `监测任务结束，状态：${completed.status}。` });
    } finally {
      this.activeRunStates.delete(runId);
    }
  }

  // 动态队列调度：每个平台一个消费循环，循环内不断领取下一条待处理任务，
  // 由全局并发信号量限制同时执行的任务总数。
  async processPlatformQueue(runId, platformIds, concurrency, appendSearchPrompt) {
    let active = 0;
    const waiters = [];
    const acquire = async () => {
      if (active < concurrency) {
        active += 1;
        return;
      }
      await new Promise((resolve) => waiters.push(resolve));
      active += 1;
    };
    const release = () => {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    };

    const platformLoops = platformIds.map((platformId) => this.consumePlatformQueue({
      runId, platformId, appendSearchPrompt, acquire, release,
    }));
    await Promise.allSettled(platformLoops);
    while (waiters.length) waiters.shift()();
  }

  async consumePlatformQueue({ runId, platformId, appendSearchPrompt, acquire, release }) {
    while (!this.repository.isCancellationRequested(runId)) {
      const leaseId = createId();
      const platformRun = this.workQueue.claimNext(runId, platformId, { leaseId });
      if (!platformRun) return;

      await acquire();
      let bound;
      try {
        bound = this.bindProfile(platformRun);
      } catch (error) {
        release();
        this.repository.failPlatformRun(platformRun.id, error.message);
        this.emitEvent({ runId, platformRunId: platformRun.id, level: 'error', message: error.message });
        continue;
      }
      const task = this.processPlatformRun(runId, bound, appendSearchPrompt, leaseId)
        .finally(() => {
          release();
          this.activeRunStates.get(runId)?.tasks.delete(task);
          for (const lease of this.activeRunStates.get(runId)?.leases ?? []) {
            if (lease.leaseId === leaseId) this.activeRunStates.get(runId)?.leases.delete(lease);
          }
        });
      this.activeRunStates.get(runId)?.tasks.add(task);

      // 队列消费与任务执行解耦：执行期间继续领取下一条，
      // 但同平台限制为 1，因此这里等待当前任务结束再领取。
      await task;
    }
    if (this.repository.isCancellationRequested(runId)) {
      this.emitEvent({ runId, message: '任务已取消，停止启动后续检查。' });
    }
  }

  // 为任务绑定一个可用的登录账号：账号决定浏览器用户数据目录，
  // 不同账号的登录态互相隔离。
  // 该平台没有任何登录账号时直接报错，不再退回平台默认目录，避免产出空回答。
  bindProfile(platformRun) {
    if (platformRun.profileId) {
      const existing = this.repository.getProfileByBinding(platformRun.platformId, platformRun.profileId);
      if (existing) return platformRun;
    }
    const profile = this.repository.pickAvailableProfile(platformRun.platformId);
    if (!profile) {
      const error = new Error(`${platformRun.platformId} 没有可用的登录账号，请先在「平台与登录」页面添加账号并完成登录。`);
      error.code = 'login_required';
      throw error;
    }
    this.repository.assignPlatformRunProfile(platformRun.id, profile.profileId);
    return { ...platformRun, profileId: profile.profileId };
  }

  async processPlatformRun(runId, platformRun, appendSearchPrompt, leaseId) {
    const controller = new AbortController();
    const state = this.activeRunStates.get(runId);
    state?.controllers.add(controller);
    state?.leases.add({ platformRunId: platformRun.id, leaseId });
    if (this.repository.isCancellationRequested(runId)) {
      this.repository.cancelPlatformRun(platformRun.id);
      state?.controllers.delete(controller);
      return;
    }
    this.emitEvent({ runId, platformRunId: platformRun.id, message: `开始执行 ${platformRun.platformId}。` });
    try {
      const adapter = getPlatformAdapter(platformRun.platformId);
      const result = await this.execute({
        platformRun,
        adapter,
        paths: this.paths,
        mode: platformRun.mode,
        appendSearchPrompt,
        signal: controller.signal,
        emit: (message) => this.emitEvent({ runId, platformRunId: platformRun.id, message }),
      });
      if (controller.signal.aborted || this.repository.isCancellationRequested(runId)) {
        this.repository.addArtifacts(platformRun.id, result.artifacts);
        this.repository.cancelPlatformRun(platformRun.id);
        this.emitEvent({ runId, platformRunId: platformRun.id, message: `${platformRun.platformId} 已强制取消。` });
        return;
      }
      this.repository.completePlatformRun(platformRun.id, result);
      if (platformRun.profileId) this.repository.markProfileUsedByBinding(platformRun.platformId, platformRun.profileId, { health: 'ready' });
      this.emitEvent({ runId, platformRunId: platformRun.id, message: `${adapter.label} 回答与引用已保存。` });
    } catch (error) {
      this.repository.addArtifacts(platformRun.id, error.artifacts);
      if (controller.signal.aborted || this.repository.isCancellationRequested(runId)) {
        this.repository.cancelPlatformRun(platformRun.id);
        this.emitEvent({ runId, platformRunId: platformRun.id, message: `${platformRun.platformId} 已强制取消。` });
      } else {
        this.handlePlatformRunFailure(runId, platformRun, leaseId, error);
      }
    } finally {
      state?.controllers.delete(controller);
    }
  }

  // 失败处理：账号受限时立刻停止该 Profile 的后续任务；
  // 其他失败按剩余尝试次数重新入队，便于共享队列自动重试。
  handlePlatformRunFailure(runId, platformRun, leaseId, error) {
    const restrictedUntil = error?.restrictedUntil ?? null;
    if (error?.code === 'account_restricted' || restrictedUntil) {
      this.repository.setPlatformRunRestricted(platformRun.id, restrictedUntil);
      this.repository.failPlatformRun(platformRun.id, error.message);
      const profileId = platformRun.profileId;
      if (profileId) {
        this.repository.updateProfileByBinding(platformRun.platformId, profileId, {
          health: 'restricted', restrictedUntil, lastError: error.message,
        });
        this.workQueue.requeueForProfile(platformRun.platformId, profileId, '账号受限，已重新排队等待其他登录态接手。');
      }
      this.emitEvent({ runId, platformRunId: platformRun.id, level: 'error', message: `${platformRun.platformId} 账号受限，已暂停该登录态：${error.message}` });
      return;
    }

    if (error?.code === 'login_required' || error?.code === 'human_challenge') {
      // 登录态失效或遇到人工校验：重试没有意义，直接结束该问题并更新登录态状态。
      this.repository.failPlatformRun(platformRun.id, error.message);
      const profileId = platformRun.profileId;
      if (profileId) {
        this.repository.updateProfileByBinding(platformRun.platformId, profileId, {
          health: error.code === 'login_required' ? 'expired' : 'error',
          lastError: error.message,
        });
      }
      this.emitEvent({ runId, platformRunId: platformRun.id, level: 'error', message: `${platformRun.platformId} 执行中断：${error.message}` });
      return;
    }

    const outcome = this.workQueue.fail(platformRun.id, leaseId, error.message, { maxAttempts: DEFAULT_MAX_ATTEMPTS });
    if (outcome.requeued) {
      this.emitEvent({ runId, platformRunId: platformRun.id, level: 'error', message: `${platformRun.platformId} 执行失败，已重新排队（第 ${outcome.attempts} 次）：${error.message}` });
    } else {
      this.emitEvent({ runId, platformRunId: platformRun.id, level: 'error', message: `${platformRun.platformId} 执行失败，已达最大重试次数：${error.message}` });
    }
  }

  async stop() {
    clearInterval(this.heartbeatTimer);
  }
}
