import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import url from 'node:url';
import type { Stats } from 'node:fs';
import express from 'express';
import WebSocket from 'ws';
import * as esbuild from 'esbuild';
import * as chokidar from 'chokidar';
import { transform } from '@swc/core';

const ROOT = path.resolve('.');
const sharedState: {
  _idx: number;
  context: esbuild.BuildContext | null;
  bundle: Uint8Array | null;
  metafile: esbuild.Metafile | null;
  clients: WebSocket[];
} = {
  _idx: 0, // for unique variable name
  context: null,
  bundle: null,
  metafile: null,
  clients: [],
};

const setupWatcher = (handler: (event: string, path: string, stats?: Stats) => void) => {
  return new Promise((resolve, reject) => {
    chokidar.watch(path.resolve('./client'), {
      alwaysStat: true,
      ignoreInitial: true,
      ignored: /(?:^|[/\\])\../,
    }).on('addDir', (path, stats) => handler('addDir', path, stats))
      .on('unlinkDir', (path) => handler('unlinkDir', path))
      .on('add', (path, stats) => handler('add', path, stats))
      .on('change', (path, stats) => handler('change', path, stats))
      .on('unlink', (path) => handler('unlink', path))
      .on('ready', resolve)
      .on('error', reject);
  });
}

const startServer = () => {
  const app = express();

  app.use((req, _res, next) => {
    console.log(req.method, req.path);
    next();
  });

  app.get('/', (_req, res) => {
    fs.readFile('./client/index.html', 'utf-8').then((data) => {
      res.write(data);
      res.status(200).end();
    }).catch((error) => {
      res.writeHead(500, error.message).end();
    });
  });

  app.get('/bundle.js', (_req, res) => {
    if (sharedState.bundle) {
      res.write(sharedState.bundle);
      res.status(200).end();
    } else {
      res.status(404).end();
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (!request.url) return;

    const { pathname } = url.parse(request.url);
    if (pathname === '/hot') {
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit('connection', client, request);
        sharedState.clients.push(client);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(8080, () => {
    console.log('listening...');
  });
};

const stripRoot = (path: string) => {
  return path.replace(ROOT, '').substring(1);
};

const transformCode = async (
  path: string,
  runtimeModule = false,
  importPaths: Record<string, string> = {},
) => {
  const filename = stripRoot(path);
  const result = await transform(await fs.readFile(path, 'utf-8'), {
    filename,
    jsc: {
      parser: {
        syntax: 'typescript',
      },
      target: 'es5',
      externalHelpers: !runtimeModule,
      experimental: {
        plugins: [
          ['swc-plugin-global-esm', {
            runtimeModule,
            importPaths,
          }],
        ],
      },
    },
  });

  const contextVariableName = `__hmr${sharedState._idx++}`;

  return `
  var ${contextVariableName} = window.__hot.register(${JSON.stringify(filename)});

  ${result.code}
  
  ${contextVariableName}.accept(({ body }) => {
    console.log('accepted!', ${JSON.stringify(filename)});
    console.log(body);
  });
  ${contextVariableName}.dispose(() => {
    console.log('disposed!', ${JSON.stringify(filename)});
  });
  `;
};

(async function() {
  await setupWatcher((event, path, _stats) => {
    if (event !== 'change' || !path.endsWith('.ts')) return;
    console.log(`file changed: ${event}`, { path });
    if (sharedState.clients.length) {
      console.log('[HMR] Send update message to client');

      const strippedPath = stripRoot(path);
      const sendToClients = (message: string) => {
        sharedState.clients.forEach((socket) => {
          socket.send(message);
        });
      };

      const getModule = () => {
        const currentFile = sharedState.metafile.inputs[strippedPath];
        if (!currentFile) {
          console.warn(`unable to get meta data of ${path}`);
          return null;
        }
        return currentFile;
      };

      const getImportPaths = () => {
        return getModule()?.imports?.reduce((prev, curr) => ({
          ...prev, [curr.original]: curr.path,
        }), {}) ?? {};
      };

      transformCode(path, true, getImportPaths()).then((code) => {
        sendToClients(JSON.stringify({
          type: 'update',
          body: code,
          id: strippedPath,
        }));
      }).catch((error) => {
        console.error('[HMR] Transform error', error);
        sharedState.context.rebuild().then(() => {
          sendToClients(JSON.stringify({ type: 'reload' }));
        });
      });
    }
  });

  const context = await esbuild.context({
    entryPoints: ['./client/index.ts'],
    bundle: true,
    format: 'esm',
    target: 'es6',
    write: false,
    metafile: true,
    sourceRoot: ROOT,
    inject: ['swc-plugin-global-esm/runtime'],
    plugins: [
      {
        name: 'hmr-transformer',
        setup(build) {
          build.onStart(() => console.log('esbuild.onStart'));
          build.onLoad({ filter: /\.ts$/ }, async (args) => {
            console.log('esbuild.onLoad', args.path);
            return {
              loader: 'js',
              contents: await transformCode(args.path),
            };
          });
          build.onEnd((result) => {
            console.log('esbuild.onEnd');
            sharedState.bundle = result.outputFiles[0].contents;
            sharedState.metafile = result.metafile;
          });
        },
      },
    ],
  });

  // Trigger first build.
  await context.rebuild();

  startServer();
})();
