// Demo wiring: a consent-gated BrowserMiner against the in-page ReferenceWorkSource.
// The miner auto-selects WebGPU → WASM → pure-JS; the work source verifies every
// submitted share locally (no btxd). Honest framing lives in index.html.
import { BrowserMiner, type MinerStats, type ShareResult, type ShareSubmission } from '@btx-tools/browser-miner';
import { ReferenceWorkSource } from './work-source.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const toggle = $('toggle') as HTMLButtonElement;
const duty = $('duty') as HTMLInputElement;
const dutyVal = $('dutyVal');
const logEl = $('log');

const workSource = new ReferenceWorkSource({ expectedAttempts: 8, rotateMs: 20_000 });
let miner: BrowserMiner | null = null;

function render(s: Readonly<MinerStats>): void {
  $('backend').textContent = s.backend;
  $('hashrate').textContent = `${s.hashrate.toFixed(1)} nonce/s`;
  $('job').textContent = s.jobId ?? '—';
  $('shares').textContent = `${s.sharesAccepted} / ${s.sharesRejected}`;
  $('attempts').textContent = s.attempts.toLocaleString();
  $('earn').textContent = `$${s.estimatedEarnings.toFixed(2)}`; // always $0 — honest
}

function log(share: ShareSubmission, result: ShareResult): void {
  const line = document.createElement('div');
  line.className = result.accepted ? 'ok' : 'no';
  line.textContent = `${result.accepted ? '✓' : '✗'} share nonce ${share.nonce64_hex} — ${result.reason}`;
  logEl.prepend(line);
  while (logEl.childElementCount > 50) logEl.lastElementChild?.remove();
}

function startMiner(): void {
  miner = new BrowserMiner({
    adapter: workSource,
    prefer: 'webgpu',
    workerId: 'demo-browser',
    dutyCycle: Number(duty.value) / 100,
    onStats: render,
    onShare: log,
    onError: (e) => console.error('[miner]', e),
  });
  miner.start();
  toggle.textContent = 'Stop mining';
}

async function stopMiner(): Promise<void> {
  toggle.disabled = true;
  await miner?.stop();
  miner = null;
  toggle.textContent = 'Start mining';
  toggle.disabled = false;
}

toggle.addEventListener('click', () => {
  if (miner) void stopMiner();
  else startMiner();
});

duty.addEventListener('input', () => {
  dutyVal.textContent = `${duty.value}%`;
  // dutyCycle is fixed per run; if mining, restart to apply the new throttle.
  if (miner) {
    void stopMiner().then(startMiner);
  }
});
