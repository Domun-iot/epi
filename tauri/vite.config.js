import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const appPath = import.meta.url;
const modules = {
  'virtual:epi-session': './domain/session.cjs',
  'virtual:epi-composition': '../shared/composition.cjs',
};

function sharedModules() {
  return {
    name: 'epi-shared-modules',
    resolveId(id) {
      if (Object.hasOwn(modules, id)) return '\0' + id;
    },
    async load(id) {
      if (!id.startsWith('\0virtual:epi-')) return;
      const result = await build({
        entryPoints: [fileURLToPath(new URL(modules[id.slice(1)], appPath))],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        write: false,
      });
      return result.outputFiles[0].text;
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [sharedModules()],
  server: {
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: 1420,
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL('..', appPath))] },
  },
  build: { target: ['chrome105', 'safari15'] },
});
