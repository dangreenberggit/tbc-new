// Shared plumbing for the Upgrades-tab CDP harnesses.
//
// Extracted from test-layout.mjs (the layout gate, ticket 322) so a second
// consumer -- test-review.mjs, the per-ticket visual+a11y capture script --
// can reuse the same build/serve/launch/attach/evaluate plumbing without
// duplicating it. test-layout.mjs keeps its assertions and main(); everything
// that is not an assertion lives here.
//
// It drives an on-disk Chromium (Playwright's, already present) over raw CDP on
// Node 22's global WebSocket -- no puppeteer, no playwright, no jsdom, nothing
// added to package.json beyond axe-core. The scout's probe proved ~40 lines of
// session plumbing is enough; that plumbing is `cdp()` below.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUT_ROOT = path.join(__dirname, 'dist'); // http-server root: the app uses absolute /tbc/... paths
export const OUT_DIR = path.join(OUT_ROOT, 'tbc');
export const PAGE_PATH = '/tbc/paladin/retribution/'; // the scout's spec
export const WIDTHS = [375, 653, 768, 1280]; // 375 phone, 653 narrow (covers the sub-768 legibility band), 768 tablet, 1280 above xl=1200 where the grid is active
export const HEIGHT = 900;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// The machine-readable verdict, one tagged JSON line on stdout.
//
// This gate exits 1 for two unrelated things: geometry it MEASURED and found
// wrong, and a crash before it measured anything (a missing prereq, a rotted
// browser path, a build failure). A caller that reads only the exit code
// cannot tell them apart, and reporting the second as "the layout is broken"
// is a false accusation. So state which happened:
//   outcome:"measured"   -- widths were rendered and asserted; `failed` counts
//                           real geometry failures (0 means green).
//   outcome:"unmeasured" -- nothing was measured; `reason` is the first line
//                           of the error. Says nothing about the layout.
export const VERDICT_TAG = 'LAYOUT_GATE_VERDICT';

export function verdict(outcome, extra) {
	try {
		console.log(`${VERDICT_TAG} ${JSON.stringify({ outcome, ...extra })}`);
	} catch {
		// Never let reporting the verdict change the exit code.
	}
}

export function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

export function findChromium() {
	const explicit = 'C:\\Users\\dgree\\AppData\\Local\\ms-playwright\\chromium-1200\\chrome-win64\\chrome.exe';
	if (fs.existsSync(explicit)) return explicit;
	// The pinned build can move; fall back to any chromium under ms-playwright.
	const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
	if (fs.existsSync(base)) {
		for (const dir of fs.readdirSync(base)) {
			if (!dir.startsWith('chromium-')) continue;
			const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
			if (fs.existsSync(exe)) return exe;
		}
	}
	throw new Error(`no Chromium found under ${base} -- expected a Playwright chromium-*/chrome-win64/chrome.exe`);
}

// ---------------------------------------------------------------------------
// Build: refresh the JS/CSS bundle from the current tab source.
//
// The committed dist bundle is stale the moment any tab source or SCSS file
// changes, and a gate run against stale dist proves nothing about the code that
// changed. lib.wasm and assets/ are produced by the standard `make host` and
// are layout-irrelevant (the shell renders without a sim), so this refreshes
// only the three steps that turn tab source into the bundle: tsc --noEmit, the
// worker build, and `vite build`. It fails loudly if lib.wasm or assets/ are
// absent, because those must already be on disk from a prior full build.
// ---------------------------------------------------------------------------

export function run(cmd, args, label, extraEnv = {}) {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd: __dirname, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
		let tail = '';
		const keep = d => {
			tail = (tail + d.toString()).slice(-4000);
		};
		p.stdout.on('data', keep);
		p.stderr.on('data', keep);
		p.on('error', reject);
		p.on('exit', code => {
			if (code === 0) resolve();
			else reject(new Error(`${label} exited ${code}\n${tail}`));
		});
	});
}

