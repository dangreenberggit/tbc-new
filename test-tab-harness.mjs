// Shared plumbing for the Upgrades-tab CDP harnesses: the dev server's fixture
// plugin (tools/vite/tab_fixtures.mts) and the main repo's tab-fixture scripts
// (scripts/tab-fixtures/smoke.mjs, record.mjs) import it.
//
// It drives an on-disk Chromium (Playwright's, already present) over raw CDP on
// Node 22's global WebSocket: no puppeteer, no playwright, no jsdom.
//
// Re-created for the React tab (ticket 558): selectors are the tab's
// data-testids and the tab is opened through the sim tab strip. The layout and
// review gates (test-layout.mjs, test-review.mjs) share the accessibility
// helpers at the end of this file.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUT_ROOT = path.join(__dirname, 'dist'); // http-server root: the app uses absolute /tbc/... paths
export const OUT_DIR = path.join(OUT_ROOT, 'tbc');
export const PAGE_PATH = '/tbc/paladin/retribution/';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// The machine-readable verdict, one tagged JSON line on stdout: "measured" when
// the gate rendered and asserted, "unmeasured" when it crashed before that, so a
// caller can tell a broken layout from a broken prerequisite.
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
	const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
	if (fs.existsSync(base)) {
		for (const dir of fs.readdirSync(base).sort().reverse()) {
			if (!dir.startsWith('chromium-')) continue;
			const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
			if (fs.existsSync(exe)) return exe;
		}
	}
	throw new Error(`no Chromium found under ${base} -- expected a Playwright chromium-*/chrome-win64/chrome.exe`);
}

// ---------------------------------------------------------------------------
// Build and serve: the same steps as the makefile's bundle target
// (`npx tsx vite.build-workers.mts`, `npx vite build`), with the fixture loader
// compiled in. lib.wasm.gz and assets/ come from a prior `make host`.
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

// The app fetches `/tbc/lib.wasm.gz` (ui/sim/workers/worker_pool.ts, SIM_WASM_URL).
export const WASM_FILE = 'lib.wasm.gz';

export async function build() {
	if (!fs.existsSync(path.join(OUT_DIR, WASM_FILE))) throw new Error(`dist/tbc/${WASM_FILE} is missing -- run \`make host\` once first`);
	if (!fs.existsSync(path.join(OUT_DIR, 'assets'))) throw new Error('dist/tbc/assets is missing -- run `make host` once first');
	console.log('building bundle (tsc --noEmit)...');
	await run('node', ['node_modules/typescript/bin/tsc', '--noEmit'], 'tsc');
	console.log('building bundle (workers)...');
	await run('npx', ['tsx', 'vite.build-workers.mts'], 'vite.build-workers');
	console.log('building bundle (vite build)...');
	// Compiles in the tab's fixture loader, so this dist/ is not a user build.
	await run('npx', ['vite', 'build'], 'vite build', { TBC_TAB_FIXTURES: '1' });
	if (!fs.existsSync(path.join(OUT_DIR, WASM_FILE))) throw new Error(`vite build removed dist/tbc/${WASM_FILE}`);
	console.log('bundle built.');
}

// http-server's entry script under this node, with no shell and no npx: through
// a shell on Windows, killing the tracked process left the server running.
const HTTP_SERVER_BIN = path.join(__dirname, 'node_modules', 'http-server', 'bin', 'http-server');

