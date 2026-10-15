// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pacote da Webview: o renderer do OpenPLC Editor v4.2.8 (configs/webpack/webpack.config.renderer.prod.ts)
 * com a entrada do LasecSimul. Diferenças: alvo `web` (Webview do VS Code, sem Node), tudo
 * empacotado (sem `externals` do Electron), `publicPath: 'auto'` (os arquivos saem de
 * `asWebviewUri`), sem HTML (o host monta a página com a CSP dele).
 *
 * Roda na raiz da árvore do OpenPLC, com esta pasta copiada em `src/lasecsimul/`
 * (scripts/build-openplc-workspace.js).
 */

const path = require('path')
const autoprefixer = require('autoprefixer')
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const MonacoEditorWebpackPlugin = require('monaco-editor-webpack-plugin')
const tailwindcss = require('tailwindcss')
const TerserPlugin = require('terser-webpack-plugin')
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin')
const webpack = require('webpack')

const root = process.cwd()
const outDir = process.env.LASECSIMUL_OPENPLC_OUT || path.join(root, 'release', 'lasecsimul')
const production = process.env.NODE_ENV !== 'development'

module.exports = {
  mode: production ? 'production' : 'development',
  devtool: production ? false : 'source-map',
  target: 'web',
  stats: 'errors-warnings',
  entry: { openplc: path.join(root, 'src', 'lasecsimul', 'webview', 'main.tsx') },
  output: {
    path: path.join(outDir, 'webview'),
    publicPath: 'auto',
    filename: '[name].js',
    chunkFilename: 'chunks/[name].[contenthash:8].js',
    assetModuleFilename: 'assets/[name].[contenthash:8][ext]',
    clean: true,
  },
  performance: { hints: false },
  resolve: {
    extensions: ['.js', '.jsx', '.json', '.ts', '.tsx'],
    modules: [path.join(root, 'src'), 'node_modules'],
    plugins: [new TsconfigPathsPlugin({ configFile: path.join(root, 'tsconfig.json') })],
    fallback: { fs: false, path: false, os: false, crypto: false, child_process: false, net: false, tls: false },
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: { transpileOnly: true, compilerOptions: { module: 'esnext' } },
          },
          { loader: path.join(root, 'src', 'lasecsimul', 'patch-loader.cjs') },
        ],
      },
      {
        test: /\.s?(a|c)ss$/,
        use: [
          MiniCssExtractPlugin.loader,
          { loader: 'css-loader', options: { modules: true, importLoaders: 1 } },
          'sass-loader',
        ],
        include: /\.module\.s?(c|a)ss$/,
      },
      {
        test: /\.s?(a|c)ss$/,
        use: [
          MiniCssExtractPlugin.loader,
          'css-loader',
          'sass-loader',
          { loader: 'postcss-loader', options: { postcssOptions: { plugins: [tailwindcss, autoprefixer] } } },
        ],
        exclude: /\.module\.s?(c|a)ss$/,
      },
      { test: /\.(woff|woff2|eot|ttf|otf)$/i, type: 'asset/resource' },
      { resourceQuery: /^\?url$/, type: 'asset/resource' },
      { test: /\.(png|jpg|jpeg|gif)$/i, type: 'asset/resource' },
      {
        test: /\.svg$/,
        use: [
          {
            loader: '@svgr/webpack',
            options: { prettier: false, svgo: false, svgoConfig: { plugins: [{ removeViewBox: false }] }, titleProp: true, ref: true },
          },
          'file-loader',
        ],
      },
    ],
  },
  optimization: {
    minimize: production,
    minimizer: [new TerserPlugin(), new CssMinimizerPlugin()],
  },
  plugins: [
    new webpack.EnvironmentPlugin({ NODE_ENV: production ? 'production' : 'development', DEBUG_PROD: false, VPP_CATALOG_URL: '' }),
    new webpack.DefinePlugin({
      'process.type': '"renderer"',
      'process.platform': JSON.stringify(process.platform),
      APP_NAME: JSON.stringify('OpenPLC Editor'),
      BUILD_DATE: JSON.stringify(process.env.BUILD_DATE || new Date().toISOString().slice(0, 10)),
    }),
    new webpack.ProvidePlugin({ process: path.join(root, 'src', 'lasecsimul', 'webview', 'process-shim.cjs') }),
    new MiniCssExtractPlugin({ filename: '[name].css', chunkFilename: 'chunks/[name].[contenthash:8].css' }),
    new MonacoEditorWebpackPlugin({ languages: ['json'], filename: 'workers/[name].worker.js' }),
  ],
}