// The makefile's wasm recipe ends with `gzip -9 -f -n $(OUT_DIR)/lib.wasm`,
// which REPLACES the uncompressed file -- so after a plain `make host` only
// lib.wasm.gz is on disk, and the gzipped form is the one the app fetches
// (SIM_WASM_URL in ui/core/worker_pool.ts). Requiring the uncompressed name
// made this gate throw on every normal build. Either form proves the WASM
// build completed; nothing here reads the bytes.
export const WASM_CANDIDATES = ['lib.wasm.gz', 'lib.wasm'];

export async function build() {
	const wasmPresent = WASM_CANDIDATES.filter(name => fs.existsSync(path.join(OUT_DIR, name)));
	if (wasmPresent.length === 0)
		throw new Error(
			`dist/tbc/lib.wasm.gz (or dist/tbc/lib.wasm) is missing -- run \`make host\` once to produce the WASM/assets this gate builds the bundle on top of`,
		);
	if (!fs.existsSync(path.join(OUT_DIR, 'assets')))
		throw new Error(`dist/tbc/assets is missing -- run \`make host\` once to produce the assets the page loads`);

	console.log('building bundle (tsc --noEmit)...');
	await run('node', ['node_modules/typescript/bin/tsc', '--noEmit'], 'tsc');
	console.log('building bundle (workers)...');
	await run('npx', ['tsx', 'vite.build-workers.mts'], 'vite.build-workers');
	console.log('building bundle (vite build)...');
	// Compiles in the tab's fixture loader (ticket 504), which the fixture pass
	// and fixture manifest entries inject through. It also means this dist/ is
	// not a user build: see data/tab-fixtures/README.md in the main repo.
	await run('npx', ['vite', 'build'], 'vite build', { TBC_TAB_FIXTURES: '1' });
	// `vite build` was observed to empty the WASM out of dist/. Re-check the
	// exact file(s) that were there before the build, not a fixed name, so the
	// protection survives whichever form `make host` left behind.
	const wasmLost = wasmPresent.filter(name => !fs.existsSync(path.join(OUT_DIR, name)));
	if (wasmLost.length)
		throw new Error(`vite build emptied ${wasmLost.map(n => `dist/tbc/${n}`).join(' and ')} -- expected it to be left in place`);
	console.log('bundle built.');
}

// ---------------------------------------------------------------------------
// http-server: serve dist/ (the fork's already-present dependency).
// ---------------------------------------------------------------------------

// Run http-server's entry script under this node, with no shell and no npx.
// Through `npx` with `shell: true`, the tracked process on Windows is a
// cmd.exe whose descendants (npx's node, another cmd.exe, http-server's node)
// hold the port; proc.kill() terminates only that cmd.exe, so every run left
// the server running. Here the tracked process is the server itself.
const HTTP_SERVER_BIN = path.join(__dirname, 'node_modules', 'http-server', 'bin', 'http-server');

export async function startServer() {
	const port = await freePort();
	const p = spawn(process.execPath, [HTTP_SERVER_BIN, OUT_ROOT, '-p', String(port), '-a', '127.0.0.1', '--silent', '-c-1'], {
		cwd: __dirname,
		stdio: 'ignore',
	});
	// Both callers call process.exit() on paths that never reach their
	// finally blocks (a setup failure after this returns, main().catch).
	process.on('exit', () => p.kill());
	// Wait until it answers.
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}${PAGE_PATH}`);
			if (res.ok) return { proc: p, port };
		} catch {
			// not up yet
		}
		await sleep(150);
	}
	p.kill();
	throw new Error('http-server did not answer in time');
}

// ---------------------------------------------------------------------------
// CDP session over the global WebSocket.
// ---------------------------------------------------------------------------

export async function launchChrome() {
	const port = await freePort();
	const exe = findChromium();
	const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tbc-layout-'));
	const proc = spawn(
		exe,
		[
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			'--hide-scrollbars',
			'--disable-dev-shm-usage',
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${userDataDir}`,
			'about:blank',
		],
		{ stdio: 'ignore' },
	);
	// On Windows proc.kill() ends only the browser process. Its renderer and
	// crashpad handler normally follow, but a renderer stuck in a page loop
	// does not: a script that exited with its page stuck left both running.
	// taskkill /T ends the tree while the browser is still its root, so this
	// has to run instead of proc.kill(), not after it. Callers call kill() in
	// their cleanup; the exit hook covers the process.exit() paths that skip it.
	let killed = false;
	const kill = () => {
		if (killed || proc.exitCode !== null || proc.signalCode !== null) return;
		killed = true;
		if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
		else proc.kill();
	};
	process.on('exit', kill);
	// Poll /json/version for the browser-level WebSocket URL.
	const deadline = Date.now() + 20000;
	let wsUrl;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) {
				wsUrl = (await res.json()).webSocketDebuggerUrl;
				if (wsUrl) break;
			}
		} catch {
			// not up yet
		}
		await sleep(150);
	}
	if (!wsUrl) {
		kill();
		throw new Error('Chromium CDP endpoint did not come up');
	}
	return { proc, kill, port, wsUrl, userDataDir };
}

