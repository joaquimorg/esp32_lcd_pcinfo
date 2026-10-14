'use strict';

const fs = require('fs');
const path = require('path');
const { appError } = require('../i18n');

/*
 * Ficheiro .lcdwidget — um widget (ecrã completo) autocontido, para partilhar
 * ou para editar noutro PC:
 *
 *   {
 *     "format": "usb-lcd-widget", "version": 1,
 *     "name": "CPU", "screen": { "width": 240, "height": 320 }, "background": "#000000",
 *     "transition": { "type": "slide-left" },                              // opcional
 *     "components": [ { "type", "x", "y", "w", "h", "props" } ],
 *     "types":  { "<tipo>": { "html": "...", "manifest": {...} | null } },  // componentes não incluídos na app
 *     "assets": { "<id>": "data:image/png;base64,..." }                    // imagens (props do tipo file)
 *   }
 *
 * Nas props, as imagens aparecem como "asset:<id>". Os IDs de sensores são
 * guardados como estão: noutro PC, os que não existirem mostram "--" até
 * serem escolhidos de novo no editor.
 */

const FORMAT = 'usb-lcd-widget';
const VERSION = 1;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' };
const EXT = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]));

/**
 * @param screen   ecrã da configuração
 * @param catalog  catálogo de componentes (com folder)
 * @param builtin  Set com os tipos incluídos na app (não são embutidos)
 */
function exportScreen(screen, { catalog, builtin, size }) {
  const types = {};
  const assets = {};
  let assetN = 0;

  const components = screen.components.map((c) => {
    const type = catalog[c.type];
    const props = { ...c.props };
    if (type) {
      if (!builtin.has(c.type) && !types[c.type]) {
        const manifestFile = path.join(type.folder, 'manifest.json');
        types[c.type] = {
          html: fs.readFileSync(path.join(type.folder, 'widget.html'), 'utf8'),
          manifest: fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null,
        };
      }
      for (const p of type.properties) {
        if (p.type !== 'file' || !props[p.key]) continue;
        try {
          const ext = path.extname(props[p.key]).slice(1).toLowerCase();
          const data = fs.readFileSync(props[p.key]).toString('base64');
          const id = `a${++assetN}`;
          assets[id] = `data:${MIME[ext] || 'application/octet-stream'};base64,${data}`;
          props[p.key] = `asset:${id}`;
        } catch {
          props[p.key] = '';   // imagem já não existe
        }
      }
    }
    return { type: c.type, x: c.x, y: c.y, w: c.w, h: c.h, props };
  });

  return {
    format: FORMAT,
    version: VERSION,
    name: screen.name,
    screen: { width: size.width, height: size.height },
    background: screen.background || '#000000',
    ...(screen.transition ? { transition: { type: screen.transition.type } } : {}),
    components,
    types,
    assets,
  };
}

/**
 * Cria um ecrã a partir de um ficheiro exportado. Escreve os componentes
 * embutidos na pasta do utilizador e as imagens em assetsDir.
 * Devolve { screen, newTypes } — newTypes é a lista de pastas criadas.
 */
function importScreen(data, { catalog, userWidgetsDir, assetsDir, newId }) {
  if (!data || data.format !== FORMAT) throw appError('err.notLcdwidget');
  if (data.version > VERSION) throw appError('err.newerFile', { v: data.version, max: VERSION });
  if (!Array.isArray(data.components)) throw appError('err.noComponents');

  // Componentes embutidos: reutiliza se já existir igual, senão cria (com outro nome se preciso).
  const typeMap = {};
  const newTypes = [];
  for (const [type, def] of Object.entries(data.types || {})) {
    if (!def || typeof def.html !== 'string') continue;
    const existing = catalog[type];
    if (existing && readHtml(existing.folder) === def.html) {
      typeMap[type] = type;
      continue;
    }
    let name = type;
    for (let n = 2; catalog[name] || fs.existsSync(path.join(userWidgetsDir, name)); n++) name = `${type}-${n}`;
    const folder = path.join(userWidgetsDir, name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'widget.html'), def.html);
    if (def.manifest) fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(def.manifest, null, 2));
    typeMap[type] = name;
    newTypes.push(name);
  }

  const screenId = newId('s');
  const assetFiles = {};
  for (const [id, url] of Object.entries(data.assets || {})) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url || '');
    if (!m) continue;
    fs.mkdirSync(assetsDir, { recursive: true });
    const file = path.join(assetsDir, `${screenId}-${id}.${EXT[m[1]] || 'bin'}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    assetFiles[id] = file;
  }

  const components = data.components.map((c) => {
    const props = { ...(c.props || {}) };
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === 'string' && v.startsWith('asset:')) props[k] = assetFiles[v.slice(6)] || '';
    }
    return {
      id: newId('c'),
      type: typeMap[c.type] || c.type,
      x: num(c.x), y: num(c.y), w: Math.max(8, num(c.w)), h: Math.max(8, num(c.h)),
      props,
    };
  });

  return {
    screen: {
      id: screenId,
      name: String(data.name || 'Widget importado'),
      enabled: true,
      durationSec: 10,
      background: data.background || '#000000',
      ...(typeof data.transition?.type === 'string' ? { transition: { type: data.transition.type } } : {}),
      components,
    },
    newTypes,
  };
}

function readHtml(folder) {
  try {
    return fs.readFileSync(path.join(folder, 'widget.html'), 'utf8');
  } catch {
    return null;
  }
}

function num(v) {
  return Math.round(Number(v) || 0);
}

module.exports = { exportScreen, importScreen, FORMAT };
