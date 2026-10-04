/**
 * dsh-icon-changer — host half.
 *
 * Replaces the DeepSeek Harness desktop app icon by rewriting the RT_GROUP_ICON /
 * RT_ICON resources inside its own .exe.
 *
 * Three icon targets exist on Windows and they are NOT the same file:
 *   exe        the PE resources inside "DeepSeek Harness.exe"   (file icon, taskbar)
 *   tray       <appdir>\resources\tray.ico                      (notification area)
 *   startmenu  the Start Menu shortcut's IconLocation           (Start Menu / search)
 *
 * Why an external worker is involved: Windows keeps a running executable locked,
 * and this plugin *is* that executable. A helper spawned straight from here does
 * NOT survive the app exiting - it is taken down with the app's job object, which
 * used to leave an empty helper.log and a stuck "pending". So the job is written
 * to pending-job.json and created through WMI instead (bin/wmi-spawn.ps1): a child
 * of wmiprvse.exe is not in our job object, so bin/run-worker.ps1 -> apply-icon.ps1
 * lives long enough to rewrite the exe and relaunch the app.
 *
 * Routes (all served through ctx.webServer, prefix "/api/icon-changer"):
 *   GET    /status                 app/exe/backup/pending summary + per-target state
 *   GET    /icons                  uploaded icon list
 *   GET    /log?lines=200          tail of helper.log (host + spawner + worker)
 *   GET    /preview/<file>         one icon, for <img> previews
 *   POST   /upload   {name,b64}    store an uploaded .ico (validated)
 *   DELETE /icon/<id>              drop one uploaded icon (not one that is in use)
 *   POST   /apply    {icon,restart,targets}
 *   POST   /restore  {restart,targets}
 *   POST   /clear                  drop a queued job that never landed
 *   GET    /icon-changer           the management page
 *
 * Note on trust: these routes are served on 127.0.0.1 without the Web GUI's token,
 * so any local process can call them (a browser page cannot: sameOrigin() rejects a
 * cross-origin Origin header). Treat them as "same user, same machine".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
         statSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const name = 'dsh-icon-changer';
const inject = ['webServer'];

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DATA_DIR = join(DSH_HOME, 'icon-changer');
const ICON_DIR = join(DATA_DIR, 'icons');
const BACKUP_DIR = join(DATA_DIR, 'backup');
const STABLE_ICON = join(DATA_DIR, 'current.ico');
const STATE_FILE = join(DATA_DIR, 'state.json');
const LOG_FILE = join(DATA_DIR, 'helper.log');
const UI_HTML = join(PKG_ROOT, 'lib', 'ui.html');
const HELPER = join(PKG_ROOT, 'bin', 'apply-icon.ps1');
const RUN_WORKER = join(PKG_ROOT, 'bin', 'run-worker.ps1');
const WMI_SPAWN = join(PKG_ROOT, 'bin', 'wmi-spawn.ps1');
const REFRESH_SHELL = join(PKG_ROOT, 'bin', 'refresh-shell.ps1');
const RCEDIT = join(PKG_ROOT, 'tools', 'rcedit-x64.exe');
const BUNDLED_ICONS = join(PKG_ROOT, 'assets');
const JOB_FILE = join(DATA_DIR, 'pending-job.json');
const CMD_FILE = join(DATA_DIR, 'pending-job.cmdline');
const SPAWN_RESULT = join(DATA_DIR, 'spawn-result.json');
const REFRESH_CMD = join(DATA_DIR, 'refresh-shell.cmdline');
const REFRESH_RESULT = join(DATA_DIR, 'refresh-shell.spawn.json');
/** Absolute path: the app's own PATH is not something to bet the worker on. */
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32',
                        'WindowsPowerShell', 'v1.0', 'powershell.exe');
const MAX_UPLOAD = 4 * 1024 * 1024;      // 4 MiB is plenty for an .ico
const PENDING_STALE_MS = 20 * 1000;      // a queued job older than this never ran
const APPLY_WAIT_S = 900;                // /apply: the app is killed right away
const RECONCILE_WAIT_S = 6 * 3600;       // startup retry: wait for the next real quit
const KNOWN_TARGETS = ['exe', 'tray', 'startmenu'];

// --------------------------------------------------------------------------- #
// helpers
// --------------------------------------------------------------------------- #
function ensureDirs() {
    for (const dir of [DATA_DIR, ICON_DIR, BACKUP_DIR]) {
        try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
}

function readState() {
    try {
        // Strip a BOM: a state file written by Windows PowerShell 5.1 carries one,
        // and JSON.parse rejects it, which used to leave the plugin believing there
        // is no state at all (an invisible queue and an empty "last result").
        const raw = readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw);
    } catch { return {}; }
}

