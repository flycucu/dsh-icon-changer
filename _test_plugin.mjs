/**
 * _test_plugin.mjs - self test for the host half of dsh-icon-changer.
 *
 * Why it is run through a renamed copy of node.exe: resolveExe() only accepts a
 * process whose own image ends in "DeepSeek Harness.exe". Pointing that at a copy
 * lets the whole /apply path be exercised against a throw-away executable instead
 * of the real app image.
 *
 *   $t = "$env:TEMP\ic-test"; New-Item -ItemType Directory -Force $t
 *   Copy-Item (Get-Command node).Source "$t\DeepSeek Harness.exe"
 *   $env:DSH_HOME = "$t\home"
 *   & "$t\DeepSeek Harness.exe" _test_plugin.mjs
 *
 * It POSTs /apply with restart:false. Never use restart:true here: that path runs
 * taskkill on every "DeepSeek Harness.exe", which would kill the real app.
 *
 * The worker outlives this process (that is the whole point of the WMI launch), so
 * the rewrite lands a moment after this script exits. Read
 * $DSH_HOME/icon-changer/helper.log afterwards to see the outcome.
 *
 * Phase 2, run a few seconds later against the SAME DSH_HOME, proves the host can
 * read back what the worker wrote:
 *
 *   & "$t\DeepSeek Harness.exe" _test_plugin.mjs --status-only
 *
 * That is the regression guard for the state file being written with a UTF-8 BOM:
 * JSON.parse then fails, readState() swallows it, and the settings card silently
 * shows "no last result" forever.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { apply } from './lib/index.js';

const statusOnly = process.argv.includes('--status-only');

// The worker now leaves pendingExplorer=true behind so the next host boot refreshes
// the shell icon cache by restarting Explorer - correct in production, rude in a
// test, so clear it before booting the host here.
if (statusOnly) {
    const stateFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'icon-changer', 'state.json');
    if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
        if (state.pendingExplorer) {
            state.pendingExplorer = null;
            writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
            console.log('[test] cleared pendingExplorer so this test does not bounce the real Explorer');
        }
    }
}

const routes = [];
const ctx = {
    effect(fn) {
        const dispose = fn();
        return () => { try { dispose?.(); } catch { /* ignore */ } };
    },
    webServer: {
        register(route) {
            routes.push(route);
            return () => { /* ignore */ };
        },
    },
    logger: { info: (message) => console.log('[plugin]', message) },
};

apply(ctx);
console.log('[test] routes:', routes.map((r) => `${r.kind} ${r.path}`).join(' | '));

// --boot-only: just let apply(ctx) do its startup reconciliation and exit. Used to
// verify that a queued job whose worker died gets picked up again (see
// reconcileStalledPending in lib/index.js).
if (process.argv.includes('--boot-only')) {
    console.log('[test] boot-only: startup reconciliation done, nothing was touched by hand');
    process.exit(0);
}

const api = routes.find((r) => r.path === '/api/icon-changer');
if (!api) {
    console.error('[test] FAIL: /api/icon-changer route was not registered');
    process.exit(2);
}

async function request(method, path, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = { method, url: path, headers: { host: '127.0.0.1:1' } };
    req[Symbol.asyncIterator] = async function* iterate() { yield body; };
    const res = {
        status: 0,
        body: '',
        writeHead(status) { this.status = status; },
        end(chunk) { this.body = String(chunk ?? ''); },
    };
    await api.handler(req, res);
    return res;
}

const status = await request('GET', '/api/icon-changer/status', {});
console.log('[test] GET /status ->', status.status, status.body.slice(0, 200));

if (statusOnly) {
    const seen = JSON.parse(status.body || '{}');
    const ok = Boolean(
        seen.lastResult && seen.lastResult.ok
        && seen.applied && seen.applied.hash
        // the settings card preselects the icon the app is actually wearing
        && seen.appliedId === 'builtin:whalemaid.ico'
        // bundled icons carry human labels: original.ico must read 原版, not "original"
        && (seen.icons || []).some((i) => i.id === 'builtin:original.ico' && i.label === '原版')
    );
    console.log('[test] lastResult =', JSON.stringify(seen.lastResult));
    console.log('[test] applied    =', JSON.stringify(seen.applied));
    console.log('[test] appliedId  =', JSON.stringify(seen.appliedId));
    console.log('[test] labels     =', (seen.icons || []).map((i) => `${i.id}=${i.label}`).join(' | '));
    if (!ok) {
        console.error('[test] FAIL: state read back / appliedId / icon labels are wrong');
        process.exit(4);
    }
    console.log('[test] PASS: host reads back the worker state, appliedId resolves to the applied icon.');
    process.exit(0);
}

const applied = await request('POST', '/api/icon-changer/apply', {
    icon: 'builtin:whalemaid.ico',
    restart: false,
    targets: ['exe'],
});
console.log('[test] POST /apply (restart:false) ->', applied.status, applied.body);

const parsed = JSON.parse(applied.body || '{}');
if (!parsed.workerOk) {
    console.error('[test] FAIL: the host could not start the detached worker');
    process.exit(3);
}
console.log('[test] worker accepted the job; it finishes after this process exits.');
