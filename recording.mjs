export function formatElapsed(milliseconds, precise = false) {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const time = [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
  return precise ? `${time}.${String(total % 1000).padStart(3, '0')}` : time;
}

export function readCurrent(value) {
  if (!(value instanceof DataView) || value.byteLength !== 4) return null;
  const amps = -value.getFloat32(0, true); // Preserve the dashboard's existing wiring polarity.
  return Number.isFinite(amps) ? amps : null;
}

export class CurrentRecording {
  constructor() { this.clear(); }

  clear() {
    this.samples = [];
    this.peak = null;
    this.startedAt = null;
    this.segment = 0;
  }

  breakLine() { this.segment += 1; }

  add(current, timestamp = Date.now(), monotonicTime = performance.now()) {
    if (![current, timestamp, monotonicTime].every(Number.isFinite)) return null;
    if (this.startedAt === null) this.startedAt = monotonicTime;
    const previous = this.samples.at(-1);
    const elapsedMs = Math.max(previous?.elapsedMs ?? 0, monotonicTime - this.startedAt);
    if (previous && elapsedMs - previous.elapsedMs > 1500) this.breakLine();
    const sample = { current, timestamp, elapsedMs, segment: this.segment };
    this.samples.push(sample);
    // Peak means the highest signed current, retaining the first occurrence of a tie.
    if (!this.peak || current > this.peak.current) this.peak = sample;
    return sample;
  }

  toCsv() {
    return 'timestamp_iso,elapsed_seconds,current_A,segment\r\n' + this.samples.map(sample =>
      `${new Date(sample.timestamp).toISOString()},${(sample.elapsedMs / 1000).toFixed(3)},${sample.current.toFixed(6)},${sample.segment + 1}`
    ).join('\r\n') + '\r\n';
  }
}

export function lowerBound(samples, elapsedMs) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].elapsedMs < elapsedMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Preserve each pixel column's extrema, endpoints and connection gaps for long sessions.
// Raw readings remain intact in CurrentRecording for inspection and CSV export.
export function plotSamples(samples, start, end, width) {
  const result = [];
  let bucket = [];
  let key = '';
  function flush() {
    if (!bucket.length) return;
    let min = 0;
    let max = 0;
    bucket.forEach((sample, index) => {
      if (sample.current < bucket[min].current) min = index;
      if (sample.current > bucket[max].current) max = index;
    });
    [...new Set([0, min, max, bucket.length - 1])].sort((a, b) => a - b)
      .forEach(index => result.push(bucket[index]));
    bucket = [];
  }
  for (let index = lowerBound(samples, start); index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample.elapsedMs > end) break;
    const nextKey = `${Math.floor((sample.elapsedMs - start) / (end - start || 1) * width)}:${sample.segment}`;
    if (nextKey !== key) { flush(); key = nextKey; }
    bucket.push(sample);
  }
  flush();
  return result;
}
