'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isAutoCandidate, isUartPort, describePort } = require('../src/main/device');

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
