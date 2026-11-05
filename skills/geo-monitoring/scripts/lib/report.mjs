import { readFile, writeFile } from 'node:fs/promises';
import { bindingDirectory, loadTask, taskFiles } from './task.mjs';
import { PLATFORM_DEFINITIONS } from './profiles.mjs';
import { restoreWorkQueue, summarizeQueue } from './work-queue.mjs';

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function percentage(numerator, denominator) {
  return denominator ? Number(((numerator / denominator) * 100).toFixed(1)) : 0;
}

function markdown(summary) {
  const lines = [
    `# GEO monitoring results: ${summary.brand.name}`,
    '',
    `Task: ${summary.taskId}`,
    `Status: ${summary.status}`,
    `Questions: ${summary.questionCount}`,
    '',
    '## Shared queue',
    '',
    '| Platform | Total | Completed | Pending | Claimed | Failed | Attempts |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of summary.queue) {
    lines.push(`| ${row.platformId} | ${row.total} | ${row.completed} | ${row.pending} | ${row.claimed} | ${row.failed} | ${row.attempts} |`);
  }
  lines.push('', '## Login profiles', '', '| Platform | Account | Status | Completed | Failed attempts | Brand mention rate | Owned-domain citation rate | Captured sources |', '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const binding of summary.platforms) {
    const captured = `${binding.capturedCitationCount}${binding.reportedCitationCount === null ? '' : ` / reported ${binding.reportedCitationCount}`}`;
    lines.push(`| ${binding.platformLabel} | ${binding.account ?? binding.profileId} | ${binding.status} | ${binding.completedQuestions} | ${binding.failedQuestions} | ${binding.brandMentionRate}% | ${binding.ownedDomainCitationRate}% | ${captured} |`);
  }
  if (summary.warnings.length) {
    lines.push('', '## Warnings', '');
    lines.push(...summary.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join('\n')}\n`;
}

export async function buildReport(taskDirectory) {
  const files = taskFiles(taskDirectory);
  const { task } = await loadTask(taskDirectory);
  const manifest = await readJsonIfPresent(files.manifest);
  if (!task || !manifest) throw new Error('Task directory does not contain task.json and manifest.json.');

  const queueSnapshot = await readJsonIfPresent(files.queue);
  const queue = restoreWorkQueue(queueSnapshot, {
    taskId: task.id,
    questions: task.questions,
    platforms: task.platforms,
    now: new Date(),
  });
  const queueRows = summarizeQueue(queue, { platformIds: task.platforms.map((binding) => binding.id) });
  const platformLabels = new Map();
  for (const binding of task.platforms) {
    platformLabels.set(binding.id, PLATFORM_DEFINITIONS[binding.id]?.label ?? binding.id);
  }

  const warnings = [];
  const bindings = [];
  for (const binding of task.platforms) {
    const directory = bindingDirectory(taskDirectory, binding);
    const bindingStatus = await readJsonIfPresent(`${directory}/status.json`);
    const platformState = queue.platforms[binding.id] ?? { completed: {}, failed: {} };
    const completedIds = Object.entries(platformState.completed)
      .filter(([, item]) => item.bindingId === binding.bindingId)
      .map(([questionId]) => questionId);
    const failedIds = Object.entries(platformState.failed)
      .filter(([, item]) => item.bindingId === binding.bindingId)
      .map(([questionId]) => questionId);
    const answerIds = new Set([...completedIds, ...failedIds]);
    for (const question of task.questions) {
      if (answerIds.has(question.id)) continue;
      if (await readJsonIfPresent(`${directory}/questions/${question.id}/answer.json`)) answerIds.add(question.id);
    }
    const records = [];
    for (const questionId of answerIds) {
      const record = await readJsonIfPresent(`${directory}/questions/${questionId}/answer.json`);
      if (record) records.push(record);
    }
    const completed = records.filter((record) => record.status === 'completed');
    const citations = completed.flatMap((record) => record.citations?.citations ?? []);
    const reportedCounts = completed.map((record) => record.citations?.platformReportedCount).filter(Number.isFinite);
    const reportedCitationCount = reportedCounts.length ? reportedCounts.reduce((sum, count) => sum + count, 0) : null;
    const brandMentioned = completed.filter((record) => record.brandMentions?.mentioned).length;
    const ownedDomainCited = completed.filter((record) => record.ownedDomainCitations?.cited).length;
    for (const record of completed) {
      const reported = record.citations?.platformReportedCount;
      const captured = Number.isFinite(record.citations?.capturedCardCount) && record.citations.capturedCardCount > 0
        ? record.citations.capturedCardCount
        : (record.citations?.uniqueUrlCount ?? record.citations?.citations?.length ?? 0);
      if (Number.isFinite(reported) && Number.isFinite(captured) && captured < reported) {
        warnings.push(`${binding.bindingId}/${record.question.id}: platform reported ${reported} source(s), captured ${captured}.`);
      }
    }
    bindings.push({
      bindingId: binding.bindingId,
      platformId: binding.id,
      platformLabel: bindingStatus?.label?.split(' / ')[0] ?? PLATFORM_DEFINITIONS[binding.id]?.label ?? binding.id,
      profileId: binding.profileId,
      account: binding.account ?? null,
      status: bindingStatus?.status ?? manifest.bindingStates?.[binding.bindingId] ?? 'pending',
      completedQuestions: completed.length,
      failedQuestions: records.filter((record) => record.status === 'failed').length,
      handledQuestions: records.length,
      brandMentionRate: percentage(brandMentioned, completed.length),
      ownedDomainCitationRate: percentage(ownedDomainCited, completed.length),
      capturedCitationCount: citations.length,
      reportedCitationCount,
    });
  }

  const summary = {
    taskId: task.id,
    generatedAt: new Date().toISOString(),
    status: manifest.status,
    brand: task.brand,
    questionCount: task.questions.length,
    bindingCount: task.platforms.length,
    queue: queueRows.map((row) => ({ ...row, platformLabel: platformLabels.get(row.platformId) ?? row.platformId })),
    platforms: bindings,
    warnings,
  };
  await writeFile(files.summary, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(files.markdownSummary, markdown(summary), 'utf8');
  return summary;
}