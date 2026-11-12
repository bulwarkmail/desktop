// What the installers take back at an uninstall: the MSI through the app's own cleanup, the
// NSIS uninstaller by itself. No Electron and no registry here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { MSI_MARKER_FILE } from '../src/main/features/os-rules';
import type { NativeFilesModule } from '../src/main/native-loader';
import { asksForUninstallCleanup, uninstallCleanup } from '../src/main/uninstall-cleanup';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

test.describe('the uninstall cleanup switch', () => {
  test('is read before a bare -- only, where a file of that name could come', () => {
    expect(asksForUninstallCleanup(['Bulwark.exe', '--uninstall-cleanup'])).toBe(true);
    expect(asksForUninstallCleanup(['Bulwark.exe', '--', '--uninstall-cleanup'])).toBe(false);
    expect(asksForUninstallCleanup(['Bulwark.exe', 'mailto:a@example.org'])).toBe(false);
  });
});

test.describe('the MSI project', () => {
  const { buildProject } = require('../scripts/msi-project.cjs') as { buildProject: (project: string) => string };
  const project = [
    '<Wix><Product Id="*">',
    '<Directory Id="TARGETDIR" Name="SourceDir"><Directory Id="ProgramFiles64Folder"><Directory Id="APPLICATIONFOLDER" Name="Bulwark"/></Directory></Directory>',
    '<Feature Id="ProductFeature" Absent="disallow">\n<ComponentGroupRef Id="ProductComponents"/></Feature>',
    '<ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER"><Component><File Name="Bulwark.exe" Source="x" ReadOnly="yes" KeyPath="yes" Id="mainExecutable"/></Component></ComponentGroup>',
    '  </Product></Wix>',
  ].join('\n');

  test('runs the app\'s cleanup as the user at a real uninstall, before the files go, never at an upgrade', () => {
    const out = buildProject(project);
    const action = /<CustomAction Id="BwUninstallCleanup"[^>]*\/>/.exec(out)?.[0] ?? '';
    expect(action).toContain('FileKey="mainExecutable"');
    expect(action).toContain('ExeCommand="--uninstall-cleanup"');
    expect(action).toContain('Execute="deferred"');
    expect(action).toContain('Impersonate="yes"');
    expect(action).toContain('Return="ignore"');
    expect(out).toContain('<Custom Action="BwUninstallCleanup" Before="RemoveFiles"><![CDATA[REMOVE~="ALL" AND NOT UPGRADINGPRODUCTCODE]]></Custom>');
  });

  test('marks the folder as installed, and takes the mark away again', () => {
    const out = buildProject(project);
    expect(out).toContain('<ComponentRef Id="BwInstallMarker"/>');
    // WiX refuses a component without an explicit key path: the folder is it.
    expect(out).toMatch(/<Component Id="BwInstallMarker" [^>]*KeyPath="yes">\s*<CreateFolder\/>/);
    expect(out).toMatch(new RegExp(`<IniFile [^>]*Directory="APPLICATIONFOLDER" Name="${MSI_MARKER_FILE.replace('.', '\\.')}"`));
    expect(out).toContain(`<RemoveFile Id="BwInstallMarkerFile" Name="${MSI_MARKER_FILE}" On="uninstall"/>`);
  });

  test('keeps the policy switches', () => {
    expect(buildProject(project)).toContain('<Property Id="BW_PREV_FORCED_URL">');
  });

  test('electron-builder runs it', () => {
    expect(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')).toMatch(/^msiProjectCreated: scripts\/msi-project\.cjs\r?$/m);
  });
});

test.describe('the NSIS uninstaller', () => {
  const nsis = readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');

  test('takes the app\'s empty folders under LOCALAPPDATA, and never their contents', () => {
    const removed = [...nsis.matchAll(/^\s*RMDir (\/r )?"\$LOCALAPPDATA\\Bulwark([^"]*)"/gm)].map((match) => `${match[1] ? 'all ' : ''}${match[2] || '\\'}`);
    expect(removed).toEqual(['all \\os-files', '\\edit-files', '\\files-sync\\state', '\\files-sync', '\\']);
  });

  test("runs the app's own cleanup, which takes the Files drive, at a real uninstall and before the files go, never at an update", () => {
    const realUninstall = /\$\{ifNot\} \$\{isUpdated\}([\s\S]*?)\$\{endIf\}\s*; electron-builder removes the files right after this\./.exec(nsis)?.[1] ?? '';
    expect(realUninstall).toContain(`ExecWait '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" --uninstall-cleanup'`);
    expect(nsis.match(/--uninstall-cleanup/g)).toHaveLength(1);
  });
});

test.describe('the Files drive at an uninstall', () => {
  test('with no helper, or one that fails at every call, the rest of the cleanup still runs and no file that wasn\'t copied out goes', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'bw-uninstall-drive-'));
    try {
      const base = path.join(work, 'Bulwark Files');
      mkdirSync(path.join(base, 'a@example.org'), { recursive: true });
      writeFileSync(path.join(base, 'a@example.org', 'draft.txt'), 'not uploaded');
      const places = { profile: work, provider: 'Bulwark Test Unit', base, documents: path.join(work, 'Documents'), stored: { accounts: { a: { label: 'a@example.org', folder: 'a@example.org', rootId: 'r', createdAt: 1 } } }, supported: true, version: '1' };
      const fails = () => {
        throw new Error('the helper fails');
      };
      const broken = { filesDriveRoots: async () => fails(), filesDriveConnect: fails, filesDriveDisconnect: fails, filesDriveUnregister: async () => fails(), filesDriveInfo: fails } as unknown as NativeFilesModule;
      for (const helper of [null, broken]) {
        const local = path.join(work, 'Local');
        mkdirSync(path.join(local, 'Bulwark', 'os-files', 'drop'), { recursive: true });
        await uninstallCleanup({ root: 'HKCU\\Software\\BulwarkTest\\never-read', exe: 'C:\\x\\Bulwark.exe', sendTo: null, local }, null, { helper, places });
        expect(existsSync(path.join(local, 'Bulwark')), "the app's local folders still went").toBe(false);
        expect(readFileSync(path.join(base, 'a@example.org', 'draft.txt'), 'utf8'), 'a file that could not be copied out stays').toBe('not uploaded');
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