function writeState(patch) {
    const next = { ...readState(), ...patch };
    try { writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8'); } catch { /* ignore */ }
    return next;
}

/** The desktop app's own executable, or null when running under plain node. */
function resolveExe() {
    const exe = process.execPath || '';
    return /DeepSeek Harness\.exe$/i.test(exe) ? exe : null;
}

function writeJson(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
    });
    res.end(JSON.stringify(body));
}

function sameOrigin(req) {
    const origin = req.headers?.origin;
    if (!origin) return true;                       // same-origin fetches may omit it
    try {
        const host = req.headers.host;
        return new URL(origin).host === host;
    } catch { return false; }
}

async function readBody(req, maxBytes = MAX_UPLOAD) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(); return null; }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function readJson(req, maxBytes = 64 * 1024) {
    const raw = await readBody(req, maxBytes);
    if (!raw) return null;
    try { return JSON.parse(raw.toString('utf8')); } catch { return null; }
}

/** An .ico starts with ICONDIR: reserved=0, type=1, count>0. */
function isIco(buf) {
    if (!buf || buf.length < 22) return false;
    return buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1
        && buf.readUInt16LE(4) > 0;
}

/** Parse ICONDIR enough to describe the frames (used for the tray warning). */
function icoFrames(buf) {
    try {
        const count = buf.readUInt16LE(4);
        const frames = [];
        for (let i = 0; i < count; i += 1) {
            const off = 6 + i * 16;
            if (off + 16 > buf.length) break;
            const w = buf[off] || 256;
            const h = buf[off + 1] || 256;
            const bytes = buf.readUInt32LE(off + 8);
            const dataOff = buf.readUInt32LE(off + 12);
            const head = buf.subarray(dataOff, dataOff + 8);
            const isPng = head.length === 8
                && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
            frames.push({ width: w, height: h, bytes, png: isPng });
        }
        return frames;
    } catch { return []; }
}

function safeIconName(raw) {
    const base = basename(String(raw || 'icon.ico')).replace(/[^\w.\-]+/g, '_');
    return base.toLowerCase().endsWith('.ico') ? base : `${base}.ico`;
}

/** Human labels for the bundled icons; anything else falls back to its file name. */
const BUNDLED_LABELS = {
    'whalemaid.ico': '鲸鱼娘（预置）',
    'original.ico': '原版',
};

function iconFiles() {
    const out = [];
    try {
        for (const entry of readdirSync(BUNDLED_ICONS)) {
            if (!entry.toLowerCase().endsWith('.ico')) continue;
            if (entry.toLowerCase().endsWith('-tray.ico')) continue;
            out.push({ id: `builtin:${entry}`, name: entry, kind: 'builtin', builtin: true,
                       label: BUNDLED_LABELS[entry.toLowerCase()] || entry.replace(/\.ico$/i, ''),
                       trayVariant: existsSync(join(BUNDLED_ICONS, entry.replace(/\.ico$/i, '') + '-tray.ico')),
                       size: statSync(join(BUNDLED_ICONS, entry)).size });
        }
    } catch { /* no bundled icons */ }
    try {
        for (const entry of readdirSync(ICON_DIR)) {
            if (!entry.toLowerCase().endsWith('.ico')) continue;
            if (entry.toLowerCase().endsWith('-tray.ico')) continue;
            out.push({ id: `user:${entry}`, name: entry, kind: 'user', builtin: false,
                       label: entry.replace(/\.ico$/i, ''),
                       trayVariant: existsSync(join(ICON_DIR, entry.replace(/\.ico$/i, '') + '-tray.ico')),
                       size: statSync(join(ICON_DIR, entry)).size,
                       mtime: statSync(join(ICON_DIR, entry)).mtimeMs });
        }
    } catch { /* nothing uploaded yet */ }
    return out;
}

/**
 * Pick the artifact for the tray target. The tray wants a small, PNG-compressed
 * icon: a 256x256 uncompressed BMP frame makes Windows fail to draw the icon at
 * all. Uploaded icons may ship a "<name>-tray.ico" companion next to them.
 */
function trayArtifact(id) {
    const p = iconPathFor(id);
    if (!p) return null;
    const variant = p.replace(/\.ico$/i, '-tray.ico');
    return existsSync(variant) ? variant : p;
}

function iconPathFor(id) {
    const raw = String(id || '');
    if (raw.startsWith('orig:')) {
        const p = join(BUNDLED_ICONS, safeIconName(raw.slice(5)));
        return existsSync(p) ? p : null;
    }
    if (raw.startsWith('builtin:')) {
        const p = join(BUNDLED_ICONS, safeIconName(raw.slice(8)));
        return existsSync(p) ? p : null;
    }
    if (raw.startsWith('user:')) {
        const p = join(ICON_DIR, safeIconName(raw.slice(5)));
        return existsSync(p) ? p : null;
    }
    return null;
}

