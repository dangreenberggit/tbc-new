// A DOM-geometry layout gate for the Upgrades tab (ticket 322).
//
// The five fork gates are all static (test:locales, lint:css, type-check,
// lint:js, fmt): none renders the page, so a layout regression -- an element
// past the viewport, a control group landing below the content it governs, a
// sticky rule dropping to static, a re-parented row losing its class's rules --
// passes every one of them. Ticket 321 (desktop-only mobile layout) was the
// second such defect in two stages. This gate renders the built page at three
// widths and asserts a handful of structural facts by measuring the live DOM.
//
// It drives an on-disk Chromium (Playwright's, already present) over raw CDP on
// Node 22's global WebSocket -- no puppeteer, no playwright, no jsdom, nothing
// added to package.json. The scout's probe proved ~40 lines of session plumbing
// is enough; that plumbing is `cdp()` below.
//
// The assertions are measured against the pre-run shell, which every viewport
// renders without a sim: the Upgrades tab builds its whole structure
// (settings card, view-controls host, sub-tab strip) in its constructor, so no
// WASM run is needed to see the layout the SCSS promises.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.join(__dirname, 'dist'); // http-server root: the app uses absolute /tbc/... paths
const OUT_DIR = path.join(OUT_ROOT, 'tbc');
const PAGE_PATH = '/tbc/paladin/retribution/'; // the scout's spec
const WIDTHS = [375, 768, 1280]; // 375 phone, 768 tablet, 1280 above xl=1200 where the grid is active
const HEIGHT = 900;
const OVERFLOW_TOL = 2; // px; sub-pixel rounding and scrollbar-less overflow slack

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

