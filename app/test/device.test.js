'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Device, isAutoCandidate, isUartPort, describePort } = require('../src/main/device');
const P = require('../src/main/protocol');

const port = (vendorId, productId) => ({ path: 'COM9', vendorId, productId });

test('procura automática: S2 nativo e CH340/CP210x, nunca JTAG nem bootloader', () => {
  assert.ok(isAutoCandidate(port('303A', '0002')) === false, 'bootloader');
  assert.ok(isAutoCandidate(port('303A', '1001')) === false, 'USB-Serial-JTAG');
  assert.ok(isAutoCandidate(port('303A', '4001')), 'S2 nativo');
  assert.ok(isAutoCandidate(port('1A86', '7523')), 'CH340 (CYD)');
  assert.ok(isAutoCandidate(port('10C4', 'EA60')), 'CP210x');
  assert.ok(!isAutoCandidate(port('0403', '6001')), 'FTDI só à mão');
  assert.ok(!isAutoCandidate({ path: 'COM1' }), 'porta do sistema');
});

test('isUartPort distingue USB-série de USB nativo', () => {
  assert.ok(isUartPort(port('1A86', '7523')));
  assert.ok(!isUartPort(port('303A', '4001')));
  assert.ok(!isUartPort({ path: 'COM1' }));
});

test('describePort: CH340 pode ter o LCD, FTDI não é procurado sozinho', () => {
  assert.strictEqual(describePort(port('1A86', '7523')).usable, true);
  assert.strictEqual(describePort(port('0403', '6001')).usable, false);
  assert.strictEqual(describePort(port('303A', '4001')).usable, true);
});

function serialDevice(states, info = { transport: 'uart', wifiCapable: true }) {
  const d = new Device();
  d.written = [];
  d.port = { write: (b) => d.written.push(b), close() { d.closed = true; } };
  d.info = info;
  d._helloOnce = async () => states.shift();
  return d;
}

test('provisionWifi: envia SSID e palavra-passe pelo cabo e espera pelo IP', async () => {
  const d = serialDevice([{ wifi: { state: 1 } }, { wifi: { state: 2, rssi: -50, ip: '10.0.0.5' } }]);
  const res = await d.provisionWifi('casa', 'segredo');
  assert.deepStrictEqual(res, { ip: '10.0.0.5', rssi: -50 });
  assert.strictEqual(d.written.length, 1);
  assert.strictEqual(d.written[0][2], P.PKT.WIFI_SET);
});

test('provisionWifi: rede recusada e firmware sem Wi-Fi dão erros com chave de tradução', async () => {
  await assert.rejects(serialDevice([{ wifi: { state: 3 } }]).provisionWifi('casa', 'mal'), { key: 'wifi.err.failed' });
  await assert.rejects(serialDevice([], { transport: 'uart', wifiCapable: false }).provisionWifi('casa', 'x'), { key: 'wifi.err.noFirmware' });
});

test('setLink só fecha a ligação quando o modo ou o endereço mudam', () => {
  const d = new Device();
  d.port = { close() { d.closed = (d.closed || 0) + 1; } };
  d.setLink({ mode: 'serial' });
  assert.strictEqual(d.closed, undefined, 'igual ao atual');
  d.setLink({ mode: 'wifi', host: '10.0.0.5' });
  d.setLink({ mode: 'wifi', host: '10.0.0.5' });
  assert.strictEqual(d.closed, 1);
  d.setLink({ mode: 'wifi', host: '10.0.0.6' });
  assert.strictEqual(d.closed, 2);
});

test('por Wi-Fi podem estar dois lotes em voo; por cabo, um', () => {
  const d = new Device();
  d.port = {};
  d.info = { transport: 'uart' };
  assert.strictEqual(d.maxInFlight, 1);
  d.info = { transport: 'wifi' };
  assert.strictEqual(d.maxInFlight, 2);
});