// A minimal CDP client: send(method, params) -> result, with event waiting.
//
// When the socket closes or errors, every pending call rejects and later calls
// reject at once. Without that, a call in flight when the socket dropped never
// settled, and its caller waited forever (a recording hung ~47 min this way
// when Windows entered Modern Standby). `callTimeoutMs`, when given, also
// rejects any call with no answer in that time.
export function cdp(wsUrl, { callTimeoutMs } = {}) {
	const ws = new WebSocket(wsUrl);
	let nextId = 1;
	const pending = new Map();
	const listeners = new Set();
	let closedError = null;
	const settle = (id, fn, value) => {
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		clearTimeout(entry.timer);
		entry[fn](value);
	};
	const closeAll = why => {
		if (!closedError) closedError = new Error(why);
		for (const id of [...pending.keys()]) settle(id, 'reject', closedError);
	};
	ws.addEventListener('message', ev => {
		const msg = JSON.parse(ev.data);
		if (msg.id != null && pending.has(msg.id)) {
			if (msg.error) settle(msg.id, 'reject', new Error(`${msg.error.message} (${JSON.stringify(msg.params ?? {})})`));
			else settle(msg.id, 'resolve', msg.result);
		} else if (msg.method) {
			for (const l of listeners) l(msg);
		}
	});
	ws.addEventListener('close', ev => closeAll(`CDP WebSocket closed (code ${ev.code})`));
	ws.addEventListener('error', () => closeAll('CDP WebSocket error'));
	const ready = new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', () => reject(new Error('CDP WebSocket error')), { once: true });
	});
	function send(method, params = {}, sessionId) {
		if (closedError) return Promise.reject(closedError);
		const id = nextId++;
		const payload = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			const timer = callTimeoutMs ? setTimeout(() => settle(id, 'reject', new Error(`CDP ${method} got no answer in ${callTimeoutMs / 1000}s`)), callTimeoutMs) : undefined;
			pending.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify(payload));
		});
	}
	function onEvent(fn) {
		listeners.add(fn);
		return () => listeners.delete(fn);
	}
	return { ready, send, onEvent, close: () => ws.close() };
}

// Attach to a fresh page target and return a session-scoped send().
export async function attachPage(client) {
	const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
	const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
	const send = (method, params) => client.send(method, params, sessionId);
	await send('Page.enable', {});
	await send('Runtime.enable', {});
	return { send, targetId };
}