function logTail(lines = 60) {
    try {
        // strip the BOM: the log is created by PowerShell's Add-Content -Encoding
        // UTF8, and a stray U+FEFF would show up as the first character of line 1.
        const text = readFileSync(LOG_FILE, 'utf8').replace(/^\uFEFF/, '');
        return text.split(/\r?\n/).slice(-lines).join('\n');
    } catch { return ''; }
}

function fileInfo(path) {
    try {
        const st = statSync(path);
        return { path, size: st.size, mtime: st.mtimeMs };
    } catch { return null; }
}

function shortcutPaths() {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const candidates = [
        join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk'),
    ];
    return candidates;
}

/** Normalize whatever the caller sent into a clean target list. */
function normalizeTargets(raw) {
    if (raw === undefined || raw === null) return [...KNOWN_TARGETS];
    const list = Array.isArray(raw) ? raw : [raw];
    const seen = [];
    for (const item of list) {
        const key = String(item || '').toLowerCase();
        if (KNOWN_TARGETS.includes(key) && !seen.includes(key)) seen.push(key);
    }
    return seen.length ? seen : [...KNOWN_TARGETS];
}

function pendingIsStale(state) {
    const queued = state?.pending?.queuedAt;
    if (!queued) return false;
    const at = Date.parse(queued);
    if (Number.isNaN(at)) return false;
    return Date.now() - at > PENDING_STALE_MS;
}

// --------------------------------------------------------------------------- #
// external finisher launcher
// --------------------------------------------------------------------------- #
/**
 * Write the standalone .cmd + a copy of the external script into the data dir.
 * The .cmd is what the user double-clicks when the in-app worker cannot survive.
 * Returns { ok, path } - never throws.
 */
/**
 * Apply the targets that do NOT need the app to exit: tray.ico and the Start Menu
 * shortcut. Runs a short PowerShell helper so the same COM calls are used as the
 * exe worker, and returns a per-target report. Never throws.
 */
/** Ask Windows to close the app a moment after we answer, so the reply lands first. */
/** Close the app so the exe can be rewritten; PowerShell does the killing. */
/** Close the app so the next start can rewrite the exe. */
function scheduleProcessExit() {
    try {
        const child = spawn('taskkill',
            ['/F', '/IM', 'DeepSeek Harness.exe', '/T'],
            { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return true;
    } catch (error) {
        return { error: String(error?.message || error) };
    }
}

function hotApply(op, icons, targets) {
    if (!targets || !targets.includes('startmenu') && !targets.includes('tray')) return [];
    const exe = resolveExe();
    if (!exe) return [];
    const trayIcon = icons?.tray || '';
    const icon = icons?.exe || icons?.tray || '';
    const script = [
        "$ErrorActionPreference = 'Continue'",
        '$exe = ' + JSON.stringify(exe),
        '$tray = ' + JSON.stringify(join(dirname(exe), 'resources', 'tray.ico')),
        '$trayIcon = ' + JSON.stringify(trayIcon),
        '$icon = ' + JSON.stringify(icon),
        '$op = ' + JSON.stringify(op),
        '$wantTray = ' + (targets.includes('tray') ? '$true' : '$false'),
        '$wantMenu = ' + (targets.includes('startmenu') ? '$true' : '$false'),
        '$stable = ' + JSON.stringify(join(DATA_DIR, 'current.ico')),
        '$shortcutOrig = ' + JSON.stringify(join(DATA_DIR, 'shortcut.orig')),
        "$link = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\DeepSeek Harness.lnk'",
        '$out = @()',
        'if ($wantTray -and $op -eq ' + JSON.stringify('apply') + ' -and (Test-Path -LiteralPath $tray)) {',
        "  $bak = \"$tray.orig\"",
        '  if (-not (Test-Path -LiteralPath $bak)) { Copy-Item -LiteralPath $tray -Destination $bak -Force }',
        '  if ($trayIcon -and (Test-Path -LiteralPath $trayIcon)) {',
        "    Copy-Item -LiteralPath $trayIcon -Destination $tray -Force",
        "    $out += 'tray: 已写入（重启应用后显示）'",
        "  } else { $out += 'tray: 未找到可用图标' }",
        '}',
        'if ($wantTray -and $op -eq ' + JSON.stringify('restore') + ') {',
        "  $bak = \"$tray.orig\"",
        "  if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination $tray -Force; $out += 'tray: 已回退' }",
        "  else { $out += 'tray: 没有备份可回退' }",
        '}',
        'if ($wantMenu) {',
        '  if (Test-Path -LiteralPath $link) {',
        '    $shell = New-Object -ComObject WScript.Shell',
        '    $lnk = $shell.CreateShortcut($link)',
        '    if ($op -eq ' + JSON.stringify('apply') + ') {',
        '      if ($icon -and (Test-Path -LiteralPath $icon)) {',
        '        Copy-Item -LiteralPath $icon -Destination $stable -Force',
        '        $cur = [string]$lnk.IconLocation',
        '        if (-not (Test-Path -LiteralPath $shortcutOrig)) { [System.IO.File]::WriteAllText($shortcutOrig, $cur, (New-Object System.Text.UTF8Encoding($false))) }',
        '        $lnk.IconLocation = "$stable,0"',
        '        $lnk.Save()',
        "        $out += 'startmenu: 已刷新'",
        "      } else { $out += 'startmenu: 未找到可用图标' }",
        '    } else {',
        '      if (Test-Path -LiteralPath $shortcutOrig) {',
        '        $orig = ((Get-Content -LiteralPath $shortcutOrig -Raw -Encoding UTF8) -replace ("^" + [char]0xFEFF), "").Trim()',
        '        $lnk.IconLocation = $orig',
        '        $lnk.Save()',
        "        $out += 'startmenu: 已回退'",
        "      } else { $out += 'startmenu: 没有备份可回退' }",
        '    }',
        '  } else {',
        "    $out += 'startmenu: 未找到快捷方式'",
        '  }',
        '}',
        "if (Test-Path 'C:\\Windows\\System32\\ie4uinit.exe') { & 'C:\\Windows\\System32\\ie4uinit.exe' -show 2>$null | Out-Null }",
        '$out -join " | "',
    ].join('\r\n');
    try {
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
            encoding: 'utf8', windowsHide: true, timeout: 30000,
        });
        const text = String(r.stdout || '').trim();
        if (!text) return [{ target: 'hot', ok: false, message: String(r.stderr || 'no output').slice(0, 200) }];
        return text.split('|').map((s) => s.trim()).filter(Boolean).map((s) => {
            const idx = s.indexOf(':');
            return { target: idx > 0 ? s.slice(0, idx).trim() : 'hot', ok: !/未找到|没有|失败/.test(s), message: s };
        });
    } catch (error) {
        return [{ target: 'hot', ok: false, message: String(error?.message || error) }];
    }
}

