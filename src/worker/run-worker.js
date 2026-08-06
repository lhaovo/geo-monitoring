import { EventEmitter } from 'node:events';
import { executePlatformRun } from '../infrastructure/platform-runner.js';
import { getPlatformAdapter } from '../platforms/index.js';

export class RunWorker extends EventEmitter {
  constructor({ repository, paths, execute = executePlatformRun }) {
    super();
    this.repository = repository;
    this.paths = paths;
    this.execute = execute;
    this.queue = [];
    this.processing = false;
    this.idleWaiters = [];
    this.activeRunStates = new Map();
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
    if (!this.queue.includes(runId)) this.queue.push(runId);
    void this.process();
  }

  async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const runId = this.queue.shift();
        await this.processRun(runId);
      }
    } finally {
      this.processing = false;
      if (this.queue.length === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  whenIdle() {
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  emitEvent(event) {
    this.repository.addEvent(event);
    this.emit('event', event);
  }

  async processRun(runId) {
    const run = this.repository.getRun(runId);
    if (run.status === 'cancelled' || this.repository.isCancellationRequested(runId)) return;
    const state = { controllers: new Set(), tasks: new Set(), cancelling: false };
    this.activeRunStates.set(runId, state);
    try {
      this.repository.startRun(runId);
      this.emitEvent({ runId, message: `监测任务开始执行，全局最多并发 ${run.concurrency} 项，同平台最多运行 1 项${run.appendSearchPrompt ? '，已附加搜索提示词' : ''}。` });
      const platformRuns = this.repository.getPendingPlatformRuns(runId);
      await this.processPlatformRuns(runId, platformRuns, run.concurrency, run.appendSearchPrompt);
      const completed = this.repository.finishRun(runId);
      this.emitEvent({ runId, message: `监测任务结束，状态：${completed.status}。` });
    } finally {
      this.activeRunStates.delete(runId);
    }
  }

  async processPlatformRuns(runId, platformRuns, concurrency, appendSearchPrompt) {
    const pending = [...platformRuns];
    const runningPlatforms = new Set();
    const activeTasks = new Set();

    const startAvailableTasks = () => {
      while (activeTasks.size < concurrency && !this.repository.isCancellationRequested(runId)) {
        const pendingIndex = pending.findIndex((platformRun) => !runningPlatforms.has(platformRun.platformId));
        if (pendingIndex < 0) return;
        const [platformRun] = pending.splice(pendingIndex, 1);
        runningPlatforms.add(platformRun.platformId);
        let task;
        task = this.processPlatformRun(runId, platformRun, appendSearchPrompt).finally(() => {
          runningPlatforms.delete(platformRun.platformId);
          activeTasks.delete(task);
          this.activeRunStates.get(runId)?.tasks.delete(task);
        });
        activeTasks.add(task);
        this.activeRunStates.get(runId)?.tasks.add(task);
      }
    };

    while (pending.length > 0 || activeTasks.size > 0) {
      startAvailableTasks();
      if (activeTasks.size === 0) break;
      await Promise.race(activeTasks);
    }

    if (this.repository.isCancellationRequested(runId) && pending.length > 0) {
      this.emitEvent({ runId, message: '任务已取消，停止启动后续检查。' });
    }
    await Promise.allSettled(activeTasks);
  }

  async processPlatformRun(runId, platformRun, appendSearchPrompt) {
    const controller = new AbortController();
    const state = this.activeRunStates.get(runId);
    state?.controllers.add(controller);
    if (this.repository.isCancellationRequested(runId)) {
      this.repository.cancelPlatformRun(platformRun.id);
      state?.controllers.delete(controller);
      return;
    }
    this.repository.startPlatformRun(platformRun.id);
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
      this.emitEvent({ runId, platformRunId: platformRun.id, message: `${adapter.label} 回答与引用已保存。` });
    } catch (error) {
      this.repository.addArtifacts(platformRun.id, error.artifacts);
      if (controller.signal.aborted || this.repository.isCancellationRequested(runId)) {
        this.repository.cancelPlatformRun(platformRun.id);
        this.emitEvent({ runId, platformRunId: platformRun.id, message: `${platformRun.platformId} 已强制取消。` });
      } else {
        this.repository.failPlatformRun(platformRun.id, error.message);
        this.emitEvent({ runId, platformRunId: platformRun.id, level: 'error', message: `${platformRun.platformId} 执行失败：${error.message}` });
      }
    } finally {
      state?.controllers.delete(controller);
    }
  }
}