function findChromium() {
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

function run(cmd, args, label) {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd: __dirname, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function build() {
	if (!fs.existsSync(path.join(OUT_DIR, 'lib.wasm')))
		throw new Error(`dist/tbc/lib.wasm is missing -- run \`make host\` once to produce the WASM/assets this gate builds the bundle on top of`);
	if (!fs.existsSync(path.join(OUT_DIR, 'assets')))
		throw new Error(`dist/tbc/assets is missing -- run \`make host\` once to produce the assets the page loads`);

	console.log('building bundle (tsc --noEmit)...');
	await run('node', ['node_modules/typescript/bin/tsc', '--noEmit'], 'tsc');
	console.log('building bundle (workers)...');
	await run('npx', ['tsx', 'vite.build-workers.mts'], 'vite.build-workers');
	console.log('building bundle (vite build)...');
	await run('npx', ['vite', 'build'], 'vite build');
	if (!fs.existsSync(path.join(OUT_DIR, 'lib.wasm'))) throw new Error('vite build emptied dist/tbc/lib.wasm -- expected it to be left in place');
	console.log('bundle built.');
}

// ---------------------------------------------------------------------------
// http-server: serve dist/ (the fork's already-present dependency).
// ---------------------------------------------------------------------------

async function startServer() {
	const port = await freePort();
	const p = spawn('npx', ['http-server', OUT_ROOT, '-p', String(port), '-a', '127.0.0.1', '--silent', '-c-1'], {
		cwd: __dirname,
		shell: true,
		stdio: 'ignore',
	});
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

async function launchChrome() {
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
		proc.kill();
		throw new Error('Chromium CDP endpoint did not come up');
	}
	return { proc, port, wsUrl, userDataDir };
}

// A minimal CDP client: send(method, params) -> result, with event waiting.
function cdp(wsUrl) {
	const ws = new WebSocket(wsUrl);
	let nextId = 1;
	const pending = new Map();
	const listeners = new Set();
	ws.addEventListener('message', ev => {
		const msg = JSON.parse(ev.data);
		if (msg.id != null && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.params ?? {})})`));
			else resolve(msg.result);
		} else if (msg.method) {
			for (const l of listeners) l(msg);
		}
	});
	const ready = new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', () => reject(new Error('CDP WebSocket error')), { once: true });
	});
	function send(method, params = {}, sessionId) {
		const id = nextId++;
		const payload = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
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
async function attachPage(client) {
	const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
	const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
	const send = (method, params) => client.send(method, params, sessionId);
	await send('Page.enable', {});
	await send('Runtime.enable', {});
	return { send, targetId };
}

// Evaluate an expression in the page and return its JSON value.
async function evaluate(send, expression) {
	const { result, exceptionDetails } = await send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (exceptionDetails) throw new Error(`page eval threw: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
	return result.value;
}

// ---------------------------------------------------------------------------
// The assertions.
//
// Each returns { ok, msg }. `msg` names the width, the selector, and
// expected/actual so a failure reads without opening the page. Every selector
// below is mapped to a real class in the current DOM (upgrades_tab.tsx and
// _upgrades_tab.scss / _sim_tab.scss), not a guessed one.
// ---------------------------------------------------------------------------

// The page-side probe: activate the Upgrades tab, wait for its shell, then
// measure everything the five assertions need in one call. Returns a plain
// object (or an {error} object) so all measurement lives in one round trip.
function probeExpression(width) {
	return `(async () => {
		const q = sel => document.querySelector(sel);
		const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height }; };
		const waitFor = async (fn, ms) => {
			const end = Date.now() + ms;
			while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); }
			return fn();
		};

		// Activate the Upgrades top-level sim tab. It is a Bootstrap tab:
		// button[data-bs-target="#upgrades-tab"]. Clicking it toggles the pane
		// from display:none to active/show. Wait for the nav button first (the
		// app boots asynchronously), then for the pane's shell to be laid out.
		const navBtn = await waitFor(() => document.querySelector('button[data-bs-target="#upgrades-tab"]'), 30000);
		if (!navBtn) return { error: 'upgrades-tab nav button never appeared (app did not boot?)' };
		navBtn.click();

		const host = await waitFor(() => {
			const h = document.querySelector('#upgrades-tab .upgrades-view-controls-host');
			if (!h) return null;
			const r = h.getBoundingClientRect();
			// Visible == pane activated and laid out (non-zero box or at least positioned).
			return (h.offsetParent !== null || r.width > 0) ? h : null;
		}, 15000);
		if (!host) return { error: 'upgrades-view-controls-host never became visible after activating the tab' };

		const pane = q('#upgrades-tab');
		const paneStyle = getComputedStyle(pane);

		// Elements to scan for overflow: everything inside the active pane.
		const all = [...pane.querySelectorAll('*')];
		let worst = null;
		for (const el of all) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue; // ignore collapsed/hidden boxes
			if (worst === null || r.right > worst.right) {
				worst = { right: r.right, cls: el.className && el.className.toString().slice(0, 80), tag: el.tagName };
			}
		}

		const tabs = q('#upgrades-tab .upgrades-tab-tabs');
		const tabLeft = q('#upgrades-tab .upgrades-tab-left');
		const tabRight = q('#upgrades-tab .upgrades-tab-right');
		const settingsOuter = q('#upgrades-tab .upgrades-settings-outer-container');
		const viewControls = q('#upgrades-tab .upgrades-view-controls-host');

		const hostStyle = getComputedStyle(host);
		const leftStyle = tabLeft ? getComputedStyle(tabLeft) : null;
		const outerStyle = settingsOuter ? getComputedStyle(settingsOuter) : null;

		return {
			innerWidth: window.innerWidth,
			worstRight: worst,
			host: rect(host),
			tabs: tabs ? rect(tabs) : null,
			tabLeft: tabLeft ? rect(tabLeft) : null,
			tabRight: tabRight ? rect(tabRight) : null,
			settingsOuterPosition: outerStyle ? outerStyle.position : null,
			hostAlignSelf: hostStyle.alignSelf,
			hostGridColumnStart: hostStyle.gridColumnStart,
			hostGridColumnEnd: hostStyle.gridColumnEnd,
			hostWidth: host.getBoundingClientRect().width,
			leftGridTemplateRows: leftStyle ? leftStyle.gridTemplateRows : null,
			leftDisplay: leftStyle ? leftStyle.display : null,
			tabsWidth: tabs ? tabs.getBoundingClientRect().width : null,
		};
	})()`;
}

function assertAll(width, m) {
	const results = [];

	// 1. No element extends past the viewport.
	// Scans every rendered box in the active pane for right > innerWidth. This
	// is the guard for the whole class of "renders too wide" defects (a control
	// clipping, a table growing past its column panel) at every tested width.
	{
		const past = m.worstRight ? m.worstRight.right - m.innerWidth : -Infinity;
		const ok = past <= OVERFLOW_TOL;
		results.push({
			ok,
			msg: ok
				? `[${width}] no overflow: widest right ${m.worstRight?.right?.toFixed(1)} <= innerWidth ${m.innerWidth} (+${OVERFLOW_TOL} tol)`
				: `[${width}] overflow: <${m.worstRight.tag}.${m.worstRight.cls}> right ${m.worstRight.right.toFixed(1)} > innerWidth ${m.innerWidth} by ${past.toFixed(1)}px`,
		});
	}

	// 2. Named control groups render ABOVE the content they govern.
	// The view-controls host filters the rows in the sub-tab area, so it must
	// sit above `.upgrades-tab-tabs`. At <xl the run/settings panel
	// (`.upgrades-tab-right`, order:-1) must also render above the results panel
	// (`.upgrades-tab-left`). Below xl the two panels stack; at 1280 they sit
	// side by side, so that half of the check only applies at the narrow widths.
	{
		const ok = m.tabs && m.host.top <= m.tabs.top + 1;
		results.push({
			ok,
			msg: ok
				? `[${width}] view-controls-host top ${m.host.top.toFixed(1)} <= tabs top ${m.tabs?.top?.toFixed(1)} (controls above content)`
				: `[${width}] view-controls-host top ${m.host.top.toFixed(1)} is BELOW tabs top ${m.tabs?.top?.toFixed(1)} -- filters landed under the content they govern`,
		});
		if (width < 1200) {
			const okPanel = m.tabRight && m.tabLeft && m.tabRight.top <= m.tabLeft.top + 1;
			results.push({
				ok: okPanel,
				msg: okPanel
					? `[${width}] settings panel top ${m.tabRight?.top?.toFixed(1)} <= results panel top ${m.tabLeft?.top?.toFixed(1)} (run controls above results)`
					: `[${width}] settings panel top ${m.tabRight?.top?.toFixed(1)} is BELOW results panel top ${m.tabLeft?.top?.toFixed(1)} -- ticket 321 regression`,
			});
		}
	}

	// 3. A must-stay-reachable control is pinned (sticky, not dropped to static).
	// `.upgrades-settings-outer-container` carries `position: sticky` so Run
	// stays on screen while the results scroll. If a change silently drops it to
	// `static` (the failure mode this ticket names), Run scrolls away. Computed
	// `position` is the honest read.
	{
		const ok = m.settingsOuterPosition === 'sticky';
		results.push({
			ok,
			msg: ok
				? `[${width}] settings-outer-container position: sticky (Run stays reachable)`
				: `[${width}] settings-outer-container position: ${m.settingsOuterPosition} -- expected sticky; the run panel would scroll away`,
		});
	}

	// 4. An anti-jitter element still reserves its height.
	// `.upgrades-view-controls-host` is `align-self: start` so it sizes to its
	// own content instead of stretching to the grid row and growing ~50px when a
	// run reveals the filters (ticket 304 item 5). And `.upgrades-tab-left`
	// carries `grid-template-rows: max-content auto` so the filter row's height
	// is pinned. Below lg the left panel is `display: flex` and the grid rows
	// are inert by design, so the grid-rows half of this check only applies at
	// >=lg (768 is below lg=992; 1280 is above).
	{
		const okAlign = m.hostAlignSelf === 'start' || m.hostAlignSelf === 'flex-start';
		results.push({
			ok: okAlign,
			msg: okAlign
				? `[${width}] view-controls-host align-self: ${m.hostAlignSelf} (height reserved, no first-paint jump)`
				: `[${width}] view-controls-host align-self: ${m.hostAlignSelf} -- expected start; the host would grow with the row on first run`,
		});
		if (width >= 992) {
			const rows = (m.leftGridTemplateRows || '').trim();
			// Two tracks: max-content resolves to a px value, auto to the rest.
			// The observable promise is exactly two tracks on a grid display.
			const okRows = m.leftDisplay === 'grid' && rows.split(/\s+/).length === 2 && rows !== 'none';
			results.push({
				ok: okRows,
				msg: okRows
					? `[${width}] tab-left grid-template-rows: "${rows}" (two tracks: filter row pinned, sub-tabs take the rest)`
					: `[${width}] tab-left display:${m.leftDisplay} grid-template-rows:"${rows}" -- expected a 2-track grid pinning the filter row`,
			});
		}
	}

	// 5. A re-parented row still computes its class's promised layout props.
	// `.upgrades-view-controls-host` was moved into `.tab-panel-left`
	// (`display: grid; auto-fit minmax(220px,1fr)`) and carries
	// `grid-column: 1 / -1` (F11) so it spans every column as a full-width band
	// above the sub-tabs. With `auto-fit` opening a second column at >=lg, a
	// dropped span would put the filters BESIDE the sub-tab area. This is inert
	// below lg (the panel is flex there), so it is asserted only at 1280: the
	// host must span the full panel width, i.e. match the sub-tabs' width.
	if (width >= 992) {
		const spans = m.hostGridColumnStart === '1' && (m.hostGridColumnEnd === '-1' || m.hostGridColumnEnd.includes('-1'));
		// Width parity is the observable consequence: a full-span band is as wide
		// as the sub-tab area beneath it. Allow 1px rounding.
		const widthMatch = m.tabsWidth != null && Math.abs(m.hostWidth - m.tabsWidth) <= 1;
		const ok = spans || widthMatch;
		results.push({
			ok,
			msg: ok
				? `[${width}] view-controls-host spans full width (grid-column ${m.hostGridColumnStart}/${m.hostGridColumnEnd}, width ${m.hostWidth.toFixed(1)} == tabs ${m.tabsWidth?.toFixed(1)})`
				: `[${width}] view-controls-host did NOT span: grid-column ${m.hostGridColumnStart}/${m.hostGridColumnEnd}, width ${m.hostWidth.toFixed(1)} vs tabs ${m.tabsWidth?.toFixed(1)} -- F11 containment dropped, filters sit beside the sub-tabs`,
		});
	}

	return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	await build();

	const server = await startServer();
	console.log(`serving dist on http://127.0.0.1:${server.port}`);

	const chrome = await launchChrome();
	console.log(`chromium CDP up on ${chrome.port}`);
	const client = cdp(chrome.wsUrl);
	await client.ready;

	const failures = [];
	const passes = [];

	try {
		for (const width of WIDTHS) {
			const { send } = await attachPage(client);
			await send('Emulation.setDeviceMetricsOverride', {
				width,
				height: HEIGHT,
				deviceScaleFactor: 1,
				mobile: false,
			});
			const url = `http://127.0.0.1:${server.port}${PAGE_PATH}`;
			await send('Page.navigate', { url });
			// Give the app a moment past DOMContentLoaded; the probe itself waits
			// for the nav button and shell, so this is just breathing room.
			await sleep(300);

			const m = await evaluate(send, probeExpression(width));
			if (m && m.error) {
				failures.push(`[${width}] PROBE FAILED: ${m.error}`);
				continue;
			}
			const results = assertAll(width, m);
			for (const r of results) {
				if (r.ok) passes.push(r.msg);
				else failures.push(r.msg);
			}
		}
	} finally {
		client.close();
		chrome.proc.kill();
		server.proc.kill();
		try {
			await fsp.rm(chrome.userDataDir, { recursive: true, force: true });
		} catch {
			// best-effort temp cleanup
		}
	}

	console.log('\n--- passed ---');
	for (const p of passes) console.log('  PASS ' + p);

	if (failures.length) {
		console.log('\n--- FAILED ---');
		for (const f of failures) console.log('  FAIL ' + f);
		console.error(`\nlayout gate: ${failures.length} failure(s) across widths ${WIDTHS.join(', ')}`);
		process.exit(1);
	}

	console.log(`\nlayout gate: OK -- ${passes.length} assertion(s) passed at widths ${WIDTHS.join(', ')}`);
	process.exit(0);
}

main().catch(err => {
	console.error('layout gate crashed:', err.stack || err.message);
	process.exit(1);
});