// Evaluate an expression in the page and return its JSON value.
export async function evaluate(send, expression) {
	const { result, exceptionDetails } = await send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (exceptionDetails) throw new Error(`page eval threw: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
	return result.value;
}

// ---------------------------------------------------------------------------
// The run phase constants and expressions (ticket 329).
//
// The five geometry assertions measure the pre-run shell. The legibility
// assertions target the results table, which does not exist until a run lands
// rows. So the run phase drives a real headless WASM run -- the harness's own
// Chromium runs the sim with no Go backend (probed feasible: 5 rows in ~42s) --
// then measures the landed cells. The sim runs ONCE, on one page at 653px; the
// widths are re-emulated on that same page (rows survive a device-metrics
// change without reload -- verified), so the ~40s cost is paid a single time.
// ---------------------------------------------------------------------------

export const RUN_WIDTH = 653; // narrow enough to reproduce the sub-md legibility defect
export const RUN_DEADLINE_MS = 120000; // ~3x the measured 42s to first 5 rows
export const MIN_ROWS = 5;

// Activate the Upgrades tab and click Run. Returns { ok } or { error }.
export function startRunExpression() {
	return `(async () => {
		const waitFor = async (fn, ms) => { const end = Date.now()+ms; while (Date.now()<end) { const v=fn(); if (v) return v; await new Promise(r=>setTimeout(r,100)); } return fn(); };
		const navBtn = await waitFor(() => document.querySelector('button[data-bs-target="#upgrades-tab"]'), 30000);
		if (!navBtn) return { error: 'upgrades-tab nav button never appeared (app did not boot?)' };
		navBtn.click();
		const runBtn = await waitFor(() => document.querySelector('.upgrades-run-button'), 15000);
		if (!runBtn) return { error: 'upgrades run button never appeared' };
		runBtn.click();
		return { ok: true };
	})()`;
}

// Count landed result rows. Polled until >= MIN_ROWS or the deadline.
export const rowCountExpression = `document.querySelectorAll('.upgrades-results-table tbody tr').length`;

// ---------------------------------------------------------------------------
// Recorded fixtures (ticket 504).
//
// A fixture is a finished Ranking recorded from a real run in the main repo
// (data/tab-fixtures/). Loading one takes seconds and needs no sim, so the gate
// can measure set-bonus rows that its live ret run never lands. The page's
// loader exists only in builds made with TBC_TAB_FIXTURES=1, which build()
// above sets.
// ---------------------------------------------------------------------------

export const PAGE_PATH_BY_SPEC = { ret: '/tbc/paladin/retribution/', feral: '/tbc/druid/feralcat/' };
export const FIXTURE_DEADLINE_MS = 30000;

export function pagePathFor(spec) {
	const p = PAGE_PATH_BY_SPEC[spec];
	if (!p) throw new Error(`no page path for fixture spec ${spec}`);
	return p;
}

// Activate the Upgrades tab and load `fixtureJson` (the file's text) through
// window.__upgradesFixture. Returns the loader's { ok, rows } / { ok:false, reason }
// or { error }.
export function loadFixtureExpression(fixtureJson) {
	return `(async () => {
		const waitFor = async (fn, ms) => { const end = Date.now()+ms; while (Date.now()<end) { const v=fn(); if (v) return v; await new Promise(r=>setTimeout(r,100)); } return fn(); };
		const navBtn = await waitFor(() => document.querySelector('button[data-bs-target="#upgrades-tab"]'), 30000);
		if (!navBtn) return { error: 'upgrades-tab nav button never appeared (app did not boot?)' };
		navBtn.click();
		const hook = await waitFor(() => typeof window.__upgradesFixture === 'function', 15000);
		if (!hook) return { error: 'window.__upgradesFixture is absent -- was dist built with TBC_TAB_FIXTURES=1?' };
		return await window.__upgradesFixture(${fixtureJson});
	})()`;
}

// A fixture load is settled when the results table has rows and the stale
// banner (the done state's '.upgrades-status-line.text-warning') is absent.
// Never wait for "Took": no run happened, so the summary never says it.
export const fixtureSettledExpression = `(document.querySelectorAll('.upgrades-results-table tbody tr').length >= 1 && !document.querySelector('#upgrades-tab .upgrades-status-line.text-warning'))`;

// Navigate `send`'s page to the fixture's spec, load it and wait until settled.
// Returns { ok, rows, ms } or { error }.
export async function loadFixturePage(send, port, fixtureText) {
	const fixture = JSON.parse(fixtureText);
	await send('Page.navigate', { url: `http://127.0.0.1:${port}${pagePathFor(fixture.spec)}` });
	await sleep(300);
	const t0 = Date.now();
	const loaded = await evaluate(send, loadFixtureExpression(fixtureText));
	if (!loaded || loaded.error) return { error: loaded?.error ?? 'fixture load returned nothing' };
	if (!loaded.ok) return { error: `fixture rejected: ${loaded.reason}${loaded.detail ? ` (${loaded.detail})` : ''}` };
	const deadline = Date.now() + FIXTURE_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (await evaluate(send, fixtureSettledExpression)) {
			const rows = await evaluate(send, rowCountExpression);
			return { ok: true, rows, ms: Date.now() - t0 };
		}
		await sleep(250);
	}
	return { error: `fixture did not settle in ${FIXTURE_DEADLINE_MS / 1000}s (rows or stale banner)` };
}