/** Append a host-side line to the worker log, so every failure lands in one file. */
function hostLog(message) {
    try {
        appendFileSync(LOG_FILE,
            `[${new Date().toISOString()}] [host] ${message}\n`, 'utf8');
    } catch { /* logging must never break a request */ }
}

/** Quote one argument for a Windows command line. Our paths never contain ". */
function quoteArg(value) {
    const text = String(value);
    return /[\s"]/.test(text) ? `"${text}"` : text;
}

/**
 * Start a helper process through WMI, so it is NOT part of the app's job object.
 *
 * Spawning powershell.exe straight from here does not survive the app exiting
 * (observed here: an empty helper.log and a pending that never cleared), while a
 * child of wmiprvse.exe does. The command line is written to a file first: that
 * keeps a long, quoted command line out of several layers of quoting.
 *
 * Returns { ok, pid?, unreadable?, detail? } and never throws.
 */
function spawnDetachedViaWmi(cmdlineFile, resultFile, commandLine, tag) {
    try {
        writeFileSync(cmdlineFile, commandLine, 'utf8');
        rmSync(resultFile, { force: true });         // never read a stale report
    } catch (error) {
        const detail = `could not write ${basename(cmdlineFile)}: ${error?.message || error}`;
        hostLog(`${tag}: ${detail}`);
        return { ok: false, detail };
    }

    const report = spawnSync(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', WMI_SPAWN,
        '-CommandFile', cmdlineFile,
        '-ResultFile', resultFile,
        '-Log', LOG_FILE,
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });

    // A BOM or a half-written report must not be mistaken for "nothing was created":
    // starting a second helper would race the first one.
    let created = null;
    let reportSeen = false;
    try {
        created = JSON.parse(readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''));
        reportSeen = true;
    } catch {
        reportSeen = existsSync(resultFile);
    }
    if (created?.ok) {
        hostLog(`${tag}: started through WMI (pid=${created.pid})`);
        return { ok: true, pid: created.pid };
    }
    if (!created && reportSeen) {
        hostLog(`${tag}: the WMI spawner left an unreadable report; assuming it was created`);
        return { ok: true, pid: null, unreadable: true };
    }
    const detail = created?.message
        || String(report?.stderr || report?.error?.message || '').trim()
        || 'no result reported';
    hostLog(`${tag}: WMI launch failed (${detail})`);
    return { ok: false, detail };
}

/**
 * Start the worker that rewrites the exe once the app has let go of it.
 *
 * Returns { ok, pid?, fallback?, error? } and never throws.
 */
