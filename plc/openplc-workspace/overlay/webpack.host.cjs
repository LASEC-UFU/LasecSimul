// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pacote do host (Node, dentro da extensão do VS Code): serviços de projeto/POU/biblioteca e o
 * transpilador do OpenPLC Editor v4.2.8, com `electron` trocado por src/lasecsimul/host/electron-shim.ts.
 */

const path = require('path')
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin')
const webpack = require('webpack')

const root = process.cwd()
const outDir = process.env.LASECSIMUL_OPENPLC_OUT || path.join(root, 'release', 'lasecsimul')
const production = process.env.NODE_ENV !== 'development'

module.exports = {
  mode: production ? 'production' : 'development',
  devtool: false,
  target: 'node18',
  stats: 'errors-warnings',
  entry: { host: path.join(root, 'src', 'lasecsimul', 'host', 'index.ts') },
  output: {
    path: path.join(outDir, 'host'),
    filename: '[name].js',
    library: { type: 'commonjs2' },
    clean: true,
  },
  performance: { hints: false },
  resolve: {
    extensions: ['.js', '.json', '.ts', '.tsx'],
    modules: [path.join(root, 'src'), 'node_modules'],
    plugins: [new TsconfigPathsPlugin({ configFile: path.join(root, 'tsconfig.json') })],
    alias: { electron$: path.join(root, 'src', 'lasecsimul', 'host', 'electron-shim.ts') },
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: [
          { loader: 'ts-loader', options: { transpileOnly: true, compilerOptions: { module: 'esnext' } } },
          { loader: path.join(root, 'src', 'lasecsimul', 'patch-loader.cjs') },
        ],
      },
    ],
  },
  optimization: { minimize: false },
  plugins: [new webpack.EnvironmentPlugin({ NODE_ENV: production ? 'production' : 'development' })],
}
