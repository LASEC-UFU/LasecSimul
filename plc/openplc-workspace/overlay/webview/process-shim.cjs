// SPDX-License-Identifier: GPL-3.0-or-later
// `process` mínimo para código do renderer do OpenPLC que no Electron lia o objeto do Node.
module.exports = {
  env: { NODE_ENV: process.env.NODE_ENV },
  platform: 'browser',
  type: 'renderer',
  versions: {},
  argv: [],
  cwd: () => '/',
  nextTick: (callback, ...args) => Promise.resolve().then(() => callback(...args)),
}
