/**
 * env.ts — 客户端可见配置
 *
 * 服务端题库路径请用 @/lib/paths 的 vaultPath()（每次调用读 env，便于测试切换题库）。
 * 年级/学期/学科后缀等 v0 遗留配置已随字段一起删除（方案 §17）。
 */

export const clientEnv = {
  appName: 'Quirex',
  /** 仅用于界面展示「当前题库路径」 */
  vaultPathLabel: process.env.NEXT_PUBLIC_VAULT_PATH ?? '../题库',
};
