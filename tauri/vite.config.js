import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { json } from '../web/session-api.js';
import { createLocalApi } from '../web/local-api.js';
import { accountApi } from '../web/account-api.js';

const appPath = import.meta.url;
const macPrefixesId = 'virtual:epi-mac-prefixes';
const macPrefixesPath = fileURLToPath(new URL('../shared/mac-prefixes.json', appPath));
const modules = {
  'virtual:epi-domain': './domain/browser.js',
  'virtual:epi-composition': '../shared/composition.cjs',
};

function sharedModules() {
  const directory = fileURLToPath(new URL('.', appPath));
  const dependencies = new Map();
  let prefixChunks;
  async function loadPrefixChunks() {
    return prefixChunks ??= readFile(macPrefixesPath, 'utf8').then(source => {
      const chunks = [[]];
      let bytes = 0;
      for (const entry of Object.entries(JSON.parse(source))) {
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > 200_000 && chunks.at(-1).length) {
          chunks.push([]);
          bytes = 0;
        }
        chunks.at(-1).push(entry);
        bytes += size;
      }
      return chunks.map(entries => JSON.stringify(Object.fromEntries(entries)));
    });
  }
  return {
    name: 'epi-shared-modules',
    buildStart() { prefixChunks = undefined; },
    resolveId(id) {
      if (Object.hasOwn(modules, id) || id === macPrefixesId || id.startsWith(macPrefixesId + '/')) return '\0' + id;
    },
    async load(id) {
      if (id === '\0' + macPrefixesId || id.startsWith('\0' + macPrefixesId + '/')) {
        this.addWatchFile(macPrefixesPath);
        const chunks = await loadPrefixChunks();
        if (id !== '\0' + macPrefixesId) {
          return 'export default ' + chunks[Number(id.split('/').at(-1))] + ';';
        }
        // Keep the complete offline lookup, but let Rollup emit bounded data chunks.
        return chunks.map((_, index) => "import p" + index + " from '" + macPrefixesId + '/' + index + "';").join('\n')
          + '\nexport default Object.assign({}, ' + chunks.map((_, index) => 'p' + index).join(', ') + ');';
      }
      if (!id.startsWith('\0virtual:epi-')) return;
      const result = await build({
        entryPoints: [fileURLToPath(new URL(modules[id.slice(1)], appPath))],
        absWorkingDir: directory,
        bundle: true,
        metafile: true,
        format: 'esm',
        platform: 'browser',
        write: false,
        plugins: [{
          name: 'external-mac-prefixes',
          setup(build) {
            build.onLoad({ filter: /[\\/]mac-prefixes\.json$/ }, () => ({
              contents: "import prefixes from '" + macPrefixesId + "'; module.exports = prefixes;",
              loader: 'js',
            }));
            build.onResolve({ filter: /^virtual:epi-mac-prefixes$/ }, () => ({ path: macPrefixesId, external: true }));
          },
        }],
      });
      const files = Object.keys(result.metafile.inputs).map(path => resolve(directory, path));
      dependencies.set(id, files);
      for (const file of files) this.addWatchFile(file);
      return result.outputFiles[0].text;
    },
    handleHotUpdate({ file, server }) {
      const updated = [...dependencies].filter(([, files]) => files.includes(resolve(file)));
      if (!updated.length) return;
      if (resolve(file) === macPrefixesPath) {
        prefixChunks = undefined;
        // Rebuild the virtual data modules along with their CommonJS consumer.
        for (const [id, module] of server.moduleGraph.idToModuleMap) {
          if (id.startsWith('\0' + macPrefixesId)) server.moduleGraph.invalidateModule(module);
        }
      }
      // Rebuild the bundled CommonJS module before reloading its consumers.
      for (const [id] of updated) {
        const module = server.moduleGraph.getModuleById(id);
        if (module) server.moduleGraph.invalidateModule(module);
      }
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}

function webSessionApi() {
  return {
    name: 'epi-web-session-api',
    configureServer(server) {
      const root = fileURLToPath(new URL('../web/', appPath));
      const require = createRequire(appPath);
      const directories = ['./domain/', '../shared/'].map(path => fileURLToPath(new URL(path, appPath)));
      const isSessionSource = file => directories.some(directory => resolve(file).startsWith(directory))
        && /\.(cjs|js|json)$/.test(file);
      let sessionApi;

      // Keep the server session in step with Vite's reloaded browser modules.
      server.watcher.add(directories);
      server.watcher.on('all', (event, file) => {
        if (!['add', 'change', 'unlink'].includes(event) || !isSessionSource(file)) return;
        for (const path of Object.keys(require.cache)) {
          if (isSessionSource(path)) delete require.cache[path];
        }
        sessionApi = undefined;
      });
      // Let Vite listen and open the browser before reading the data directory.
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split('?')[0];
        if (!['/api/session', '/api/installation'].includes(pathname)) return next();
        try {
          if (!sessionApi) {
            const domain = require('./domain/session.cjs');
            const storage = require('../shared/data-directory.cjs');
            const transactions = require('../shared/transactions.cjs');
            sessionApi = createLocalApi({ root, domain, storage, transactions });
          }
          await sessionApi.handle(request, response, pathname);
        } catch (error) {
          if (response.headersSent) return next(error);
          server.config.logger.error(error.stack ?? String(error));
          json(response, 500, { error: error.message });
        }
      });
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  define: { __DEV_ACCOUNT_API__: JSON.stringify(accountApi) },
  clearScreen: false,
  optimizeDeps: { entries: ['index.html'] },
  plugins: [sharedModules(), ...(command === 'serve' && mode === 'web' ? [webSessionApi()] : [])],
  server: {
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: mode === 'web' ? 1421 : 1420,
    strictPort: mode !== 'web',
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL('..', appPath))] },
  },
  build: {
    target: ['chrome105', 'safari15'],
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.startsWith('\0' + macPrefixesId + '/')) return 'mac-prefixes-' + id.split('/').at(-1);
        },
      },
    },
  },
}));
