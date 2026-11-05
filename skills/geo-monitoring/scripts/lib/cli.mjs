const REPEATABLE_OPTIONS = new Set(['alias', 'domain', 'question', 'platform', 'profile']);

export function parseArgs(argv = process.argv.slice(2)) {
  const options = new Map();
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    if (!key) throw new Error('Invalid empty option.');
    const next = argv[index + 1];
    const value = !next || next.startsWith('--') ? true : next;
    if (value !== true) index += 1;

    if (REPEATABLE_OPTIONS.has(key)) {
      const values = options.get(key) ?? [];
      values.push(value);
      options.set(key, values);
    } else {
      options.set(key, value);
    }
  }

  return { options, positional };
}

export function option(options, key, fallback = undefined) {
  return options.has(key) ? options.get(key) : fallback;
}

export function values(options, key) {
  return options.get(key) ?? [];
}

export function required(options, key) {
  const value = option(options, key);
  if (value === undefined || value === true || String(value).trim() === '') {
    throw new Error(`Missing required --${key} option.`);
  }
  return String(value);
}

export function usage(lines) {
  console.error(lines.join('\n'));
}
