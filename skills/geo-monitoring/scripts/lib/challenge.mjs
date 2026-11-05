export const CHALLENGE_WATCH_DELAY_MS = 1_000;
export const CHALLENGE_WATCH_INTERVAL_MS = 1_000;

/**
 * Poll a platform page while an answer is streaming and report the moment the platform asks for
 * an interactive human verification (slider or image captcha). Resolves to null when the caller
 * signals completion first.
 */
export async function watchForHumanChallenge({ adapter, page, isDone = () => false }) {
  await page.waitForTimeout(CHALLENGE_WATCH_DELAY_MS).catch(() => undefined);
  while (!isDone()) {
    const probe = await adapter.inspectLoginState(page).catch(() => null);
    if (probe?.status === 'challenge' || probe?.status === 'restricted') return probe;
    await page.waitForTimeout(CHALLENGE_WATCH_INTERVAL_MS).catch(() => undefined);
  }
  return null;
}
