/**
 * 传输速率滑动窗口计算器与异步串行化工具
 */
export function createRateTracker(windowMs = 2000) {
  const samples: Array<{ t: number; bytes: number }> = [];
  return {
    sample(totalBytes: number, now = Date.now()): number {
      samples.push({ t: now, bytes: totalBytes });
      while (samples.length > 2 && now - samples[0].t > windowMs) {
        samples.shift();
      }
      if (samples.length < 2) return 0;
      const dt = (samples[samples.length - 1].t - samples[0].t) / 1000;
      if (dt <= 0.05) return 0;
      const db = samples[samples.length - 1].bytes - samples[0].bytes;
      return Math.max(0, Math.round(db / dt));
    },
    reset() {
      samples.length = 0;
    },
  };
}

/** 串行化异步任务执行，避免并发重启互联服务抢占端口 */
export function createSerializer() {
  let chain: Promise<unknown> = Promise.resolve();
  return function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
}
