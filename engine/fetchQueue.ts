interface Job {
  url: string;
  /** Recomputed at dequeue time; lower runs sooner. */
  priority: () => number;
  signal: AbortSignal;
  retries: number;
  resolve: (buf: ArrayBuffer | null) => void;
}

/**
 * Single shared download queue for all tile kinds. Bounded concurrency,
 * distance-based priority re-evaluated at dequeue, abort support, one retry
 * with backoff, and a session-permanent negative cache for tiles known to be
 * missing/blank. Resolves null (never rejects) on abort or permanent failure.
 */
export class FetchQueue {
  private queue: Job[] = [];
  private active = 0;
  private negative = new Set<string>();

  constructor(
    private concurrency: number,
    private onCount?: (inFlight: number) => void,
  ) {}

  request(url: string, opts: { priority: () => number; signal: AbortSignal }): Promise<ArrayBuffer | null> {
    if (this.negative.has(url) || opts.signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.queue.push({ url, priority: opts.priority, signal: opts.signal, retries: 1, resolve });
      this.pump();
    });
  }

  /** Mark a URL as permanently empty for this session. */
  markNegative(url: string): void {
    this.negative.add(url);
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const job = this.dequeue();
      if (!job) break;
      this.active++;
      void this.run(job);
    }
    this.onCount?.(this.active + this.queue.length);
  }

  private dequeue(): Job | null {
    // Drop aborted jobs, then take the lowest-priority-value survivor.
    const alive: Job[] = [];
    for (const job of this.queue) {
      if (job.signal.aborted) job.resolve(null);
      else alive.push(job);
    }
    this.queue = alive;
    if (this.queue.length === 0) return null;
    let best = 0;
    let bestP = this.queue[0].priority();
    for (let i = 1; i < this.queue.length; i++) {
      const p = this.queue[i].priority();
      if (p < bestP) {
        best = i;
        bestP = p;
      }
    }
    return this.queue.splice(best, 1)[0];
  }

  private async run(job: Job): Promise<void> {
    let settled = false;
    try {
      const res = await fetch(job.url, { signal: job.signal });
      if (res.ok) {
        job.resolve(await res.arrayBuffer());
        settled = true;
      } else if (res.status === 404 || res.status === 403 || res.status === 410) {
        this.negative.add(job.url);
        job.resolve(null);
        settled = true;
      }
    } catch {
      // network error or abort — fall through to retry logic
    }
    if (!settled) {
      if (job.signal.aborted || job.retries <= 0) {
        job.resolve(null);
      } else {
        job.retries--;
        setTimeout(() => {
          if (job.signal.aborted) job.resolve(null);
          else {
            this.queue.push(job);
            this.pump();
          }
        }, 500);
      }
    }
    this.active--;
    this.pump();
  }
}
