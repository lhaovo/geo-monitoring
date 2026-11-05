import os from 'node:os';

const MIB = 1024 * 1024;

export function availableMemoryMiB() {
  return Math.floor(os.freemem() / MIB);
}

export function calculateWorkerLimit({
  availableMiB,
  reserveMemoryMiB = 2_048,
  memoryPerWorkerMiB = 1_536,
  globalMaxWorkerConcurrency,
  globalMaxPlatformConcurrency,
  selectedBindingCount,
  selectedWorkerCount,
  selectedPlatformCount,
}) {
  const configuredMax = globalMaxWorkerConcurrency ?? globalMaxPlatformConcurrency ?? 3;
  const selectedCount = selectedBindingCount ?? selectedWorkerCount ?? selectedPlatformCount ?? configuredMax;
  const hardLimit = Math.max(1, Math.floor(Number(configuredMax)));
  const selectedLimit = Math.max(1, Math.floor(Number(selectedCount)));
  const memoryBudget = Math.max(0, availableMiB - reserveMemoryMiB);
  const memoryLimit = Math.max(1, Math.floor(memoryBudget / memoryPerWorkerMiB));
  return Math.max(1, Math.min(hardLimit, selectedLimit, memoryLimit));
}
