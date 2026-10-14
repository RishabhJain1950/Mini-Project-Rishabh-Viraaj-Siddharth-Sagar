import { CurrentRecording, formatElapsed, readCurrent } from './recording.mjs';
import { CurrentChart, clockTime } from './current-chart.mjs';

const UUIDS = {
  service: '7b3e0001-6f8d-4b6a-9d2e-4f2c1a00b001',
  voltage: '7b3e0002-6f8d-4b6a-9d2e-4f2c1a00b001',
  current: '7b3e0003-6f8d-4b6a-9d2e-4f2c1a00b001',
  mosfet: '7b3e0004-6f8d-4b6a-9d2e-4f2c1a00b001'
};

const ui = {
  connect: document.querySelector('#connectButton'), mosfet: document.querySelector('#mosfetButton'),
  voltage: document.querySelector('#voltage'), current: document.querySelector('#current'), power: document.querySelector('#power'),
  status: document.querySelector('#statusText'), connection: document.querySelector('.connection'), message: document.querySelector('#message'),
  mosfetLabel: document.querySelector('#mosfetLabel'), mosfetDescription: document.querySelector('#mosfetDescription'),
  peak: document.querySelector('#peakCurrent'), peakTime: document.querySelector('#peakTime'), peakElapsed: document.querySelector('#peakElapsed'),
  duration: document.querySelector('#recordingDuration'), count: document.querySelector('#sampleCount'),
  recordingStatus: document.querySelector('#recordingStatus'), window: document.querySelector('#chartWindow'),
  export: document.querySelector('#exportButton'), clear: document.querySelector('#clearButton')
};

const recording = new CurrentRecording();
const chart = new CurrentChart(document.querySelector('#currentChart'), recording, document.querySelector('#chartDetail'));
let device = null;
let mosfetCharacteristic = null;
let voltage = 0;
let current = 0;
let mosfetOn = false;
let ready = false;
let connecting = false;
let listeners = [];

function listen(target, event, handler) {
  target.addEventListener(event, handler);
  listeners.push(() => target.removeEventListener(event, handler));
}

function cleanup() {
  listeners.forEach(remove => remove());
  listeners = [];
  mosfetCharacteristic = null;
  recording.breakLine();
  setConnection(false);
}

function setConnection(connected, text = connected ? 'Connected' : 'Disconnected') {
  ready = connected;
  ui.connection.classList.toggle('connected', connected);
  ui.status.textContent = text;
  ui.connect.textContent = connected ? 'Disconnect' : 'Connect Bluetooth';
  ui.connect.disabled = connecting;
  ui.mosfet.disabled = !connected;
  ui.message.textContent = connected ? `Receiving live data from ${device?.name || 'ESP32'}.` : 'Connect to your ESP32 to begin receiving measurements.';
  updateRecording();
}

function updateRecording() {
  const peak = recording.peak;
  const last = recording.samples.at(-1);
  ui.peak.textContent = peak ? peak.current.toFixed(3) : '—';
  ui.peakTime.textContent = peak ? clockTime(peak.timestamp) : '—';
  ui.peakTime.title = peak ? new Date(peak.timestamp).toLocaleString() : '';
  ui.peakElapsed.textContent = peak ? `+${formatElapsed(peak.elapsedMs, true)} from first reading` : 'Highest received reading';
  ui.duration.textContent = formatElapsed(last?.elapsedMs ?? 0, true);
  ui.count.textContent = recording.samples.length.toLocaleString();
  ui.export.disabled = ui.clear.disabled = !last;
  ui.recordingStatus.textContent = ready ? 'Recording incoming readings' : last ? 'Disconnected · recorded history kept' : 'Waiting for Bluetooth';
  chart.schedule();
}