function launchHelper(op, icons, restart, waitSeconds = RECONCILE_WAIT_S, hidden = false) {
    const exe = resolveExe();
    if (!exe) return { ok: false, error: 'not-desktop-app' };
    if (!existsSync(HELPER)) return { ok: false, error: 'helper-missing' };
    if (!existsSync(RUN_WORKER) || !existsSync(WMI_SPAWN)) return { ok: false, error: 'bootstrap-missing' };
    if (!existsSync(POWERSHELL)) return { ok: false, error: 'powershell-missing' };

    ensureDirs();
    const job = {
        op,
        exe,
        icon: icons?.exe || null,
        state: STATE_FILE,
        log: LOG_FILE,
        backupDir: BACKUP_DIR,
        rcedit: RCEDIT,
        restart: restart ? '1' : '0',
        waitSeconds,
        // Whoever wakes up first must be able to tell whether the queue it was
        // created for is still the current one (see the superseded check in
        // apply-icon.ps1): two waiters rewriting the same exe would be a coin toss.
        jobId: readState().pending?.queuedAt ?? null,
    };
    const workerArgs = ['-NoProfile', '-NonInteractive'];
    // -WindowStyle Hidden is what actually keeps the console window away (verified:
    // the child's MainWindowHandle is 0 with it and non-zero without). A job that
    // waits for the user to quit the app can sit there for hours, so those stay
    // hidden; a "change it now" job is meant to be seen.
    if (hidden) workerArgs.push('-WindowStyle', 'Hidden');
    workerArgs.push('-ExecutionPolicy', 'Bypass', '-File', RUN_WORKER, '-Job', JOB_FILE);
    try {
        writeFileSync(JOB_FILE, JSON.stringify(job, null, 2), 'utf8');
    } catch (error) {
        hostLog(`job file could not be written: ${error?.message || error}`);
        return { ok: false, error: 'job-write-failed' };
    }

    const created = spawnDetachedViaWmi(
        CMD_FILE,
        SPAWN_RESULT,
        [quoteArg(POWERSHELL), ...workerArgs.map(quoteArg)].join(' '),
        `worker op=${op} restart=${restart ? 1 : 0} wait=${waitSeconds}s`);
    if (created.ok) return { ok: true, pid: created.pid, unverified: created.unreadable };

    hostLog(`worker launch failed (${created.detail}); falling back to a direct detached spawn`);
    try {
        const child = spawn(POWERSHELL, workerArgs, {
            detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.on('error', (error) => hostLog(`detached spawn failed: ${error?.message || error}`));
        child.unref();
        return { ok: true, pid: child.pid, fallback: true };
    } catch (error) {
        hostLog(`detached spawn threw: ${error?.message || error}`);
        return { ok: false, error: String(error?.message || error) };
    }
}

// --------------------------------------------------------------------------- #
// request handling
// --------------------------------------------------------------------------- #
function targetStatus(exe) {
    const appDir = exe ? dirname(exe) : null;
    const trayPath = appDir ? join(appDir, 'resources', 'tray.ico') : null;
    const trayBackup = trayPath ? `${trayPath}.orig` : null;
    const shortcut = shortcutPaths().find((p) => existsSync(p)) || shortcutPaths()[0];
    return {
        exe: {
            id: 'exe',
            label: '应用 exe',
            path: exe,
            backup: existsSync(join(BACKUP_DIR, 'DeepSeek Harness.exe.orig'))
                ? join(BACKUP_DIR, 'DeepSeek Harness.exe.orig') : null,
            note: '文件图标 / 任务栏；改写 PE 资源，必须在应用退出后做',
        },
        tray: {
            id: 'tray',
            label: '托盘图标',
            path: trayPath,
            backup: trayBackup && existsSync(trayBackup) ? trayBackup : null,
            note: '通知区域；独立文件 resources\\tray.ico，重启应用后生效',
        },
        startmenu: {
            id: 'startmenu',
            label: '开始菜单',
            path: shortcut,
            backup: existsSync(join(DATA_DIR, 'shortcut.orig')) ? join(DATA_DIR, 'shortcut.orig') : null,
            note: '快捷方式 IconLocation；指向 <数据目录>\\current.ico',
        },
    };
}

/**
 * Map the icon that is actually applied (state.applied.icon is an absolute path)
 * back to the id the picker uses, so the settings card can stay on the icon the app
 * currently wears instead of resetting to the first one in the list.
 */
function appliedIconId(state) {
    const applied = state?.applied?.icon;
    if (!applied) return null;
    const name = basename(applied).toLowerCase();
    const dir = dirname(applied).toLowerCase();
    if (dir === BUNDLED_ICONS.toLowerCase()) return `builtin:${basename(applied)}`;
    if (dir === ICON_DIR.toLowerCase()) return `user:${basename(applied)}`;
    const match = iconFiles().find((icon) => String(icon.name).toLowerCase() === name);
    return match ? match.id : null;
}

function statusPayload() {
    const exe = resolveExe();
    const state = readState();
    const exeInfo = exe && existsSync(exe) ? fileInfo(exe) : null;
    const backup = join(BACKUP_DIR, 'DeepSeek Harness.exe.orig');
    const stale = pendingIsStale(state);
    return {
        ok: true,
        isDesktopApp: Boolean(exe),
        exe: exeInfo,
        backup: existsSync(backup) ? fileInfo(backup) : null,
        applied: state.applied ?? null,
        appliedId: appliedIconId(state),
        pending: state.pending ?? null,
        pendingStale: stale,
        lastResult: state.lastResult ?? null,
        icons: iconFiles(),
        targets: targetStatus(exe),
        stableIcon: existsSync(STABLE_ICON) ? STABLE_ICON : null,
        dataDir: DATA_DIR,
        helperLog: LOG_FILE,
    };
}

async function handleApi(req, res, url) {
    const route = url.pathname.replace(/^\/api\/icon-changer/, '') || '/';
    const method = req.method || 'GET';

    if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'cross-origin' });

    // ---- status ---------------------------------------------------------- #
    if (route === '/status' && method === 'GET') {
        return writeJson(res, 200, statusPayload());
    }

    // ---- uploaded / bundled icon list ------------------------------------ #
    if (route === '/icons' && method === 'GET') {
        return writeJson(res, 200, { ok: true, icons: iconFiles() });
    }

    // ---- worker log tail (the standalone page shows this) ---------------- #
    if (route === '/log' && method === 'GET') {
        // Careful: Number(null) is 0, not NaN, so "no lines= given" must be detected
        // on the string - otherwise the default below never applies and the log
        // panel gets exactly one (usually empty) trailing line.
        const asked = url.searchParams.get('lines');
        const parsed = asked === null || asked === '' ? NaN : Number(asked);
        const lines = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 2000) : 200;
        return writeJson(res, 200, { ok: true, log: logTail(lines) });
    }

    // ---- icon bytes (previews) ------------------------------------------- #
    if (route.startsWith('/preview/') && method === 'GET') {
        const id = decodeURIComponent(route.slice('/preview/'.length));
        const p = iconPathFor(id);
        if (!p) return writeJson(res, 404, { ok: false, error: 'not-found' });
        const buf = readFileSync(p);
        res.writeHead(200, {
            'content-type': 'image/x-icon',
            'content-length': buf.length,
            'cache-control': 'no-store',
        });
        return res.end(buf);
    }

    // ---- upload ---------------------------------------------------------- #
    if (route === '/upload' && method === 'POST') {
        // base64 inflates by 4/3 and the JSON wrapper adds a little more
        const body = await readJson(req, Math.ceil(MAX_UPLOAD * 1.4) + 8192);
        if (!body || !body.b64) return writeJson(res, 400, { ok: false, error: 'bad-body' });
        let buf;
        try { buf = Buffer.from(String(body.b64), 'base64'); }
        catch { return writeJson(res, 400, { ok: false, error: 'bad-base64' }); }
        if (buf.length > MAX_UPLOAD) return writeJson(res, 413, { ok: false, error: 'too-large' });
        if (!isIco(buf)) return writeJson(res, 400, { ok: false, error: 'not-an-ico' });
        ensureDirs();
        const file = safeIconName(body.name || 'custom.ico');
        writeFileSync(join(ICON_DIR, file), buf);
        const frames = icoFrames(buf);
        const heavy = frames.filter((f) => f.width > 128 && !f.png);
        return writeJson(res, 200, {
            ok: true, id: `user:${file}`, name: file, size: buf.length,
            frames,
            warning: heavy.length
                ? `该 ico 含 ${heavy.length} 个未压缩大尺寸帧（>128px BMP），托盘图标可能加载失败；建议改用 PNG 压缩的小尺寸 ico。`
                : null,
        });
    }

    // ---- delete an uploaded icon ------------------------------------------ #
    if (route.startsWith('/icon/') && method === 'DELETE') {
        const id = decodeURIComponent(route.slice('/icon/'.length));
        if (!id.startsWith('user:')) {
            return writeJson(res, 400, { ok: false, error: 'builtin-readonly', message: '内置图标与系统原版不可删除。' });
        }
        const state = readState();
        // The settings card hides the x for the icon in use; refuse it here too, so an
        // old page (or a hand-made request) cannot delete the icon the app is wearing.
        if (appliedIconId(state) === id) {
            return writeJson(res, 400, {
                ok: false,
                error: 'in-use',
                message: '这个图标正在使用中，先换成别的图标再删除。',
            });
        }
        const p = iconPathFor(id);
        if (!p) return writeJson(res, 404, { ok: false, error: 'not-found' });
        try {
            rmSync(p, { force: true });
            const variant = p.replace(/\.ico$/i, '-tray.ico');
            if (existsSync(variant)) rmSync(variant, { force: true });
        } catch (error) {
            return writeJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
        return writeJson(res, 200, { ok: true, deleted: id });
    }

    // ---- apply / restore -------------------------------------------------- #
    if ((route === '/apply' || route === '/restore') && method === 'POST') {
        if (!resolveExe()) {
            return writeJson(res, 400, {
                ok: false,
                error: 'not-desktop-app',
                message: '当前不是 DeepSeek Harness 桌面端（process.execPath 不是它的 exe），无法改写图标。',
            });
        }
        const body = (await readJson(req)) || {};
        const op = route === '/apply' ? 'apply' : 'restore';
        const targets = normalizeTargets(body.targets);
        let iconPath = null;
        let trayPath = null;
        if (op === 'apply') {
            iconPath = iconPathFor(body.icon);
            if (!iconPath) return writeJson(res, 400, { ok: false, error: 'unknown-icon' });
            trayPath = trayArtifact(body.icon);
        }
        const icons = { exe: iconPath, tray: trayPath };
        ensureDirs();
        const restart = body.restart !== false;
        writeState({
            pending: {
                op,
                icon: body.icon ?? null,
                iconPath,
                trayPath,
                targets,
                restart,
                queuedAt: new Date().toISOString(),
            },
            lastResult: null,
        });

        // Tray + Start Menu are applied here and now; the exe can only be
        // rewritten once this process is gone, so a worker that outlives us is
        // started before we ask the app to close.
        const hotReport = hotApply(op, icons, targets);
        const hotFailed = hotReport.filter((r) => !r.ok).length;

        const worker = launchHelper(op, icons, restart,
                                    restart ? APPLY_WAIT_S : RECONCILE_WAIT_S,
                                    !restart);
        // Remember who is working on the queue: the next start needs to tell "a
        // worker is still waiting" from "the worker died and left the job behind".
        writeState({ workerPid: worker.ok ? worker.pid ?? null : null });
        if (restart && !worker.ok) {
            // The worker could not be started: leave a marker so the next app
            // start retries the rewrite instead of losing the request.
            writeState({
                pendingExe: { op, icon: body.icon ?? null, iconPath, at: new Date().toISOString() },
            });
        }
        if (restart) scheduleProcessExit();

        let message;
        if (!restart) {
            message = '已立即应用托盘与开始菜单；关闭应用后自动完成 exe 替换，下次启动即是新图标。';
        } else if (worker.ok) {
            message = '已立即应用托盘与开始菜单；应用即将重启，重启过程中自动完成 exe 替换。';
        } else {
            message = '已立即应用托盘与开始菜单；但后台 worker 启动失败，下次启动应用时会自动重试。';
        }

        return writeJson(res, 200, {
            ok: true,
            queued: true,
            op,
            targets,
            restart,
            hotReport,
            hotFailed,
            workerOk: Boolean(worker.ok),
            workerPid: worker.pid ?? null,
            message,
        });
    }

    // ---- clear a stuck queue --------------------------------------------- #
    if (route === '/clear' && method === 'POST') {
        // workerPid goes too: the next start must not think the (now cancelled) job
        // still has somebody working on it.
        writeState({ pending: null, pendingExe: null, workerPid: null });
        return writeJson(res, 200, { ok: true });
    }

    return writeJson(res, 404, { ok: false, error: 'unknown-route', route });
}

