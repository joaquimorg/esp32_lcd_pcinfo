'use strict';

const os = require('os');
const { EventEmitter } = require('events');
const I18N = require('../i18n');

/** "57,5 °C" -> { value: 57.5, unit: "°C" } (o LHM usa a vírgula do locale) */
function parseReading(text) {
  const m = /^\s*(-?[\d.,]+)\s*(.*)$/.exec(text || '');
  if (!m) return { value: null, unit: '' };
  let num = m[1];
  num = num.includes(',') ? num.replace(/\./g, '').replace(',', '.') : num;
  const value = Number.parseFloat(num);
  return { value: Number.isFinite(value) ? value : null, unit: m[2].trim() };
}

/**
 * Converte a árvore do data.json do LibreHardwareMonitor numa lista plana.
 * Os sensores são identificados pelo SensorId (ex: /amdcpu/0/temperature/2),
 * que não muda quando se acrescenta ou remove hardware.
 */
function flattenLhm(root, out) {
  const walk = (node, path) => {
    const children = node.Children || [];
    if (!children.length && node.SensorId) {
      const { value, unit } = parseReading(node.Value);
      out[node.SensorId] = {
        id: node.SensorId,
        name: node.Text,
        hardware: path[1] || path[0] || '',
        group: path[path.length - 1] || '',
        type: node.Type || '',
        value,
        unit,
        min: parseReading(node.Min).value,
        max: parseReading(node.Max).value,
      };
    }
    for (const c of children) walk(c, node.id === 0 ? path : [...path, node.Text]);
  };
  walk(root, []);
}

/** Sensores que não dependem do LHM. */
class SystemSensors {
  constructor() {
    this.prevCpu = null;
    this.t = I18N.translator();
  }

  read(out) {
    const cpus = os.cpus();
    const total = { idle: 0, all: 0 };
    for (const c of cpus) {
      const t = c.times;
      total.idle += t.idle;
      total.all += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    let load = null;
    if (this.prevCpu) {
      const all = total.all - this.prevCpu.all;
      load = all > 0 ? 100 * (1 - (total.idle - this.prevCpu.idle) / all) : null;
    }
    this.prevCpu = total;

    const mem = os.totalmem();
    const used = mem - os.freemem();
    const sys = (id, name, group, type, value, unit, max = null) => {
      out[id] = { id, name, hardware: this.t('sensor.system'), group, type, value, unit, min: null, max };
    };
    sys('sys/cpu/load', this.t('sensor.cpuTotal'), 'Load', 'Load', load, '%', 100);
    sys('sys/mem/load', this.t('sensor.memory'), 'Load', 'Load', (100 * used) / mem, '%', 100);
    sys('sys/mem/used', this.t('sensor.memoryUsed'), 'Data', 'Data', used / 2 ** 30, 'GB', mem / 2 ** 30);
  }
}

/**
 * Lê os sensores periodicamente. Evento: update(sensors) com { [id]: sensor }.
 */
class Sensors extends EventEmitter {
  constructor() {
    super();
    this.lhmUrl = '';
    this.intervalMs = 1000;
    this.system = new SystemSensors();
    this.snapshot = {};
    this.lhmStatus = { ok: false, message: '' };
    this.t = I18N.translator();
    this.timer = null;
  }

  configure({ lhmUrl, intervalMs, language }) {
    this.t = this.system.t = I18N.translator(language);
    this.lhmUrl = lhmUrl || '';
    this.intervalMs = Math.max(250, intervalMs || 1000);
  }

  start() {
    const tick = async () => {
      await this.tick();
      this.timer = setTimeout(tick, this.intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async tick() {
    const sensors = {};
    this.system.read(sensors);

    if (this.lhmUrl) {
      try {
        const res = await fetch(this.lhmUrl, { signal: AbortSignal.timeout(Math.min(3000, this.intervalMs * 2)) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        flattenLhm(await res.json(), sensors);
        this.lhmStatus = { ok: true, message: 'ok' };
      } catch (err) {
        this.lhmStatus = { ok: false, message: err.name === 'TimeoutError' ? this.t('lhm.noAnswer') : err.message };
      }
    } else {
      this.lhmStatus = { ok: false, message: this.t('lhm.noUrl') };
    }

    this.snapshot = sensors;
    this.emit('update', sensors);
  }
}

module.exports = { Sensors, parseReading, flattenLhm };
