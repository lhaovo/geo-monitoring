import path from 'node:path';
import { parseArgs, option, required } from '../../scripts/lib/cli.mjs';
import { bindingDirectory, loadTask, questionDirectory, writeJson } from '../../scripts/lib/task.mjs';

const { options } = parseArgs();
const taskDirectory = required(options, 'task');
const bindingId = required(options, 'binding');
const { task } = await loadTask(taskDirectory);
const binding = task.platforms.find((candidate) => candidate.bindingId === bindingId);
if (!binding) throw new Error(`Missing binding ${bindingId}.`);
const directory = bindingDirectory(taskDirectory, binding);
let nextId = 1;
const pending = new Map();
let hanging = false;

process.on('message', (message) => {
  if (message?.type === 'cancel') {
    if (!hanging) return;
    state.status = 'cancelled';
    state.error = { category: 'cancelled', message: 'mock worker stopped after lease recovery' };
    void writeJson(path.join(directory, 'status.json'), state).finally(() => process.exit(0));
    return;
  }
  if (message?.type !== 'queue_response' || !message.requestId) return;
  const waiter = pending.get(message.requestId);
  if (!waiter) return;
  pending.delete(message.requestId);
  if (message.ok) waiter.resolve(message);
  else waiter.reject(new Error(message.error?.message ?? 'Queue request failed.'));
});

function request(operation, payload = {}) {
  const requestId = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    process.send({ type: 'queue_request', requestId, operation, ...payload });
  });
}

const failOnce = process.env.GEO_MOCK_FAIL_BINDING === bindingId;
const hangOnce = process.env.GEO_MOCK_HANG_BINDING === bindingId;
let failed = false;
const state = {
  bindingId,
  platformId: binding.id,
  profileId: binding.profileId,
  account: binding.account ?? null,
  label: `${binding.id} / ${binding.account ?? binding.profileId}`,
  status: 'running',
  claimedQuestionIds: [],
  processedQuestionIds: [],
  completedQuestionIds: [],
  failedQuestionIds: [],
  questionStates: {},
  error: null,
};
await writeJson(path.join(directory, 'status.json'), state);

while (true) {
  const reply = await request('claim');
  if (reply.stop) break;
  if (!reply.claim) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, reply.retryAfterMs || 50)));
    continue;
  }
  const claim = reply.claim;
  if (hangOnce && !hanging) {
    hanging = true;
    state.claimedQuestionIds.push(claim.questionId);
    state.questionStates[claim.questionId] = 'running';
    await writeJson(path.join(directory, 'status.json'), state);
    await new Promise(() => {});
  }
  if (failOnce && !failed) {
    failed = true;
    state.status = 'failed';
    state.error = { category: 'profile_locked', message: 'mock binding failure' };
    await writeJson(path.join(directory, 'status.json'), state);
    await request('fail', {
      claim,
      category: 'profile_locked',
      message: 'mock binding failure',
      retryable: true,
      forceRetry: true,
      maxAttempts: 3,
    });
    break;
  }
  const question = task.questions.find((candidate) => candidate.id === claim.questionId);
  const questionDir = questionDirectory(taskDirectory, binding, claim.questionId);
  const record = {
    question,
    bindingId,
    platformId: binding.id,
    profileId: binding.profileId,
    attempt: claim.attempt,
    status: 'completed',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    submittedQuestion: question.text,
    answer: `mock answer for ${question.id}`,
    citations: { citations: [], platformReportedCount: 0, capturedCardCount: 0 },
    brandMentions: { mentioned: false, occurrences: 0 },
    ownedDomainCitations: { cited: false },
    artifacts: [],
    error: null,
  };
  await writeJson(path.join(questionDir, 'answer.json'), record);
  state.processedQuestionIds.push(question.id);
  await writeJson(path.join(directory, 'status.json'), state);
  const completed = await request('complete', { claim });
  if (completed.completed === false) throw new Error('mock completion was rejected');
}

if (state.status !== 'failed') state.status = 'completed';
await writeJson(path.join(directory, 'status.json'), state);
if (process.connected) process.disconnect();