export async function startServer() {
	const port = await freePort();
	const p = spawn(process.execPath, [HTTP_SERVER_BIN, OUT_ROOT, '-p', String(port), '-a', '127.0.0.1', '--silent', '-c-1'], {
		cwd: __dirname,
		stdio: 'ignore',
	});
	process.on('exit', () => p.kill());
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
	const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tbc-tab-'));
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
	// On Windows proc.kill() ends only the browser process, and a renderer stuck
	// in a page loop outlives it; taskkill /T ends the tree.
	let killed = false;
	const kill = () => {
		if (killed || proc.exitCode !== null || proc.signalCode !== null) return;
		killed = true;
		if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
		else proc.kill();
	};
	process.on('exit', kill);
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

// A minimal CDP client: send(method, params) -> result, with event listeners.
// A closed or failed socket rejects every pending call and every later one, so
// no caller waits forever (a recording once hung ~47 min in Modern Standby);
// `callTimeoutMs` also rejects any call with no answer in that time.
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
			const timer = callTimeoutMs
				? setTimeout(() => settle(id, 'reject', new Error(`CDP ${method} got no answer in ${callTimeoutMs / 1000}s`)), callTimeoutMs)
				: undefined;
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
// The tab's selectors and page expressions.
// ---------------------------------------------------------------------------

/** The Upgrades button in the sim tab strip (`ui/app/SimTabs.tsx`; `TabNav` gives each tab its id as testid). */
export const upgradesTabButtonSelector = '[data-testid="sim-tabs"] [data-testid="upgrades-tab"]';
export const resultRowsSelector = '[data-testid="upgrades-results-table"] tbody tr';

const WAIT_FOR = `const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return fn(); };`;
const OPEN_TAB = `const navBtn = await waitFor(() => document.querySelector(${JSON.stringify(upgradesTabButtonSelector)}), 30000);
		if (!navBtn) return { error: 'the Upgrades tab button never appeared (app did not boot?)' };
		navBtn.click();`;

export const RUN_DEADLINE_MS = 120000;
export const MIN_ROWS = 5;

// Open the Upgrades tab and click Run. Returns { ok } or { error }.
export function startRunExpression() {
	return `(async () => {
		${WAIT_FOR}
		${OPEN_TAB}
		const runBtn = await waitFor(() => { const b = document.querySelector('[data-testid="upgrades-run-button"]'); return b && !b.disabled ? b : null; }, 60000);
		if (!runBtn) return { error: 'the Run button never became enabled' };
		runBtn.click();
		return { ok: true };
	})()`;
}

export const rowCountExpression = `document.querySelectorAll(${JSON.stringify(resultRowsSelector)}).length`;

// ---------------------------------------------------------------------------
// Recorded fixtures (ticket 504): a finished Ranking recorded from a real run
// in the main repo (data/tab-fixtures/). The page's loader exists only on the
// dev server and in builds made with TBC_TAB_FIXTURES=1.
// ---------------------------------------------------------------------------

export const PAGE_PATH_BY_SPEC = { ret: '/tbc/paladin/retribution/', feral: '/tbc/druid/feralcat/' };
export const FIXTURE_DEADLINE_MS = 30000;

export function pagePathFor(spec) {
	const p = PAGE_PATH_BY_SPEC[spec];
	if (!p) throw new Error(`no page path for fixture spec ${spec}`);
	return p;
}

// Open the Upgrades tab and load `fixtureJson` (the file's text) through
// window.__upgradesFixture. Returns the loader's { ok, rows } / { ok: false, reason } or { error }.
export function loadFixtureExpression(fixtureJson) {
	return `(async () => {
		${WAIT_FOR}
		${OPEN_TAB}
		const hook = await waitFor(() => typeof window.__upgradesFixture === 'function', 15000);
		if (!hook) return { error: 'window.__upgradesFixture is absent -- was dist built with TBC_TAB_FIXTURES=1?' };
		return await window.__upgradesFixture(${fixtureJson});
	})()`;
}

// A fixture load is settled when the results table has rows. Never wait for
// "Took": no run happened, so the timing it shows is not a run's.
export const fixtureSettledExpression = `(document.querySelectorAll(${JSON.stringify(resultRowsSelector)}).length >= 1)`;

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
	return { error: `fixture did not settle in ${FIXTURE_DEADLINE_MS / 1000}s` };
}

// Open the Upgrades tab and wait until its run card is laid out, without
// measuring anything. Returns { ok } or { error }.
export function activateTabExpression() {
	return `(async () => {
		${WAIT_FOR}
		${OPEN_TAB}
		const card = await waitFor(() => {
			const c = document.querySelector('[data-testid="upgrades-run-controls"]');
			return c && c.getBoundingClientRect().width > 0 ? c : null;
		}, 15000);
		if (!card) return { error: 'the Upgrades run card never became visible after opening the tab' };
		return { ok: true };
	})()`;
}