// Activate the Upgrades tab and wait for its shell, WITHOUT measuring anything.
// This is the tab-activation half of test-layout.mjs's probeExpression, factored
// out so test-review.mjs can bring the pane up before it captures or interacts.
// Returns { ok } once the view-controls host is laid out, or { error }.
export function activateTabExpression() {
	return `(async () => {
		const waitFor = async (fn, ms) => {
			const end = Date.now() + ms;
			while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
			return fn();
		};
		const navBtn = await waitFor(() => document.querySelector('button[data-bs-target="#upgrades-tab"]'), 30000);
		if (!navBtn) return { error: 'upgrades-tab nav button never appeared (app did not boot?)' };
		navBtn.click();
		const host = await waitFor(() => {
			const h = document.querySelector('#upgrades-tab .upgrades-view-controls-host');
			if (!h) return null;
			const r = h.getBoundingClientRect();
			return (h.offsetParent !== null || r.width > 0) ? h : null;
		}, 15000);
		if (!host) return { error: 'upgrades-view-controls-host never became visible after activating the tab' };
		return { ok: true };
	})()`;
}

// ---------------------------------------------------------------------------
// Accessibility: axe-core injection and a keyboard focus walk.
//
// axe ships the WCAG rule set with `impact` levels and a help URL per rule,
// which is what a reviewer reads and what a baseline can be keyed on. It is
// injected through the same CDP Runtime.evaluate the gate already uses; no
// Playwright, no Puppeteer, no separate a11y harness.
// ---------------------------------------------------------------------------

let _axeSource = null;

