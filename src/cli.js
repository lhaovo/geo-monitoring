import { launchPlatform } from './launcher.js';
import { getPlatform } from './platforms.js';
import { openDatabase } from './db/database.js';
import { GeoRepository } from './db/repository.js';
import { createPaths } from './config/paths.js';
import { normalizeProfileId } from './profiles/account-identity.js';

const platformId = process.argv[2];
const rawProfileId = process.argv[3] ?? '';

try {
  if (!platformId) {
    throw new Error('Usage: node src/cli.js <deepseek|doubao|kimi|qwen|wenxiaoyan|yuanbao> [profileId]');
  }

  const platform = getPlatform(platformId);
  const profileId = rawProfileId ? normalizeProfileId(rawProfileId) : '';
  await launchPlatform(platform, { profileId });

  if (profileId) {
    // 手动登录完成后，把该登录态标记为可用，监控任务才会自动选中它。
    const paths = createPaths();
    const database = openDatabase(paths.databasePath);
    try {
      const repository = new GeoRepository(database);
      const profile = repository.getProfileByBinding(platformId, profileId);
      if (profile) {
        repository.markProfileUsed(profile.id, { health: 'ready' });
        console.log(`登录态 ${platformId}:${profileId} 已标记为可用。`);
      } else {
        console.log(`提示：数据库中还没有 ${platformId}:${profileId} 登录态，可在「平台与登录状态」页面新增。`);
      }
    } finally {
      database.close();
    }
  }
} catch (error) {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
}