function updatePower() { ui.power.textContent = (voltage * current).toFixed(2); }
function onVoltage(event) {
  const value = event.target.value;
  if (value?.byteLength !== 4) return;
  const next = value.getFloat32(0, true);
  if (!Number.isFinite(next)) return;
  voltage = next;
  ui.voltage.textContent = voltage.toFixed(2);
  updatePower();
}
function updateCurrent(value, record = false) {
  const next = readCurrent(value);
  if (next === null) return;
  current = next;
  ui.current.textContent = current.toFixed(3);
  updatePower();
  if (record) { recording.add(current); updateRecording(); }
}
function onCurrent(event) { updateCurrent(event.target.value, true); }
function setMosfetUi(on) {
  mosfetOn = on;
  ui.mosfet.setAttribute('aria-checked', String(on));
  ui.mosfetLabel.textContent = on ? 'ON' : 'OFF';
  ui.mosfetDescription.textContent = `The load is currently ${on ? 'on' : 'off'}.`;
}
function onMosfet(event) {
  if (event.target.value?.byteLength === 1) setMosfetUi(event.target.value.getUint8(0) !== 0);
}

async function connect() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available. Use Chrome or Edge on a laptop.');
  device = await navigator.bluetooth.requestDevice({ filters: [{ services: [UUIDS.service] }] });
  const selectedDevice = device;
  listen(device, 'gattserverdisconnected', cleanup);
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(UUIDS.service);
  const voltageCharacteristic = await service.getCharacteristic(UUIDS.voltage);
  const currentCharacteristic = await service.getCharacteristic(UUIDS.current);
  mosfetCharacteristic = await service.getCharacteristic(UUIDS.mosfet);

  // Reads can also emit characteristicvaluechanged. Read before subscribing so
  // the initial snapshot is shown on the cards but never counted as a new sample.
  onVoltage({ target: { value: await voltageCharacteristic.readValue() } });
  updateCurrent(await currentCharacteristic.readValue());
  onMosfet({ target: { value: await mosfetCharacteristic.readValue() } });
  for (const [characteristic, handler] of [
    [voltageCharacteristic, onVoltage], [currentCharacteristic, onCurrent], [mosfetCharacteristic, onMosfet]
  ]) {
    listen(characteristic, 'characteristicvaluechanged', handler);
    await characteristic.startNotifications(); // Serialize GATT operations.
  }
  if (device !== selectedDevice || !device.gatt.connected) throw new Error('Bluetooth disconnected during setup. Please reconnect.');
  setConnection(true);
}

ui.connect.addEventListener('click', async () => {
  if (connecting) return;
  if (device?.gatt?.connected) { device.gatt.disconnect(); return; }
  connecting = true;
  ui.connect.disabled = true;
  ui.status.textContent = 'Connecting…';
  try { await connect(); }
  catch (error) {
    console.error(error);
    const failedDevice = device;
    cleanup();
    if (failedDevice?.gatt?.connected) failedDevice.gatt.disconnect();
    ui.message.textContent = error.name === 'NotFoundError' ? 'No device selected. Try connecting again.' : error.message;
  }
  finally { connecting = false; ui.connect.disabled = false; }
});

ui.mosfet.addEventListener('click', async () => {
  if (!ready || !mosfetCharacteristic) return;
  const next = !mosfetOn;
  ui.mosfet.disabled = true;
  try {
    await mosfetCharacteristic.writeValue(new Uint8Array([next ? 1 : 0]));
    if (ready) setMosfetUi(next);
  } catch (error) { ui.message.textContent = `Could not change MOSFET: ${error.message}`; }
  finally { ui.mosfet.disabled = !ready; }
});

ui.window.addEventListener('change', () => {
  chart.windowMs = Number(ui.window.value);
  chart.selected = null;
  chart.schedule();
});
ui.clear.addEventListener('click', () => {
  if (recording.samples.length && !window.confirm('Clear all recorded readings? Export CSV first if you want to keep them.')) return;
  recording.clear();
  chart.selected = null;
  updateRecording();
});
ui.export.addEventListener('click', () => {
  if (!recording.samples.length) return;
  const url = URL.createObjectURL(new Blob([recording.toCsv()], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `current-${new Date(recording.samples[0].timestamp).toISOString().replace(/[:.]/g, '-')}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

setConnection(false);
