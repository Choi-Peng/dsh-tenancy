// AI 生成声明:本模块由 AI 生成,可能存在错误或安全隐患,使用前请 review 并实测。
//
// tenancy 审计日志(JSONL 追加,超 5MB 轮转保留一份 .1)。
// 记录:P1/P2 门控拒绝、ACL 变更、claim、respond 硬化拒绝等安全相关事件。
// 写入串行化(单进程内 promise 链),失败静默——审计不可用不得阻塞业务路径。
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const ROTATE_BYTES = 5 * 1024 * 1024;

export class AuditLog {
  #path; #queue = Promise.resolve(); #dirReady = false;

  constructor(path) { this.#path = path; }

  /** fire-and-forget;返回promise仅为可测试性。 */
  record(entry) {
    this.#queue = this.#queue.then(() => this.#write(entry)).catch(() => {});
    return this.#queue;
  }

  async #write(entry) {
    try {
      if (!this.#dirReady) {
        await mkdir(dirname(this.#path), { recursive: true });
        this.#dirReady = true;
      }
      const st = await stat(this.#path).catch(() => null);
      if (st && st.size > ROTATE_BYTES) {
        await rename(this.#path, `${this.#path}.1`).catch(() => {});
      }
      await appendFile(this.#path, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch { /* 审计失败不阻塞业务 */ }
  }
}
