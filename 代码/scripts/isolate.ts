/**
 * isolate.ts — 让"自带临时题库"的校验套件**真的**用到那个临时题库。
 *
 * ## 为什么需要它（踩过的坑）
 *
 * 配置层的优先级是：**config.json > 环境变量 VAULT_PATH > 默认值**。
 * 于是只要你在「设置 → 路径」里改过一次路径，盘上就有一个 `config.json` ——
 * 从那以后，套件里那句 `process.env.VAULT_PATH = 临时目录` 就**不再生效**：
 * 它会跑到**你正在用的库**里去建测试题、去断言"库里有 3 道题"，然后报出一堆
 * 莫名其妙的失败（实测：selftest 对着 64 道题的演示库跑，43 项红，
 * 连"下一个号 = T0001"都对不上；而且它**往那个库里写了东西**）。
 *
 * ## 做法
 *
 * 把临时题库临时写进 `config.json`（跑完原样写回；进程退出时也写回），
 * 跟 `verify-v9-subject-ui.ts` / `verify-migrated.ts` 用的是同一个套路。
 * 这样"套件只在临时目录里折腾、绝不动你的库"这条承诺才真的成立。
 *
 * 用法（在设置 VAULT_PATH 之后、任何读写之前调一次）：
 *
 * ```ts
 * const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quirex-xxx-'));
 * process.env.VAULT_PATH = TMP;
 * isolateVault(TMP, path.join(TMP, '导出'));
 * ```
 */

import fs from 'fs';
import { configFilePath } from '../src/lib/config';

export function isolateVault(vaultPath: string, exportDir?: string): void {
  const file = configFilePath();
  const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;

  let raw: Record<string, unknown> = {};
  try {
    raw = saved ? (JSON.parse(saved) as Record<string, unknown>) : {};
  } catch {
    raw = {}; // 盘上那份坏了也别拦着套件跑（还原时照样原样写回）
  }

  const patch: Record<string, unknown> = { ...raw, vaultPath };
  if (exportDir) patch.exportDir = exportDir;
  fs.writeFileSync(file, JSON.stringify(patch, null, 2) + '\n', 'utf-8');

  // process.exit() 也会触发 exit 事件，所以异常退出也能还原
  process.on('exit', () => {
    try {
      if (saved !== null) fs.writeFileSync(file, saved, 'utf-8');
      else fs.rmSync(file, { force: true });
    } catch {
      /* 写不回去也别让套件崩在这儿 */
    }
  });
}
