'use strict';

// Arranca a app com o Electron local.
// - Remove ELECTRON_RUN_AS_NODE (o terminal do VS Code define-o e o Electron
//   arrancaria como Node puro).
// - Se o binário do Electron não foi descarregado (o npm 12 bloqueia scripts
//   de instalação por omissão), corre o instalador do pacote primeiro.

const { spawnSync, spawn } = require('child_process');
const path = require('path');

function electronPath() {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

let exe = electronPath();
if (!exe) {
  console.log('A descarregar o Electron...');
  const res = spawnSync(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status || 1);
  delete require.cache[require.resolve('electron')];
  exe = electronPath();
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
