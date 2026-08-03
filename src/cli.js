import { launchPlatform } from './launcher.js';
import { getPlatform } from './platforms.js';

const platformId = process.argv[2];

try {
  if (!platformId) {
    throw new Error('Usage: node src/cli.js <deepseek|doubao|kimi>');
  }

  await launchPlatform(getPlatform(platformId));
} catch (error) {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
}
