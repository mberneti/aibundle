/**
 * Shared test helpers.
 *
 * Tests run against the *compiled* output (`dist/`), so what is tested is
 * exactly what ships. Every fixture is a real file tree in a temp directory, so
 * the scanner and the filesystem helpers are exercised for real.
 *
 * @module test/helpers
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A temporary project tree, cleaned up by the caller. */
export interface TempProject {
  root: string;
  cleanup(): Promise<void>;
}

/** Create a directory with `files` written into it. */
export async function makeProject(files: Record<string, string>): Promise<TempProject> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aipack-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }
  return {
    root,
    async cleanup(): Promise<void> {
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

/** A small React + TypeScript project used across the e2e tests. */
export const REACT_TS_PROJECT: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'demo-app',
      version: '1.0.0',
      scripts: { dev: 'vite', test: 'vitest' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', zustand: '^4.5.4' },
      devDependencies: { typescript: '^5.6.0', vite: '^5.4.0', vitest: '^2.0.0' },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, jsx: 'react-jsx' } }, null, 2),
  'README.md': '# Demo app\n\nA tiny React + TypeScript app.\n',
  '.gitignore': 'node_modules\ndist\n',
  '.env.example': 'API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz0123456789\nSAFE=process.env.OTHER\n',
  'src/main.tsx': "import React from 'react';\nimport { App } from './App';\n\nexport function main() {\n  return React.createElement(App);\n}\n",
  'src/App.tsx': "import { useStore } from './store';\n\n/** Root component. */\nexport function App() {\n  // TODO: add routing\n  const count = useStore((state) => state.count);\n  return count;\n}\n",
  'src/store.ts': "import { create } from 'zustand';\n\ninterface State {\n  count: number;\n  increment: () => void;\n}\n\n/** Global store. */\nexport const useStore = create<State>((set) => ({\n  count: 0,\n  increment: () => set((state) => ({ count: state.count + 1 })),\n}));\n",
  'src/styles.css': ':root { --brand: #333; }\n',
  'src/__tests__/App.test.tsx': "import { describe, it } from 'vitest';\n\ndescribe('App', () => {\n  it('renders', () => {});\n});\n",
  'node_modules/should-not-appear/index.js': 'throw new Error("never scanned");\n',
  'dist/should-not-appear.js': 'throw new Error("never scanned");\n',
};

/** Files that every fixture shares, so assertions can rely on them. */
export const EXPECTED_FILES: readonly string[] = [
  'package.json',
  'src/App.tsx',
  'src/main.tsx',
  'src/store.ts',
  'README.md',
];
