'use strict';

const fs = require('fs');
const path = require('path');

let nextId = Date.now();
const newId = (prefix) => `${prefix}${(nextId++).toString(36)}`;

/*
 * Modelo:
 *   config.screens[]       os "widgets" que o utilizador vê: um ecrã completo do LCD
 *     { id, name, enabled, durationSec, background, design: { width, height }, components[] }
 *   screen.design          tamanho com que o ecrã foi desenhado: os componentes ficam
 *                          nestas coordenadas e são ampliados ao LCD ao desenhar
 *   screen.components[]    os blocos que compõem o ecrã (gauge, valor, …)
 *     { id, type, x, y, w, h, props }
 *
 * O modo Execução roda pelos ecrãs com enabled, cada um durante durationSec.
 */

/**
 * Configuração inicial: os dois ecrãs do firmware antigo (CPU e GPU) com os
 * sensores do LibreHardwareMonitor deste PC, mais um relógio.
 */
function defaultConfig() {
  const monitor = (name, title, temp, load, power) => ({
    id: newId('s'),
    name,
    enabled: true,
    durationSec: 10,
    background: '#000000',
    components: [
      { id: newId('c'), type: 'label', x: 10, y: 6, w: 220, h: 30, props: { text: title, size: 22, color: '#ffffff', align: 'center', weight: '600' } },
      { id: newId('c'), type: 'gauge', x: 30, y: 40, w: 180, h: 165, props: { sensor: temp, label: 'Temp', min: 20, max: 95, decimals: 0 } },
      { id: newId('c'), type: 'value', x: 10, y: 205, w: 105, h: 52, props: { sensor: load, label: 'Load', decimals: 0, color: '#4fc3f7' } },
      { id: newId('c'), type: 'value', x: 125, y: 205, w: 105, h: 52, props: { sensor: power, label: 'Power', decimals: 0, color: '#ffb74d' } },
      { id: newId('c'), type: 'graph', x: 10, y: 262, w: 220, h: 52, props: { sensor: load, min: 0, max: 100, color: '#4fc3f7' } },
    ],
  });

  return {
    version: 2,
    lhmUrl: 'http://192.168.1.20:8085/data.json',
    sensorIntervalMs: 1000,
    frameRate: 30,
    startWithWindows: false,
    port: 'auto',
    language: 'en',   // 'en' | 'pt' (src/i18n.js)
    // Transição entre widgets (cada widget pode ter a sua: screen.transition).
    transition: { type: 'fade', durationMs: 500 },
    // Área visível do painel: null = automático (o tamanho que o ESP32 reporta);
    // { x, y, width, height } quando o painel mostra só parte do controlador.
    display: null,
    // Ampliação dos ecrãs quando o LCD não tem o tamanho do desenho (src/scaling.js):
    // 'auto' | 'fit' | 'fill' | 'off'. Fora de "display" para não o tornar manual.
    scaleMode: 'auto',
    screens: [
      monitor('CPU', 'Ryzen 5', '/amdcpu/0/temperature/2', '/amdcpu/0/load/0', '/amdcpu/0/power/0'),
      monitor('GPU', 'RX 580', '/gpu-amd/0/temperature/0', '/gpu-amd/0/load/0', '/gpu-amd/0/power/3'),
      {
        id: newId('s'),
        name: 'Clock',
        enabled: true,
        durationSec: 10,
        background: '#000000',
        components: [
          { id: newId('c'), type: 'clock', x: 10, y: 90, w: 220, h: 120, props: {} },
          { id: newId('c'), type: 'bar', x: 20, y: 240, w: 200, h: 34, props: { sensor: 'sys/mem/load', label: 'RAM' } },
        ],
      },
    ],
  };
}

/** Converte configurações antigas (v1: pages[].widgets[]) para o modelo atual. */
function migrate(cfg) {
  if (Array.isArray(cfg.pages) && !cfg.screens) {
    cfg.screens = cfg.pages.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: true,
      durationSec: p.durationSec || 10,
      background: p.background || '#000000',
      components: p.widgets || [],
    }));
    delete cfg.pages;
    delete cfg.rotatePages;
    cfg.version = 2;
  }
  for (const s of cfg.screens || []) {
    if (s.enabled === undefined) s.enabled = true;
    if (!Array.isArray(s.components)) s.components = [];
  }
  return cfg;
}

class ConfigStore {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.stateFile = path.join(dir, 'state.json');
    this.saveTimer = null;
  }

  load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      const cfg = defaultConfig();
      this.saveNow(cfg);
      return cfg;
    }
    return migrate({ ...defaultConfig(), ...migrate(raw) });
  }

  /** Grava com atraso para juntar alterações seguidas (ex: arrastar um componente). */
  save(cfg) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(cfg), 500);
  }

  saveNow(cfg) {
    clearTimeout(this.saveTimer);
    writeJson(this.file, cfg);
  }

  /** Estado que não é configuração do utilizador (última porta, tamanho do ecrã). */
  loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  saveState(state) {
    writeJson(this.stateFile, state);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { ConfigStore, defaultConfig, migrate, newId };
