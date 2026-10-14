import { formatElapsed, lowerBound, plotSamples } from './recording.mjs';

export function clockTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
  });
}

export class CurrentChart {
  constructor(canvas, recording, detail) {
    this.canvas = canvas;
    this.recording = recording;
    this.detail = detail;
    this.windowMs = 0;
    this.selected = null;
    this.frame = null;
    this.bounds = null;
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', event => this.inspect(event));
    canvas.addEventListener('pointermove', event => this.inspect(event));
    canvas.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'touch') { this.selected = null; this.schedule(); }
    });
    canvas.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const samples = this.recording.samples;
      if (!samples.length) return;
      event.preventDefault();
      const first = lowerBound(samples, this.bounds?.start ?? 0);
      const current = this.selected ?? samples.length - 1;
      this.selected = event.key === 'Home' ? first : event.key === 'End' ? samples.length - 1 :
        Math.max(first, Math.min(samples.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)));
      this.schedule();
    });
    canvas.addEventListener('blur', () => { this.selected = null; this.schedule(); });
    this.schedule();
  }

  schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
  }

  inspect(event) {
    if (!this.bounds || !this.recording.samples.length) return;
    const { left, width, start, end } = this.bounds;
    const x = event.clientX - this.canvas.getBoundingClientRect().left;
    const elapsed = start + Math.max(0, Math.min(1, (x - left) / width)) * (end - start);
    const samples = this.recording.samples;
    const first = lowerBound(samples, start);
    let index = Math.min(samples.length - 1, lowerBound(samples, elapsed));
    if (index > first && elapsed - samples[index - 1].elapsedMs < samples[index].elapsedMs - elapsed) index -= 1;
    this.selected = index;
    this.schedule();
  }

  draw() {
    const canvas = this.canvas;
    const ctx = canvas.getContext('2d');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!ctx || !width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const left = 64;
    const top = 30;
    const plotWidth = Math.max(1, width - left - 20);
    const plotHeight = height - top - 44;
    const samples = this.recording.samples;
    const end = Math.max(1000, samples.at(-1)?.elapsedMs ?? 0);
    const start = this.windowMs ? Math.max(0, end - this.windowMs) : 0;
    this.bounds = { left, width: plotWidth, start, end };
    const points = plotSamples(samples, start, end, plotWidth);
    let min = 0;
    let max = 0;
    points.forEach(sample => { min = Math.min(min, sample.current); max = Math.max(max, sample.current); });
    const padding = Math.max(0.01, (max - min) * 0.15);
    min -= padding;
    max += padding;
    const xOf = sample => left + (sample.elapsedMs - start) / (end - start) * plotWidth;
    const yOf = current => top + (max - current) / (max - min) * plotHeight;
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillStyle = '#91a59d';
    ctx.fillText('Current (A)', left, 15);
    ctx.textAlign = 'right';
    for (let index = 0; index <= 4; index += 1) {
      const value = min + (max - min) * index / 4;
      const y = yOf(value);
      ctx.strokeStyle = '#22352e';
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + plotWidth, y); ctx.stroke();
      ctx.fillText(value.toFixed(3), left - 9, y + 4);
    }
    const ticks = width < 500 ? 2 : 4;
    for (let index = 0; index <= ticks; index += 1) {
      const elapsed = start + (end - start) * index / ticks;
      ctx.textAlign = index === 0 ? 'left' : index === ticks ? 'right' : 'center';
      ctx.fillText(formatElapsed(elapsed, end - start < 3000), left + plotWidth * index / ticks, height - 20);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(left - 4, top, plotWidth + 8, plotHeight); ctx.clip();
    ctx.strokeStyle = '#ffcb6b'; ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((sample, index) => {
      if (index === 0 || sample.segment !== points[index - 1].segment) ctx.moveTo(xOf(sample), yOf(sample.current));
      else ctx.lineTo(xOf(sample), yOf(sample.current));
    });
    ctx.stroke();
    ctx.fillStyle = '#ffcb6b';
    // Dots expose isolated readings, including either side of a disconnect.
    points.forEach((sample, index) => {
      if (points.length < 100 || index === 0 || sample.segment !== points[index - 1].segment) {
        ctx.beginPath(); ctx.arc(xOf(sample), yOf(sample.current), 2.5, 0, Math.PI * 2); ctx.fill();
      }
    });
    ctx.restore();
    const peak = this.recording.peak;
    if (peak && peak.elapsedMs >= start) {
      const x = xOf(peak);
      const y = yOf(peak.current);
      ctx.fillStyle = '#63f5ae';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = x > width - 120 ? 'right' : 'left';
      ctx.fillText(`Peak ${peak.current.toFixed(3)} A`, x, Math.max(top + 12, y - 12));
    }
    const selected = this.selected === null ? null : samples[this.selected];
    if (selected && selected.elapsedMs >= start) {
      const x = xOf(selected);
      ctx.strokeStyle = '#91a59d'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotHeight); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = '#f2f7f4';
      ctx.beginPath(); ctx.arc(x, yOf(selected.current), 4, 0, Math.PI * 2); ctx.fill();
      this.detail.textContent = `${selected.current.toFixed(3)} A · ${clockTime(selected.timestamp)} · +${formatElapsed(selected.elapsedMs, true)}`;
    } else {
      this.detail.textContent = samples.length ? 'Hover or touch to inspect · Focus the graph and use arrow keys to move between readings.' :
        'Connect Bluetooth to start plotting current readings.';
    }
    if (!samples.length) {
      ctx.textAlign = 'center'; ctx.fillStyle = '#91a59d';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('Waiting for current readings', left + plotWidth / 2, top + plotHeight / 2);
    }
  }
}
