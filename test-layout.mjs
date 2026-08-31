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
const WIDTHS = [375, 653, 768, 1280]; // 375 phone, 653 narrow (covers the sub-768 legibility band), 768 tablet, 1280 above xl=1200 where the grid is active
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

		// A horizontal scroller is meant to hold content wider than itself, so
		// its descendants' right edges say nothing about page overflow -- the
		// scroller's OWN right edge is what must stay inside the viewport.
		// getBoundingClientRect ignores ancestor overflow clipping, so without
		// this the ~424px table inside a ~319px overflow-x:auto .upgrades-results
		// at 375px would trip assertion #1 (ticket 327/329 F2). Walk up to the
		// pane looking for a computed overflow-x of auto/scroll; an element inside
		// one is exempt from the viewport scan.
		const isScrollerX = el => { const ox = getComputedStyle(el).overflowX; return ox === 'auto' || ox === 'scroll'; };
		const hasScrollableAncestor = el => {
			let p = el.parentElement;
			while (p && p !== pane) { if (isScrollerX(p)) return true; p = p.parentElement; }
			return false;
		};

		// Elements to scan for overflow: everything inside the active pane, minus
		// descendants of a sanctioned horizontal scroller. Each scroller itself
		// stays in the scan (its own box), so its right edge is still checked
		// against the viewport.
		const all = [...pane.querySelectorAll('*')];
		let worst = null;
		for (const el of all) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue; // ignore collapsed/hidden boxes
			if (hasScrollableAncestor(el)) continue; // exempt: inside a sanctioned scroller
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
			leftGridTemplateColumns: leftStyle ? leftStyle.gridTemplateColumns : null,
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
		// Ticket 326: the `|| widthMatch` fallback is an escape hatch when the
		// panel resolves to ONE column -- then the host and the sub-tabs are both
		// full-width whether or not `grid-column: 1 / -1` is present, so a dropped
		// span would still pass `widthMatch` and the gate would silently stop
		// testing the span. So the span is now the primary assertion, and
		// `widthMatch` is admitted as a proxy ONLY when the panel genuinely has
		// >=2 tracks -- the two-column layout the span exists to survive, where a
		// dropped span really would narrow the host and break parity. `auto-fit
		// minmax(220px,1fr)` collapses to one track when the panel is too narrow;
		// counting the resolved `grid-template-columns` tracks is the honest read.
		const trackCount = (m.leftGridTemplateColumns || '')
			.trim()
			.split(/\s+/)
			.filter(t => t && t !== 'none').length;
		const twoPlusColumns = m.leftDisplay === 'grid' && trackCount >= 2;
		const ok = spans || (twoPlusColumns && widthMatch);
		results.push({
			ok,
			msg: ok
				? `[${width}] view-controls-host spans full width (grid-column ${m.hostGridColumnStart}/${m.hostGridColumnEnd}${spans ? '' : `, via width parity on ${trackCount} tracks`}, width ${m.hostWidth.toFixed(1)} == tabs ${m.tabsWidth?.toFixed(1)})`
				: `[${width}] view-controls-host did NOT span: grid-column ${m.hostGridColumnStart}/${m.hostGridColumnEnd}, width ${m.hostWidth.toFixed(1)} vs tabs ${m.tabsWidth?.toFixed(1)}, ${trackCount} column track(s) -- F11 containment dropped, filters sit beside the sub-tabs (width parity is not accepted as a proxy at <2 tracks -- ticket 326)`,
		});
	}

	return results;
}

// ---------------------------------------------------------------------------
// The run phase (ticket 329).
//
// The five assertions above measure the pre-run shell. The legibility
// assertions the owner asked for target the results table, which does not
// exist until a run lands rows. So this phase drives a real headless WASM run
// -- the gate's own Chromium runs the sim with no Go backend (probed feasible:
// 5 rows in ~42s) -- then measures the landed cells. The sim runs ONCE, on one
// page at 653px; the widths are re-emulated on that same page (rows survive a
// device-metrics change without reload -- verified), so the ~40s cost is paid
// a single time.
// ---------------------------------------------------------------------------

const RUN_WIDTH = 653; // narrow enough to reproduce the sub-md legibility defect
const RUN_DEADLINE_MS = 120000; // ~3x the measured 42s to first 5 rows
const MIN_ROWS = 5;
const LINE_MULTIPLE_ONE_LINE = 1.5; // content height <= 1.5x line-height == one line
// A tbody row's height is set by its tallest cell, not by the Slot/DPS text:
// the Item cell carries a 1.5rem icon and its item name is content-sized with
// no nowrap, so a long name ("Shoulderbraces") legitimately wraps to 2-3 lines
// -- the design allows Item/Source to wrap, and only Slot/DPS must stay on one
// line (assertion 6). Legitimate one-line-Slot/DPS rows measure up to ~84px
// here (~4.8x the 17.5px line-height). This ceiling is a gross-shatter backstop
// -- a per-character Slot/DPS stack would blow the row far past it -- set above
// the measured legitimate maximum with headroom, not at the Slot/DPS line count
// (that is what assertion 6 asserts, on the cells directly).
const LINE_MULTIPLE_ROW = 7; // a tbody row <= 7x line-height (icon + wrapped item name)
const CLIP_TOL = 2; // px slack for scroll/clientWidth comparison

