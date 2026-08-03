# GEO Monitoring browser-debugging design

## Goal

Create a Node.js and Playwright project that visibly opens the web clients for DeepSeek, Doubao, and Kimi. It will support manual first-time login and persist each platform's browser state for future runs.

## Scope

The first milestone proves reliable page opening and retained login state. It does not submit monitoring prompts, scrape answers, solve CAPTCHAs, automate QR-code login, bypass access controls, or target overseas platforms.

## Architecture

The project uses JavaScript, Node.js, and Playwright. A common launcher starts Chromium with `headless: false` and a platform-specific persistent profile directory. Small platform definitions supply the canonical entry URL, a human-readable label, and readiness/login-state checks.

Each launch creates a run folder with:

- a timestamped full-page screenshot;
- a JSON record containing platform id, start/end time, page title, current URL, and outcome;
- a text log for failures and operator-facing instructions.

Persistent state is held in local, ignored `data/profiles/<platform>/` directories. Evidence is stored under ignored `data/runs/`, so authentication material and screenshots are never committed.

## Operator workflow

1. Install dependencies and the Playwright Chromium browser.
2. Run one of `npm run open:deepseek`, `npm run open:doubao`, or `npm run open:kimi`.
3. A visible browser opens the configured platform. The operator completes any login, QR scan, consent prompt, or CAPTCHA manually.
4. The launcher captures evidence and keeps the browser open until the operator closes it or ends the process.
5. A later run reuses only that platform's persistent profile and records whether the signed-in state appears available.

## Boundaries and safety

- The browser is never run headlessly in this milestone.
- No login credential, cookie, or storage-state file is written into source control.
- No automation attempts to defeat CAPTCHA, device verification, rate limits, or platform restrictions.
- Profile folders are independent, so a sign-in or logout in one platform cannot affect another.

## Testing

Unit tests cover platform configuration validation, run-folder naming, and evidence record generation. They do not require live platform access, credentials, or browser login. Manual acceptance checks verify each platform opens visibly, a manually completed login survives a second run, and evidence files are produced.

## Deferred work

After the three login flows are stable, a later milestone can add prompt execution, response/citation extraction, scheduled queues, diffing, and GEO metrics.
