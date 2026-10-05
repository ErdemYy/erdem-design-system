/**
 * The process supervisor of validation-runner.mjs. It is run by the runner (never by a user) as `node validation-supervisor.mjs`
 * with one JSON request on stdin and answers with one JSON line on stdout. It starts the command as an argument vector with no
 * shell and no stdin, bounds its output, enforces the time limit, and on a timeout or an output overflow terminates the WHOLE
 * process tree (Windows: `taskkill /T /F`; elsewhere: the process group) and verifies that it stopped, so that a timed-out
 * check cannot keep running (and keep writing) after it has been reported.
 *
 * Request:  { file, args, cwd, timeoutMs, maxBytes }
 * Response: { status, signal, timedOut, overflow, treeTerminated, stdoutLines, stderrLines, stdout (tail), stderr (tail), error }
 */
import { spawn, spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const TAIL = 16 * 1024;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => run(JSON.parse(raw)));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Terminate the tree rooted at pid; true only when the termination was carried out and the root is gone. */
function killTree(pid) {
  let ok = false;
  if (WIN) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, encoding: 'utf8' });
    ok = !r.error && (r.status === 0 || r.status === 128); // 128: already gone
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
      ok = true;
    } catch (e) {
      try {
        process.kill(pid, 'SIGKILL');
        ok = true;
      } catch (e2) {
        ok = e2.code === 'ESRCH';
      }
    }
  }
  const until = Date.now() + 2000;
  while (alive(pid) && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)'], { shell: false, windowsHide: true });
  return ok && !alive(pid);
}

function run(cfg) {
  let done = false;
  let timedOut = false;
  let overflow = false;
  let treeTerminated = null;
  let bytes = 0;
  const out = { stdout: '', stderr: '', stdoutLines: 0, stderrLines: 0 };
  let child;
  const finish = (extra) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    process.stdout.write(`${JSON.stringify({ timedOut, overflow, treeTerminated, ...out, ...extra })}\n`);
    process.exit(0);
  };
  const stop = () => {
    treeTerminated = killTree(child.pid);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
    setTimeout(() => finish({ status: null, signal: 'SIGKILL' }), 1500);
  }, cfg.timeoutMs);
  try {
    child = spawn(cfg.file, cfg.args, { cwd: cfg.cwd, env: cfg.env ?? process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !WIN });
  } catch (e) {
    finish({ status: null, signal: null, error: e.code ?? 'ESPAWN' });
    return;
  }
  const take = (key, lines) => (chunk) => {
    const s = chunk.toString('utf8');
    bytes += chunk.length;
    out[lines] += (s.match(/\n/g) ?? []).length;
    out[key] = (out[key] + s).slice(-TAIL);
    if (bytes > cfg.maxBytes && !overflow) {
      overflow = true;
      stop();
    }
  };
  child.stdout.on('data', take('stdout', 'stdoutLines'));
  child.stderr.on('data', take('stderr', 'stderrLines'));
  child.on('error', (e) => finish({ status: null, signal: null, error: e.code ?? 'ESPAWN' }));
  child.on('close', (code, signal) => {
    if (timedOut || overflow) setTimeout(() => finish({ status: code, signal }), 50);
    else finish({ status: code, signal });
  });
}