function serveUi(res) {
    try {
        const html = readFileSync(UI_HTML);
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
        });
        res.end(html);
    } catch (error) {
        writeJson(res, 500, { ok: false, error: 'ui-missing', detail: String(error) });
    }
}

// --------------------------------------------------------------------------- #
// plugin entry
// --------------------------------------------------------------------------- #
/**
 * Finish a rewrite that a previous run could not complete. Windows locks the
 * running image, so the exe can only be touched after the app exits; killing the
 * app from /apply and rewriting on the next start is what makes the button work.
 */
function reconcilePendingExe() {
    const state = readState();
    const pending = state.pendingExe;
    if (!pending) return false;
    if (!pending.iconPath || !existsSync(pending.iconPath)) {
        writeState({ pendingExe: null, pending: null });
        return false;
    }
    const exe = resolveExe();
    if (!exe) return false;
    const op = pending.op === 'restore' ? 'restore' : 'apply';
    // restart=0: the user is looking at a running app right now, so do not pop it
    // back up after they quit it. The icon is simply correct on the next start.
    const launched = launchHelper(op, { exe: pending.iconPath, tray: null }, false, RECONCILE_WAIT_S, true);
    if (!launched.ok) {
        hostLog(`reconcile could not start the worker (${launched.error}); will retry at the next start`);
        return false;
    }
    // Note: pendingExplorer is deliberately NOT set here. The worker sets it right
    // after it really rewrites the exe; setting it now would refresh the shell while
    // the old icon is still in place (and then never again).
    writeState({ pendingExe: null, workerPid: launched.pid ?? null });
    return true;
}