// Read node_modules/axe-core/axe.min.js once (cached). The source is a UMD
// bundle that defines window.axe when evaluated in the page.
export function loadAxeSource() {
	if (_axeSource === null) {
		_axeSource = fs.readFileSync(path.join(__dirname, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
	}
	return _axeSource;
}

// Run axe against `scope` (a CSS selector) in the page and return the mapped
// violations plus wall time. Injects the axe source once per page: `window.axe`
// persists across evaluate calls on the same session, so re-injection is skipped
// when it is already defined. `opts.tags` overrides the default WCAG tag list.
export async function axeRun(send, scope, opts = {}) {
	const tags = opts.tags ?? ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];
	const alreadyLoaded = await evaluate(send, `typeof window.axe !== 'undefined'`);
	if (!alreadyLoaded) {
		// Inject the axe UMD source. Not returnByValue -- the bundle's value is
		// large and irrelevant; we only need the side effect of defining window.axe.
		await send('Runtime.evaluate', { expression: loadAxeSource(), returnByValue: false, awaitPromise: false });
	}
	const t0 = Date.now();
	const expression = `(async () => {
		const scopeEl = document.querySelector(${JSON.stringify(scope)});
		if (!scopeEl) return { error: 'axe scope not found: ' + ${JSON.stringify(scope)} };
		const res = await window.axe.run(scopeEl, {
			runOnly: { type: 'tag', values: ${JSON.stringify(tags)} },
			resultTypes: ['violations'],
		});
		return {
			violations: res.violations.map(v => ({
				id: v.id,
				impact: v.impact,
				help: v.help,
				helpUrl: v.helpUrl,
				tags: v.tags,
				nodes: v.nodes.map(n => ({
					target: n.target,
					html: (n.html || '').slice(0, 200),
					failureSummary: n.failureSummary,
				})),
			})),
		};
	})()`;
	const out = await evaluate(send, expression);
	const ms = Date.now() - t0;
	if (out && out.error) return { violations: [], ms, error: out.error };
	return { violations: out.violations, ms };
}

// A keyboard focus walk over `scope`: press Tab from the first focusable control
// and record which focusable descendants receive focus, until focus leaves the
// scope. axe does not test operability; this catches a control that cannot be
// reached by keyboard.
//
// Returns { focusable, visited, missed, unmeasured }. `unmeasured` is true when
// the first Tab left activeElement on document.body -- headless Chromium does
// not always move DOM focus on a synthetic Tab (C23) -- so a walk that never
// moved is reported unmeasured rather than as every control missed.
export async function focusWalk(send, scope) {
	await send('Emulation.setFocusEmulationEnabled', { enabled: true });

	// The page-side list of focusable descendants, each as a CSS path string.
	const listExpr = `(() => {
		const scopeEl = document.querySelector(${JSON.stringify(scope)});
		if (!scopeEl) return { error: 'focus scope not found' };
		const cssPath = el => {
			if (!el || el.nodeType !== 1) return null;
			const parts = [];
			let node = el;
			while (node && node.nodeType === 1 && node !== document.documentElement) {
				let sel = node.tagName.toLowerCase();
				if (node.id) { sel += '#' + node.id; parts.unshift(sel); break; }
				const parent = node.parentElement;
				if (parent) {
					const sibs = [...parent.children].filter(c => c.tagName === node.tagName);
					if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
				}
				parts.unshift(sel);
				node = node.parentElement;
			}
			return parts.join(' > ');
		};
		const candidates = [...scopeEl.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')];
		const focusable = candidates.filter(el => {
			if (el.disabled) return false;
			if (el.getAttribute('tabindex') === '-1') return false;
			if (el.offsetParent === null) return false;
			return true;
		});
		window.__focusPaths = focusable.map(cssPath);
		if (focusable.length) focusable[0].focus();
		return { focusable: window.__focusPaths, first: cssPath(document.activeElement), inScope: scopeEl.contains(document.activeElement) };
	})()`;
	const listed = await evaluate(send, listExpr);
	if (listed && listed.error) return { focusable: [], visited: [], missed: [], unmeasured: true, error: listed.error };

	const focusable = listed.focusable || [];
	const activePathExpr = `(() => {
		const scopeEl = document.querySelector(${JSON.stringify(scope)});
		const el = document.activeElement;
		const cssPath = e => {
			if (!e || e.nodeType !== 1) return null;
			const parts = [];
			let node = e;
			while (node && node.nodeType === 1 && node !== document.documentElement) {
				let sel = node.tagName.toLowerCase();
				if (node.id) { sel += '#' + node.id; parts.unshift(sel); break; }
				const parent = node.parentElement;
				if (parent) {
					const sibs = [...parent.children].filter(c => c.tagName === node.tagName);
					if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
				}
				parts.unshift(sel);
				node = node.parentElement;
			}
			return parts.join(' > ');
		};
		return { path: cssPath(el), onBody: el === document.body, inScope: scopeEl ? scopeEl.contains(el) : false };
	})()`;

	const pressTab = async () => {
		await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
		await sleep(30);
	};

	const visited = new Set();
	if (listed.first) visited.add(listed.first);

	// Probe C23: press Tab once and see whether DOM focus moved off body.
	await pressTab();
	let cur = await evaluate(send, activePathExpr);
	if (cur.onBody) {
		// Focus never moved: the walk cannot measure operability in this browser.
		return { focusable, visited: [...visited], missed: [], unmeasured: true };
	}

	const maxSteps = focusable.length + 5;
	let steps = 1;
	while (steps < maxSteps) {
		if (cur.path) visited.add(cur.path);
		if (!cur.inScope) break; // focus left the pane
		await pressTab();
		cur = await evaluate(send, activePathExpr);
		steps++;
	}

	const missed = focusable.filter(p => !visited.has(p));
	return { focusable, visited: [...visited], missed, unmeasured: false };
}

// Classify axe violations and the focus walk against a baseline. Pure.
//
// Returns { fail, warn, matched } where `matched` is a Set of baseline entry
// indices that fired this run. Key = ruleId + selector, selector being the
// node's target joined by ' '. A focus miss is a synthetic violation with
// ruleId 'focus-walk', impact 'serious', selector the missed path; an
// unmeasured walk is itself a FAIL (ticket 450).
//
//   fail = impact critical/serious with a WCAG tag AND no baseline match;
//          also an unmeasured focus walk (operability unverifiable)
//   warn = moderate/minor, best-practice-only rules, and baseline-matched
//          entries (the ratchet: known debt does not block, but is reported)
//
// `ctx` = { state, width } for the message text.
export function a11yClassify(violations, walk, baseline, ctx) {
	const baselineIndex = new Map();
	// CSS-match entries (ticket 473): axe emits a per-node selector like
	// `span[title="Choker of Endless Nightmares"]`, which never equals a
	// class-based baseline selector such as `.upgrades-item-name.text-epic`.
	// These are checked separately below, by testing the class attribute in
	// the node's `html` snippet -- classification runs in Node (this
	// function), not in the page, so there is no live DOM to run
	// `Element.matches` against; a regex on the serialized class list is the
	// closest equivalent available here.
	const cssEntries = [];
	baseline.forEach((e, i) => {
		if (e.match === 'css') {
			cssEntries.push({ idx: i, ruleId: e.ruleId, selector: e.selector });
		} else {
			baselineIndex.set(`${e.ruleId}\u0000${e.selector}`, i);
		}
	});
	const matched = new Set();
	const fail = [];
	const warn = [];

	const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
	const isWcag = tags => (tags || []).some(t => WCAG_TAGS.includes(t));

	// A baseline `selector` like `.upgrades-item-name.text-epic` is read as a
	// flat list of required class tokens (the only compound form this repo's
	// entries use); each token must appear in the node's class attribute.
	const cssSelectorMatchesHtml = (selector, html) => {
		const classMatch = /\sclass="([^"]*)"/.exec(html || '');
		if (!classMatch) return false;
		const classes = new Set(classMatch[1].split(/\s+/));
		const tokens = selector.split('.').filter(Boolean);
		if (tokens.length === 0) return false;
		return tokens.every(t => classes.has(t));
	};

	const consider = (ruleId, impact, selector, tags, helpUrl, html) => {
		const key = `${ruleId}\u0000${selector}`;
		const idx = baselineIndex.get(key);
		const where = `[${ctx.state} ${ctx.width}]`;
		if (idx !== undefined) {
			matched.add(idx);
			warn.push(`WARN a11y baselined ${where} ${ruleId} ${selector} (${impact})`);
			return;
		}
		for (const entry of cssEntries) {
			if (entry.ruleId === ruleId && cssSelectorMatchesHtml(entry.selector, html)) {
				matched.add(entry.idx);
				warn.push(`WARN a11y baselined (css) ${where} ${ruleId} ${selector} (${impact})`);
				return;
			}
		}
		const critical = impact === 'critical' || impact === 'serious';
		const wcag = isWcag(tags);
		if (critical && wcag) {
			fail.push(`FAIL a11y ${where} ${ruleId} ${selector} (${impact}) ${helpUrl || ''}`.trim());
		} else {
			warn.push(`WARN a11y ${where} ${ruleId} ${selector} (${impact || 'best-practice'})`);
		}
	};

	for (const v of violations || []) {
		for (const n of v.nodes || []) {
			const selector = (n.target || []).join(' ');
			consider(v.id, v.impact, selector, v.tags, v.helpUrl, n.html);
		}
	}

	if (walk) {
		if (walk.unmeasured) {
			// The gate promises keyboard operability; a walk that measured nothing
			// (synthetic Tab left focus on body, C23) cannot keep that promise. This
			// repo's Playwright Chromium DOES move focus, so unmeasured here means the
			// focus emulation regressed to a no-op -- FAIL rather than degrade the
			// guarantee to a silent WARN (ticket 450). A genuinely focus-incapable env
			// crashes before geometry and is a whole-gate SKIP, a separate path.
			const why = walk.error ? ` (${walk.error})` : '';
			fail.push(`FAIL a11y [${ctx.state} ${ctx.width}] focus-walk unmeasured${why} -- keyboard operability was not verified (C23); the gate cannot pass without it`);
		} else {
			for (const missed of walk.missed || []) {
				consider('focus-walk', 'serious', missed, ['wcag2a'], 'https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html');
			}
		}
	}

	return { fail, warn, matched };
}
