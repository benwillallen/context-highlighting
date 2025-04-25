import path from 'path';
import { fileURLToPath } from 'url';

import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyPlugin from 'copy-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browser = process.env.NODE_ENV || 'chromium';

const config = {
    mode: 'development',
    devtool: 'source-map',
    experiments: {
        asyncWebAssembly: true
    },
    entry: {
        background: './background.js',
        popup: './popup.js',
        content: './content.js',
        offscreen: './offscreen.js',
        worker: './worker.js'
    },
    output: {
        path: path.resolve(__dirname, `dist/${browser}`),
        filename: '[name].js'
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './popup.html',
            filename: 'popup.html'
        }),
        new HtmlWebpackPlugin({
            template: './offscreen.html',
            filename: 'offscreen.html',
            chunks: ['offscreen']
        }),
        new CopyPlugin({
            patterns: [
                {
                    from: 'images',
                    to: './images'
                },
                {
                    from: `manifest${browser === 'firefox' ? '.firefox' : ''}.json`,
                    to: './manifest.json'
                },
                {
                    from: '*.wasm',
                    context: 'node_modules/@xenova/transformers/dist',
                    to: './ort'
                }
            ]
        })
    ],
    resolve: {
        extensions: ['.js', '.ts']
    }
};

export default config;