/** Is that pid still around? process.kill(pid, 0) throws once it is gone. */
function processAlive(pid) {
    const value = Number(pid);
    if (!Number.isInteger(value) || value <= 0) return false;
    try {
        process.kill(value, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';        // exists, just not ours to signal
    }
}

/**
 * Pick up a queued job whose worker died before it could finish.
 *
 * Seen in the wild: the worker window sat there open, the user clicked it to select
 * the text, Windows QuickEdit paused the process, and the job was silently lost -
 * tray and Start Menu had been written, the exe had not, and "pending" stayed queued
 * forever. run-worker.ps1 now disables QuickEdit, and this is the safety net for
 * every other way a worker can disappear (window closed, machine busy, powershell
 * killed): if the queue is still there and nobody is working on it, hand it to
 * reconcilePendingExe() and let it finish in the background.
 */
function reconcileStalledPending() {
    const state = readState();
    if (!state.pending || state.pendingExe) return false;
    if (processAlive(state.workerPid)) {
        hostLog(`queued job still has a live worker (pid=${state.workerPid}); leaving it alone`);
        return false;
    }
    const pending = state.pending;
    if (!pending.iconPath || !existsSync(pending.iconPath)) {
        hostLog('queued job has no usable icon file; dropping it');
        writeState({ pending: null, workerPid: null });
        return false;
    }
    hostLog(`queued job (${pending.op} ${pending.icon}) never completed and its worker is gone; retrying it`);
    writeState({
        workerPid: null,
        pendingExe: {
            op: pending.op,
            icon: pending.icon ?? null,
            iconPath: pending.iconPath,
            at: new Date().toISOString(),
        },
    });
    return true;
}

/**
 * Refresh the shell once the app is back up.
 *
 * Restarting Explorer alone is NOT enough - the icon cache databases survive it and
 * keep serving the old bitmap (verified the hard way: the exe, the shortcuts and
 * the fingerprints were all correct while the desktop still showed the old icon).
 * bin/refresh-shell.ps1 does the whole job: ie4uinit, stop Explorer, race-delete
 * iconcache_*.db, start Explorer, broadcast SHCNE_ASSOCCHANGED.
 */
function reconcilePendingExplorer() {
    const state = readState();
    if (!state.pendingExplorer) return false;
    writeState({ pendingExplorer: null });
    if (!existsSync(REFRESH_SHELL)) {
        hostLog('shell refresh skipped: bin/refresh-shell.ps1 is missing');
        return false;
    }
    // Fire and forget through WMI: the refresh takes several seconds (it stops and
    // restarts Explorer), and this runs during plugin startup - blocking the boot
    // for that would be rude. WMI also keeps it alive if the app is closed right
    // after it starts. The script writes its own progress to helper.log.
    const launched = spawnDetachedViaWmi(
        REFRESH_CMD,
        REFRESH_RESULT,
        [quoteArg(POWERSHELL), '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
         '-ExecutionPolicy', 'Bypass', '-File', quoteArg(REFRESH_SHELL),
         '-Log', quoteArg(LOG_FILE)].join(' '),
        'shell refresh');
    if (!launched.ok) hostLog(`shell refresh could not be started (${launched.detail})`);
    return Boolean(launched.ok);
}

export function apply(ctx) {
    ensureDirs();
    let rewroteExe = false;
    // A queued job whose worker died first: hand it back to the retry path below.
    try { reconcileStalledPending(); } catch { /* never block startup */ }
    try { rewroteExe = reconcilePendingExe(); } catch { /* never block startup */ }
    try { reconcilePendingExplorer(); } catch { /* never block startup */ }
    ctx.effect(() => {
        const disposers = [];
        const guard = (fn) => async (req, res) => {
            try { await fn(req, res); }
            catch (error) {
                try { writeJson(res, 500, { ok: false, error: String(error?.message || error) }); }
                catch { /* response already gone */ }
            }
        };

        disposers.push(ctx.webServer.register({
            kind: 'exact',
            path: '/icon-changer',
            handler: guard(async (req, res) => serveUi(res)),
        }));

        disposers.push(ctx.webServer.register({
            kind: 'prefix',
            path: '/api/icon-changer',
            handler: guard(async (req, res) => {
                const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
                await handleApi(req, res, url);
            }),
        }));

        ctx.logger?.info?.('[icon-changer] routes ready at /icon-changer');
        return () => { for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } } };
    }, 'icon-changer: routes');
}

export { name, inject };
