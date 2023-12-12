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

type ModuleMeta = esbuild.Metafile & {
  inputs: esbuild.Metafile['inputs'] & {
    [path: string]: {
      bytes: number;
      parents?: Set<string>;
      imports: {
        path: string;
        kind: esbuild.ImportKind;
        external?: boolean;
        original?: string;
      }[]
      format?: 'cjs' | 'esm'
    }
  }
}

const ROOT = path.resolve('.');
const sharedState: {
  _idx: number;
  context: esbuild.BuildContext | null;
  bundle: Uint8Array | null;
  moduleMeta: ModuleMeta | null;
  clients: WebSocket[];
} = {
  _idx: 0, // for unique variable name
  context: null,
  bundle: null,
  moduleMeta: null,
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
          ['swc-plugin-global-module', {
            runtimeModule,
            importPaths,
          }],
        ],
      },
    },
  });

  const contextVariableName = `__hmr${sharedState._idx++}`;
  const code = `
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

  return runtimeModule ? `try {
    ${code}
  } catch(error) {
    alert('HMR Failed');
    window.location.reload();
  }` : code;
};

(async function() {
  const entryFile = path.resolve('./client/index.ts');
  const strippedEntryFile = stripRoot(entryFile);

  await setupWatcher((event, changedFilePath, _stats) => {
    if (event !== 'change' || !changedFilePath.endsWith('.ts')) return;
    console.log(`file changed: ${event}`, { path: changedFilePath });
    if (sharedState.clients.length) {
      console.log('[HMR] Send update message to client');

      const strippedPath = stripRoot(changedFilePath);
      const sendToClients = (message: string) => {
        sharedState.clients.forEach((socket) => {
          socket.send(message);
        });
      };

      const getModule = (modulePath: string) => {
        const currentFile = sharedState.moduleMeta.inputs[modulePath];
        if (!currentFile) {
          console.warn(`unable to get meta data of ${path}`);
          return null;
        }
        return currentFile;
      };

      const getImportPaths = (modulePath: string) => {
        return getModule(modulePath)?.imports?.reduce((prev, curr) => ({
          ...prev, [curr.original]: curr.path,
        }), {}) ?? {};
      };

      const getReverseDependencies = (targetModule: string, dependencies: string[] = []) => {
        if (sharedState.moduleMeta.inputs[targetModule]?.parents) {
          sharedState.moduleMeta.inputs[targetModule].parents.forEach((parentModule) => {
            dependencies = getReverseDependencies(parentModule, [...dependencies, parentModule]);
          });
        }
        return dependencies;
      }

      const reverseDependencies = [
        strippedPath,
        ...getReverseDependencies(strippedPath),
      ];

      console.log('reverse dependencies', JSON.stringify(reverseDependencies, null, 2));

      reverseDependencies.reduce((prev, modulePath) => prev.then(() => {
        return transformCode(path.join(ROOT, modulePath), true, getImportPaths(modulePath)).then((code) => {
          sendToClients(JSON.stringify({
            type: 'update',
            body: code,
            id: strippedPath,
          }));
        });
      }), Promise.resolve()).catch((error) => {
        console.error('[HMR] Transform error', error);
        sharedState.context.rebuild().then(() => {
          sendToClients(JSON.stringify({ type: 'reload' }));
        });
      });
    }
  });

  const context = await esbuild.context({
    entryPoints: [entryFile],
    bundle: true,
    format: 'esm',
    target: 'es6',
    write: false,
    metafile: true,
    sourceRoot: ROOT,
    inject: ['swc-plugin-global-module/runtime'],
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

            const metafile = result.metafile as ModuleMeta;
            Object.entries(metafile.inputs).forEach(([filename, moduleInfo]) => {
              moduleInfo.imports.forEach(({ path }) => {
                if (!metafile.inputs[path]) {
                  console.warn(`${path} is not exist in metafile`);
                  return;
                }

                if (!metafile.inputs[path].parents) {
                  metafile.inputs[path].parents = new Set();
                }

                metafile.inputs[path].parents.add(filename);
                console.log(`parent ${filename}, child: ${path}`);
              });
            });

            console.log(JSON.stringify(metafile, (_key, value) => {
              if (value instanceof Set) {
                return Array.from(value);
              }
              return value;
            }, 2));

            sharedState.bundle = result.outputFiles[0].contents;
            sharedState.moduleMeta = metafile;
          });
        },
      },
    ],
  });

  // Trigger first build.
  await context.rebuild();

  startServer();
})();
