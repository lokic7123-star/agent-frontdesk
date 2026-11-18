import os from 'node:os';
import path from 'node:path';
import { appPlaces, firstExisting } from '../services/app-assets.js';
import type { PluginAbout, PluginSetup } from '../../shared/contract.js';
// A template for the ZCode desktop app (Electron, D:\Zcode or %LOCALAPPDATA%\Programs\Zcode),
// prepared for the phase-2 integration. This file lives in src/server/templates/ on purpose:
// the plugin host only loads src/server/plugins/*.plugin.ts, so the template is typechecked
// but never discovered until it is copied into plugins/ with a real bridge. Everything an integration needs is in
// docs/zcode-integration.md (the app's local record, the channels it may speak, the steps);
// src/shared/contract.ts stays the single contract. Nothing here drives the app yet: setup
// says so plainly instead of registering an engine that cannot deliver.
const IDENTITY = { id: 'zcode', label: 'ZCode', description: 'ZCode desktop', priority: 50, accent: '#10B981' } as const;
// Hidden until someone asks for it (BRIDGE_ZCODE_PREVIEW=1): a template with no engine behind
// it would otherwise sit in the rail looking available.
const preview = (): boolean => process.env.BRIDGE_ZCODE_PREVIEW === '1';
const WINDOWS_ASAR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Zcode', 'resources', 'app.asar');
const DATA_HOME = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.zcode');
export const about: PluginAbout = { ...IDENTITY,
  detect: config => preview() ? firstExisting([
    ...appPlaces(config.zcodeAppAsar || WINDOWS_ASAR),
    config.zcodeHome || DATA_HOME,
  ]) : { installed: false } };
// Phase 2 fills this in: a bridge reading the app's own record and speaking its channel
// (docs/zcode-integration.md, "通道裁决"), registered through registerEngine exactly as
// plugins/antigravity.plugin.ts does.
export const setup: PluginSetup = () => {
  throw new Error('ZCode 的接入还在二期：通道与读取方案见 docs/zcode-integration.md，把这里换成真正的 bridge');
};
