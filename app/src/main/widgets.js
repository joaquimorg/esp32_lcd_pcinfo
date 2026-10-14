'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { appError } = require('../i18n');

const PROPERTY_TYPES = ['text', 'number', 'color', 'boolean', 'select', 'sensor', 'file'];
// Grupos da paleta do editor (campo "category" do manifest; por omissão "component").
const CATEGORIES = ['component', 'shape', 'image'];
const SDK_TAG = '<script src="../_sdk/widget-sdk.js"></script>';
const MANIFEST_RE = /<script[^>]*id=["']widget-manifest["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * Catálogo de widgets. Cada widget é uma pasta com um widget.html e o manifest
 * (nome, tamanho por omissão e propriedades configuráveis), que pode estar:
 *   - num manifest.json ao lado, ou
 *   - embutido no próprio HTML (formato de ficheiro único, ver docs/widget-ai-spec.md):
 *       <script type="application/json" id="widget-manifest">{ ... }</script>
 *
 * Os widgets da pasta do utilizador sobrepõem-se aos incluídos com o mesmo nome.
 */
function scanWidgets(dirs) {
  const catalog = {};
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('_')) continue;
      const folder = path.join(dir, e.name);
      const html = path.join(folder, 'widget.html');
      try {
        if (!fs.existsSync(html)) continue;
        const manifestFile = path.join(folder, 'manifest.json');
        const manifest = fs.existsSync(manifestFile)
          ? JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
          : parseEmbeddedManifest(fs.readFileSync(html, 'utf8'));
        catalog[e.name] = {
          type: e.name,
          name: manifest.name || e.name,
          description: manifest.description || '',
          category: CATEGORIES.includes(manifest.category) ? manifest.category : 'component',
          i18n: manifest.i18n && typeof manifest.i18n === 'object' ? manifest.i18n : undefined,
          size: manifest.size || { w: 120, h: 60 },
          properties: manifest.properties || [],
          url: pathToFileURL(html).href,
          folder,
        };
      } catch {
        // manifest inválido: ignora o widget
      }
    }
  }
  return catalog;
}

function parseEmbeddedManifest(html) {
  const m = MANIFEST_RE.exec(html);
  if (!m) throw appError('err.noManifestTag');
  try {
    return JSON.parse(m[1]);
  } catch (err) {
    throw appError('err.badManifestJson', { error: err.message });
  }
}

function validateManifest(m) {
  if (!m || typeof m !== 'object') throw appError('err.emptyManifest');
  if (!m.name || typeof m.name !== 'string') throw appError('err.noName');
  if (m.size && !(m.size.w > 0 && m.size.h > 0)) throw appError('err.badSize');
  if (m.properties && !Array.isArray(m.properties)) throw appError('err.propsNotList');
  for (const p of m.properties || []) {
    if (!p.key || !p.label) throw appError('err.propKeyLabel');
    if (!PROPERTY_TYPES.includes(p.type)) throw appError('err.propType', { key: p.key, type: p.type });
    if (p.type === 'select' && !Array.isArray(p.options)) throw appError('err.selectOptions', { key: p.key });
  }
}

/** Texto colado de uma conversa com IA: tira as cercas ``` e o texto à volta. */
function extractHtml(text) {
  const fenced = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text);
  let html = (fenced ? fenced[1] : text).trim();
  const start = html.search(/<!doctype html|<html/i);
  if (start > 0) html = html.slice(start);
  return html;
}

function slugify(name) {
  const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'widget';
}

/**
 * Importa um widget de ficheiro único para a pasta do utilizador.
 * Devolve o tipo (nome da pasta) criado.
 */
function importWidget(text, userDir, existingTypes) {
  let html = extractHtml(text);
  const manifest = parseEmbeddedManifest(html);
  validateManifest(manifest);

  if (!html.includes('widget-sdk.js')) {
    // Sem o SDK o widget nunca recebe dados: injeta-o antes do primeiro <script>.
    const idx = html.search(/<script(?![^>]*widget-manifest)/i);
    html = idx >= 0 ? html.slice(0, idx) + SDK_TAG + '\n' + html.slice(idx) : html + '\n' + SDK_TAG;
  }

  const base = 'ai-' + slugify(manifest.name);
  let type = base;
  for (let n = 2; existingTypes.has(type) || fs.existsSync(path.join(userDir, type)); n++) type = `${base}-${n}`;
  const folder = path.join(userDir, type);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'widget.html'), html);
  return { type, name: manifest.name };
}

/** Props com os valores por omissão do manifest preenchidos. */
function withDefaults(widgetType, props) {
  const out = {};
  for (const p of widgetType.properties) {
    if (p.default !== undefined) out[p.key] = p.default;
  }
  return { ...out, ...props };
}

/** Copia o SDK para a pasta de widgets do utilizador, para os widgets lá criados o encontrarem. */
function ensureUserWidgetsDir(userDir, builtinDir) {
  const sdkDir = path.join(userDir, '_sdk');
  fs.mkdirSync(sdkDir, { recursive: true });
  // readFile + writeFile em vez de copyFile: a origem pode estar dentro do app.asar.
  fs.writeFileSync(path.join(sdkDir, 'widget-sdk.js'), fs.readFileSync(path.join(builtinDir, '_sdk', 'widget-sdk.js')));
}

module.exports = { scanWidgets, withDefaults, ensureUserWidgetsDir, importWidget, extractHtml, PROPERTY_TYPES, CATEGORIES };
