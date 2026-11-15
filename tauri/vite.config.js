import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSessionApi, json } from '../web/session-api.js';

const appPath = import.meta.url;
const modules = {
  'virtual:epi-domain': './domain/browser.js',
  'virtual:epi-composition': '../shared/composition.cjs',
};

function sharedModules() {
  const directory = fileURLToPath(new URL('.', appPath));
  const dependencies = new Map();
  return {
    name: 'epi-shared-modules',
    resolveId(id) {
      if (Object.hasOwn(modules, id)) return '\0' + id;
    },
    async load(id) {
      if (!id.startsWith('\0virtual:epi-')) return;
      const result = await build({
        entryPoints: [fileURLToPath(new URL(modules[id.slice(1)], appPath))],
        absWorkingDir: directory,
        bundle: true,
        metafile: true,
        format: 'esm',
        platform: 'browser',
        write: false,
      });
      const files = Object.keys(result.metafile.inputs).map(path => resolve(directory, path));
      dependencies.set(id, files);
      for (const file of files) this.addWatchFile(file);
      return result.outputFiles[0].text;
    },
    handleHotUpdate({ file, server }) {
      const updated = [...dependencies].filter(([, files]) => files.includes(resolve(file)));
      if (!updated.length) return;
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
      const domain = require('./domain/session.cjs');
      const storage = require('../shared/data-directory.cjs');
      const transactions = require('../shared/transactions.cjs');
      let sessionApi;
      // Let Vite listen and open the browser before reading the data directory.
      server.middlewares.use('/api/session', async (request, response, next) => {
        sessionApi ??= createSessionApi({ root, domain, storage, transactions }).catch(error => {
          sessionApi = undefined;
          throw error;
        });
        try {
          const { handleAction } = await sessionApi;
          await handleAction(request, response);
        } catch (error) {
          if (response.headersSent) return next(error);
          server.config.logger.error(error.stack ?? String(error));
          json(response, 500, { error: error.message });
        }
      });
    },
  };
}

async function accountApi(command, mode, isPreview) {
  const configured = loadEnv(mode, process.cwd(), 'VITE_EPI_').VITE_EPI_ACCOUNT_API;
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('VITE_EPI_ACCOUNT_API must be an HTTPS origin');
    }
    return url.origin;
  }
  if (command !== 'serve' || isPreview) return 'https://domun.eu';
  const { default: config } = await import(new URL('../server/config.js', appPath).href);
  return 'http://127.0.0.1:' + config.port;
}

export default defineConfig(async ({ command, mode, isPreview }) => ({
  define: { __DEV_ACCOUNT_API__: JSON.stringify(await accountApi(command, mode, isPreview)) },
  clearScreen: false,
  optimizeDeps: { entries: ['index.html'] },
  plugins: [sharedModules(), ...(command === 'serve' && mode === 'web' ? [webSessionApi()] : [])],
  server: {
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: mode === 'web' ? 1421 : 1420,
    strictPort: mode !== 'web',
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL('..', appPath))] },
  },
  build: { target: ['chrome105', 'safari15'] },
}));
