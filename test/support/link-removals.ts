// The app's removals, run on a tree of links that test/remove-tree-unit.spec.ts plants: once in
// the test runner's Node, once bundled into Electron's own Node (ELECTRON_RUN_AS_NODE), which is
// the one the app runs in. Each case answers 'ok' or the error's code.
import path from 'node:path';
import { removeOwn, removeTree } from '../../src/main/remove-tree';
import { removeFilesDrive } from '../../src/main/uninstall-cleanup';
import { removeAsideFolders, settlePendingRemovals } from '../../src/main/wipe-scope';

async function outcome(run: () => unknown): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? String(error);
  }
}

export async function runRemovals(work: string): Promise<Record<string, string>> {
  const at = (...parts: string[]) => path.join(work, 'app', ...parts);
  // A helper with no sync roots: only the folders matter here.
  const helper = { filesDriveRoots: async () => [], filesDriveConnect: () => 'c', filesDriveDisconnect: () => {}, filesDriveUnregister: async () => {}, filesDriveInfo: () => { throw new Error('files:missing'); } };
  return {
    tree: await outcome(() => removeTree(at('tree'))),
    treeAtLink: await outcome(() => removeTree(at('tree-at-link'))),
    ownAtLink: await outcome(() => removeOwn(at('own-at-link'))),
    treeThroughLink: await outcome(() => removeTree(at('via', 'inside'), { root: at() })),
    partitions: await outcome(() => {
      const { left, aside } = settlePendingRemovals(at('profile'), [
        { partition: 'persist:instance-inner' },
        { partition: 'persist:instance-innerk', keepLocalStorage: true },
        { partition: 'persist:instance-top' },
        { partition: 'persist:instance-topk', keepLocalStorage: true },
      ]);
      if (left.length > 0) throw Object.assign(new Error('left'), { code: `left ${left.length}` });
      const stays = removeAsideFolders(at('profile'), aside);
      if (stays.length > 0) throw Object.assign(new Error('aside'), { code: `aside left ${stays.length}` });
    }),
    drive: await outcome(() => removeFilesDrive(helper as never, {
      profile: at('profile'),
      provider: 'Bulwark Test Unit',
      base: at('Bulwark Files'),
      documents: at('Documents'),
      stored: { accounts: { a: { label: 'me@example.org', folder: 'me@example.org', rootId: 'r', createdAt: 1 } } },
      supported: true,
      version: '1',
    })),
  };
}