// Activate the Upgrades tab and click Run. Returns { ok } or { error }.
function startRunExpression() {
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
const rowCountExpression = `document.querySelectorAll('.upgrades-results-table tbody tr').length`;

// Measure the first MIN_ROWS rows' Slot (col 3) and DPS (col 4) cells plus the
// scroller state, at the current emulated width. Returns a plain object so all
// measurement is one round trip.
function legibilityProbeExpression() {
	return `(() => {
		const table = document.querySelector('.upgrades-results-table');
		if (!table) return { error: 'no results table' };
		const wrap = document.querySelector('.upgrades-results');
		const rows = [...table.querySelectorAll('tbody tr')].slice(0, ${MIN_ROWS});
		if (rows.length < ${MIN_ROWS}) return { error: 'only ' + rows.length + ' rows' };
		// Content height of a cell, independent of its vertical padding: measured
		// from a range over the cell's contents, so a genuine one-line cell with
		// tall padding is not counted as multi-line.
		const contentHeight = td => {
			const range = document.createRange();
			range.selectNodeContents(td);
			const r = range.getBoundingClientRect();
			range.detach && range.detach();
			return r.height;
		};
		const lineHeightPx = td => {
			const s = getComputedStyle(td);
			let lh = parseFloat(s.lineHeight);
			if (!isFinite(lh)) lh = parseFloat(s.fontSize) * 1.2; // 'normal' fallback
			return lh;
		};
		// An ancestor (up to the pane) that hides overflow -- used to decide
		// whether a clipped cell is actually invisible to the reader.
		const pane = document.querySelector('#upgrades-tab');
		const hidesOverflow = el => {
			let p = el.parentElement;
			while (p && p !== pane) {
				const ox = getComputedStyle(p).overflowX, oy = getComputedStyle(p).overflowY;
				if (ox === 'hidden' || oy === 'hidden' || ox === 'clip' || oy === 'clip') return true;
				p = p.parentElement;
			}
			return false;
		};
		const cellInfo = td => ({
			text: td.innerText,
			contentH: contentHeight(td),
			lh: lineHeightPx(td),
			scrollW: td.scrollWidth,
			clientW: td.clientWidth,
			scrollH: td.scrollHeight,
			clientH: td.clientHeight,
			hidden: hidesOverflow(td),
		});
		const rowRects = rows.map(tr => { const r = tr.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });
		const bodyLh = lineHeightPx(rows[0].querySelector('td:nth-child(4)') || rows[0]);
		const slotCells = rows.map(tr => cellInfo(tr.querySelector('td:nth-child(3)')));
		const dpsCells = rows.map(tr => cellInfo(tr.querySelector('td:nth-child(4)')));
		// Every rendered cell in the sampled rows, for the clip check.
		const allCells = rows.flatMap(tr => [...tr.querySelectorAll('td')].map(cellInfo));
		const wrapInfo = wrap ? (() => { const s = getComputedStyle(wrap); return { overflowX: s.overflowX, clientW: wrap.clientWidth, scrollW: wrap.scrollWidth, tableScrollW: table.scrollWidth }; })() : null;
		return { innerWidth: window.innerWidth, bodyLh, rowRects, slotCells, dpsCells, allCells, wrapInfo };
	})()`;
}

// Legibility assertions (6),(7),(8) at one width, on the landed rows.
function assertLegibility(width, m) {
	const results = [];
	if (m.error) {
		results.push({ ok: false, msg: `[${width}] legibility PROBE FAILED: ${m.error}` });
		return results;
	}
	const lh = m.bodyLh;

	// (6) One-line Slot and DPS cells. Both are `white-space: nowrap` after the
	// step-1 SCSS, so one line is exactly what the CSS promises. Content height
	// (padding excluded) <= 1.5x line-height catches the owner's 2-line "+58.7
	// DPS" break, which a looser 2x bound would false-pass.
	{
		const cells = [...m.slotCells.map(c => ({ ...c, col: 'Slot' })), ...m.dpsCells.map(c => ({ ...c, col: 'DPS' }))];
		const bad = cells.find(c => c.contentH > c.lh * LINE_MULTIPLE_ONE_LINE + 0.5);
		const ok = !bad;
		results.push({
			ok,
			msg: ok
				? `[${width}] one-line cells: all Slot/DPS content heights <= ${LINE_MULTIPLE_ONE_LINE}x line-height (${lh.toFixed(1)}px)`
				: `[${width}] ${bad.col} cell "${bad.text}" content height ${bad.contentH.toFixed(1)} > ${LINE_MULTIPLE_ONE_LINE}x line-height ${bad.lh.toFixed(1)} -- text wrapped to multiple lines`,
		});
	}

	// (7) No clipped text. A cell whose content overflows its box WHILE an
	// ancestor hides overflow is invisible text -- fail. The sanctioned
	// `.upgrades-results` scroller is exempt (it is overflow-x:auto, not hidden)
	// and is instead required to be scrollable when the table is wider than it.
	{
		const clipped = m.allCells.find(c => c.hidden && (c.scrollW > c.clientW + CLIP_TOL || c.scrollH > c.clientH + CLIP_TOL));
		const ok = !clipped;
		results.push({
			ok,
			msg: ok
				? `[${width}] no clipped text: no cell overflows its box under an overflow-hidden ancestor`
				: `[${width}] clipped cell "${clipped.text}" scroll ${clipped.scrollW}x${clipped.scrollH} > client ${clipped.clientW}x${clipped.clientH} under a hidden-overflow ancestor`,
		});
	}
	// (7b) When the table is wider than the scroller, the scroller must actually
	// scroll (overflow-x auto/scroll), not clip.
	if (m.wrapInfo) {
		const needsScroll = m.wrapInfo.tableScrollW > m.wrapInfo.clientW + CLIP_TOL;
		const scrolls = m.wrapInfo.overflowX === 'auto' || m.wrapInfo.overflowX === 'scroll';
		const ok = !needsScroll || scrolls;
		results.push({
			ok,
			msg: ok
				? `[${width}] scroller ok: table ${m.wrapInfo.tableScrollW} vs wrap ${m.wrapInfo.clientW}, overflow-x ${m.wrapInfo.overflowX}`
				: `[${width}] table (${m.wrapInfo.tableScrollW}px) wider than .upgrades-results (${m.wrapInfo.clientW}px) but overflow-x is ${m.wrapInfo.overflowX} -- content clips instead of scrolling`,
		});
	}

	// (8) Row spacing: each measured row <= 4x line-height, and no gap between
	// consecutive rows (rects touch, <= 2px).
	{
		const tallRow = m.rowRects.find(r => r.height > lh * LINE_MULTIPLE_ROW + 0.5);
		let bigGap = null;
		for (let i = 1; i < m.rowRects.length; i++) {
			const gap = m.rowRects[i].top - m.rowRects[i - 1].bottom;
			if (Math.abs(gap) > 2) { bigGap = { i, gap }; break; }
		}
		const ok = !tallRow && !bigGap;
		results.push({
			ok,
			msg: ok
				? `[${width}] row spacing: all rows <= ${LINE_MULTIPLE_ROW}x line-height, consecutive rows adjacent`
				: tallRow
					? `[${width}] tbody row height ${tallRow.height.toFixed(1)} > ${LINE_MULTIPLE_ROW}x line-height ${lh.toFixed(1)}`
					: `[${width}] gap ${bigGap.gap.toFixed(1)}px between rows ${bigGap.i - 1} and ${bigGap.i} (expected adjacent)`,
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

		// Run phase: one real WASM run at RUN_WIDTH, then re-emulate each width
		// on the same page and measure the landed cells for legibility.
		{
			const { send } = await attachPage(client);
			await send('Emulation.setDeviceMetricsOverride', { width: RUN_WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
			await send('Page.navigate', { url: `http://127.0.0.1:${server.port}${PAGE_PATH}` });
			await sleep(300);

			const started = await evaluate(send, startRunExpression());
			if (started && started.error) {
				failures.push(`[run] PROBE FAILED: ${started.error}`);
			} else {
				console.log('run started; polling for rows...');
				const deadline = Date.now() + RUN_DEADLINE_MS;
				const t0 = Date.now();
				let rows = 0;
				while (Date.now() < deadline) {
					rows = await evaluate(send, rowCountExpression);
					if (rows >= MIN_ROWS) break;
					await sleep(1000);
				}
				const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
				if (rows < MIN_ROWS) {
					failures.push(`[run] only ${rows} rows after ${elapsed}s (deadline ${RUN_DEADLINE_MS / 1000}s) -- expected >= ${MIN_ROWS}`);
				} else {
					console.log(`run produced ${rows} rows in ${elapsed}s; measuring legibility across widths...`);
					for (const width of WIDTHS) {
						await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
						await sleep(200);
						const lm = await evaluate(send, legibilityProbeExpression());
						const lresults = assertLegibility(width, lm);
						for (const r of lresults) {
							if (r.ok) passes.push(r.msg);
							else failures.push(r.msg);
						}
					}
				}
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