// ---------------------------------------------------------------------------
// Accessibility: axe-core in the page, and the baseline of accepted debt
// (data/wowsims-fork-a11y-baseline.json, passed as TBC_A11Y_BASELINE). Shared
// by test-layout.mjs and test-review.mjs.
// ---------------------------------------------------------------------------

let axeSource = null;

/** Runs axe on `scope` (a CSS selector) and returns `{ violations, ms }`, each node as `{ target, html }`. */
export async function axeRun(send, scope, tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']) {
	if (!(await evaluate(send, `typeof window.axe !== 'undefined'`))) {
		axeSource ??= fs.readFileSync(path.join(__dirname, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
		// The bundle's own value is large and unused; only its side effect, window.axe, is needed.
		await send('Runtime.evaluate', { expression: axeSource, returnByValue: false, awaitPromise: false });
	}
	const t0 = Date.now();
	const out = await evaluate(
		send,
		`(async () => {
			const scope = document.querySelector(${JSON.stringify(scope)});
			if (!scope) return { error: 'axe scope not found: ' + ${JSON.stringify(scope)} };
			const res = await window.axe.run(scope, { runOnly: { type: 'tag', values: ${JSON.stringify(tags)} }, resultTypes: ['violations'] });
			return { violations: res.violations.map(v => ({ id: v.id, impact: v.impact, tags: v.tags, helpUrl: v.helpUrl,
				nodes: v.nodes.map(n => ({ target: n.target, html: (n.html || '').slice(0, 300) })) })) };
		})()`,
	);
	if (out?.error) throw new Error(out.error);
	return { violations: out.violations, ms: Date.now() - t0 };
}

/** The baseline entries, `[]` without TBC_A11Y_BASELINE (strict). An unreadable file throws: a gate must not run strict by accident. */
export function readA11yBaseline() {
	const p = process.env.TBC_A11Y_BASELINE;
	if (!p) return [];
	const data = JSON.parse(fs.readFileSync(p, 'utf8'));
	return Array.isArray(data.entries) ? data.entries : [];
}

// A `match: "css"` entry's selector is a compound of `[attr="value"]` and
// `.class` parts, matched against the attributes of the node's HTML snippet
// (classification runs in Node, with no live DOM to call `matches` on).
const cssMatchesHtml = (selector, html) => {
	const open = /^<[^>]*>/.exec(html || '')?.[0] ?? '';
	const attr = name => new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1];
	const classes = new Set((attr('class') ?? '').split(/\s+/).filter(Boolean));
	const parts = selector.match(/\[[^\]]+\]|\.[\w-]+/g) ?? [];
	if (parts.length === 0) return false;
	return parts.every(part => {
		if (part.startsWith('.')) return classes.has(part.slice(1));
		const [, name, value] = /^\[([\w-]+)="([^"]*)"\]$/.exec(part) ?? [];
		return name !== undefined && attr(name) === value;
	});
};

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Splits axe violations into `fail` (critical or serious, a WCAG rule, not in
 * the baseline) and `warn` (everything else), each `{ id, selector, impact }`,
 * and returns the indices of the baseline entries that matched.
 */
export function a11yClassify(violations, baseline) {
	const fail = [];
	const warn = [];
	const matched = new Set();
	for (const v of violations) {
		for (const node of v.nodes) {
			const selector = node.target.join(' ');
			const finding = { id: v.id, selector, impact: v.impact ?? null };
			const entry = baseline.findIndex(e => e.ruleId === v.id && (e.match === 'css' ? cssMatchesHtml(e.selector, node.html) : e.selector === selector));
			if (entry >= 0) {
				matched.add(entry);
				warn.push({ ...finding, baselined: true });
			} else if ((v.impact === 'critical' || v.impact === 'serious') && v.tags.some(t => WCAG_TAGS.includes(t))) {
				fail.push(finding);
			} else {
				warn.push(finding);
			}
		}
	}
	return { fail, warn, matched };
}
