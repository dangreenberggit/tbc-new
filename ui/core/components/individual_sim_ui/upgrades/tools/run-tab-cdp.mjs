// Durable CDP harness for the upgrades tab, promoted from Chunk 1's throwaway
// ret-p5-run.mjs. It drives a full or capped ret run against ANY origin the
// caller already serves (the WASM page under http-server, or the packaged
// desktop binary on :3333) and writes a readback JSON that records what the tab
// actually did rather than what the origin implies:
//
//   - runner       the runner class the tab chose (data-runner attribute, S1)
//   - requests     completed 200 sim responses per endpoint, summed over the
//                  page session AND every auto-attached worker session (S2) —
//                  every /bulkSimAsync and /raidSimAsync fetch is issued inside
//                  a dedicated Web Worker, its own CDP target, so page-session
//                  Network.enable alone sees none of it
//   - servedWorker the body the origin serves at sim_worker.js (S3)
//   - screeningFallbackWarnings  count of "[upgrades] screening fell back" (S4)
//
// The caller owns the server; this harness owns only the browser. See the
// desktop-transport-gate stage plan for the four signals and the gate that
// judges them (scripts/check_desktop_tab.py). Node 22+ only (global WebSocket
// and fetch, no npm deps).
//
// Usage:
//   node run-tab-cdp.mjs --origin http://localhost:3333 [--page /tbc/paladin/retribution/]
//        [--phase 5] [--candidates N] [--iterations N] [--timeout-ms 2700000]
//        [--out out.json] [--force-fallback] [--bulk-http]
//        [--preset-tab <name> --preset <chip|?>] [--wasm-concurrency N]
//        [--capture-requests <dir> [--page-sim]]
//
// --bulk-http sets the `upgradesTab.runner` localStorage key before navigation so
//   the tab selects the Go bulk runner (ticket 411 measurement only; the default
//   is the per-candidate loop). Readback: bulkHttpRequested.
// --iterations N sets the iterations NumberPicker at click time (default 3000).
//   Readback: iterationsRequested. Two timings are always recorded: firstRowS
//   (Run click to the first results-table row) and clickToDoneS (click to Took).
//
// The flags below exist for ticket 522's cold-worker check: does the tab's
// baseline sim get exactly the page's own Simulate DPS for the same gear? None
// of them changes the default path, which pnpm desktop-gate:check drives.
// --preset-tab <name> --preset <chip> loads a Gear Sets preset before the
//   Upgrades tab opens; the picker lives in the Gear tab, whose chips are hidden
//   once another tab is active. --preset "?" lists the chips of that phase tab
//   (or of every tab with --preset-tab "?") and exits 1 before any sim.
// --wasm-concurrency N sets the page's wasm worker count before navigation; at 1
//   the page does not split its sim, and a split run gives different floats.
// --capture-requests <dir> records every WorkerPool.raidSimAsync request and its
//   exact result DPS; the first tab-phase call is the tab's baseline.
// --page-sim (needs --capture-requests) then runs the page's own Simulate at the
//   tab's seed and iterations, replays that request once on the tab's pool, and
//   compares requests and exact DPS (requestCheck, dpsDiff, replayEqual).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WIDTH = 1280;
const HEIGHT = 1400;

function parseArgs(argv) {
	const args = {
		origin: null,
		page: '/tbc/paladin/retribution/',
		phase: 5,
		candidates: 0, // 0 = uncapped
		iterations: 0, // 0 = leave the picker at its default (3000)
		timeoutMs: 2700000,
		out: null,
		forceFallback: false,
		bulkHttp: false,
		presetTab: null,
		preset: null,
		wasmConcurrency: null,
		captureRequests: null,
		pageSim: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--origin') args.origin = argv[++i];
		else if (a === '--page') args.page = argv[++i];
		else if (a === '--phase') args.phase = parseInt(argv[++i], 10);
		else if (a === '--candidates') args.candidates = parseInt(argv[++i], 10);
		else if (a === '--iterations') args.iterations = parseInt(argv[++i], 10);
		else if (a === '--timeout-ms') args.timeoutMs = parseInt(argv[++i], 10);
		else if (a === '--out') args.out = argv[++i];
		else if (a === '--force-fallback') args.forceFallback = true;
		else if (a === '--bulk-http') args.bulkHttp = true;
		else if (a === '--preset-tab') args.presetTab = argv[++i];
		else if (a === '--preset') args.preset = argv[++i];
		else if (a === '--wasm-concurrency') args.wasmConcurrency = parseInt(argv[++i], 10);
		else if (a === '--capture-requests') args.captureRequests = argv[++i];
		else if (a === '--page-sim') args.pageSim = true;
		else {
			throw new Error(`unknown arg: ${a}`);
		}
	}
	if (!args.origin) throw new Error('--origin <url> is required');
	if ((args.presetTab === null) !== (args.preset === null)) throw new Error('--preset-tab and --preset go together');
	if (args.presetTab === '?' && args.preset !== '?') throw new Error('--preset-tab "?" needs --preset "?"');
	if (args.wasmConcurrency !== null && !(args.wasmConcurrency >= 1)) throw new Error('--wasm-concurrency needs a positive integer');
	if (args.pageSim && !args.captureRequests) throw new Error('--page-sim needs --capture-requests <dir>');
	args.origin = args.origin.replace(/\/+$/, '');
	return args;
}

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
	const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
	for (const dir of fs.readdirSync(base)) {
		if (!dir.startsWith('chromium-')) continue;
		const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
		if (fs.existsSync(exe)) return exe;
	}
	throw new Error('no chromium under ms-playwright');
}

async function launchChrome() {
	const port = await freePort();
	const exe = findChromium();
	const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tbc-tabcdp-'));
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
	const deadline = Date.now() + 20000;
	let wsUrl;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) {
				wsUrl = (await res.json()).webSocketDebuggerUrl;
				if (wsUrl) break;
			}
		} catch {}
		await sleep(150);
	}
	if (!wsUrl) {
		proc.kill();
		throw new Error('cdp timeout');
	}
	return { proc, wsUrl, userDataDir };
}

// Flat-protocol CDP client. Every message has a `sessionId` on its
// envelope (Target.setAutoAttach {flatten:true}); replies are matched by `id`
// as before, but id-less events are dispatched to listeners registered per
// (sessionId, method). The sim POSTs live on worker sessions, not the page
// session, so the harness must route by sessionId to see them at all (C25).
function cdp(wsUrl) {
	const ws = new WebSocket(wsUrl);
	let nextId = 1;
	const pending = new Map();
	// key `${sessionId||'@page'}::${method}` and `*::${method}` -> Set<fn>
	const listeners = new Map();
	function keyFor(sid, method) {
		return `${sid || '@page'}::${method}`;
	}
	function on(sid, method, fn) {
		const k = sid === '*' ? `*::${method}` : keyFor(sid, method);
		if (!listeners.has(k)) listeners.set(k, new Set());
		listeners.get(k).add(fn);
	}
	ws.addEventListener('message', ev => {
		const msg = JSON.parse(ev.data);
		if (msg.id != null && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message));
			else resolve(msg.result);
			return;
		}
		if (msg.method) {
			const sid = msg.sessionId;
			for (const k of [keyFor(sid, msg.method), `*::${msg.method}`]) {
				const set = listeners.get(k);
				if (set) for (const fn of set) fn(msg.params, sid);
			}
		}
	});
	const ready = new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
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
	return { ready, send, on, close: () => ws.close() };
}

async function evaluate(send, sessionId, expression) {
	const { result, exceptionDetails } = await send(
		'Runtime.evaluate',
		{ expression, returnByValue: true, awaitPromise: true },
		sessionId,
	);
	if (exceptionDetails) {
		throw new Error(`eval: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
	}
	return result.value;
}

// --- page scripts (unchanged from ret-p5-run.mjs except where noted) ---

const activate = `(async () => {
	const wf = async (fn,ms)=>{const e=Date.now()+ms;while(Date.now()<e){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}return fn();};
	const nav = await wf(()=>document.querySelector('button[data-bs-target="#upgrades-tab"]'),30000);
	if(!nav) return {error:'no nav'};
	nav.click();
	const host = await wf(()=>{const h=document.querySelector('#upgrades-tab .upgrades-view-controls-host');return h&&(h.offsetParent!==null||h.getBoundingClientRect().width>0)?h:null;},15000);
	if(!host) return {error:'no host'};
	return {ok:true};
})()`;

// Set the phase selector. Same mechanism as ret-p5-run.mjs, parameterised.
const setPhase = phase => `(async () => {
	const wf = async (fn,ms)=>{const e=Date.now()+ms;while(Date.now()<e){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}return fn();};
	const summary = await wf(()=>document.querySelector('.upgrades-run-settings-summary'),15000);
	if(!summary) return {error:'no run-settings summary'};
	if(summary.getAttribute('aria-expanded') !== 'true') summary.click();
	await new Promise(r=>setTimeout(r,400));
	const sel = await wf(()=>document.querySelector('#phase-selector'),15000);
	if(!sel) return {error:'no #phase-selector'};
	const before = sel.value;
	const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
	nativeSetter.call(sel,'${phase}');
	sel.dispatchEvent(new Event('change',{bubbles:true}));
	await new Promise(r=>setTimeout(r,1500));
	const settled = document.querySelector('#phase-selector').value;
	if (settled !== '${phase}') return {error:'phase did not stick: before='+before+' settled='+settled};
	return {ok:true, phaseSet: settled, phaseBefore: before};
})()`;

// Set the Candidates NumberPicker's input. Same native-setter + input/change
// idiom as setPhase; the picker binds a change listener that writes candidateCap
// (upgrades_tab.tsx:889-912). Read the value back and assert it stuck, so a
// silently-rejected cap cannot pose as an uncapped run.
const setCandidates = n => `(async () => {
	const wf = async (fn,ms)=>{const e=Date.now()+ms;while(Date.now()<e){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}return fn();};
	const input = await wf(()=>document.querySelector('.upgrades-candidates-picker input'),15000);
	if(!input) return {error:'no candidates input'};
	const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
	nativeSetter.call(input,'${n}');
	input.dispatchEvent(new Event('input',{bubbles:true}));
	input.dispatchEvent(new Event('change',{bubbles:true}));
	await new Promise(r=>setTimeout(r,400));
	const settled = document.querySelector('.upgrades-candidates-picker input').value;
	if (String(settled) !== '${n}') return {error:'candidates did not stick: settled='+settled};
	return {ok:true, candidatesSet: settled};
})()`;

// Set the iterations NumberPicker's input. Same native-setter + input/change
// idiom as setCandidates; the picker (id 'upgrades-iterations') is read at click
// time and drives both the loop's per-candidate sims and highStageIterations
// (rank.ts, C10). Read the value back and assert it stuck.
const setIterations = n => `(async () => {
	const wf = async (fn,ms)=>{const e=Date.now()+ms;while(Date.now()<e){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}return fn();};
	const input = await wf(()=>document.querySelector('.upgrades-iterations-picker input'),15000);
	if(!input) return {error:'no iterations input'};
	const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
	nativeSetter.call(input,'${n}');
	input.dispatchEvent(new Event('input',{bubbles:true}));
	input.dispatchEvent(new Event('change',{bubbles:true}));
	await new Promise(r=>setTimeout(r,400));
	const settled = document.querySelector('.upgrades-iterations-picker input').value;
	if (String(settled) !== '${n}') return {error:'iterations did not stick: settled='+settled};
	return {ok:true, iterationsSet: settled};
})()`;

// Sets the runner localStorage key before navigation (ticket 411, --bulk-http).
const bulkHttpSource = `try{localStorage.setItem('upgradesTab.runner','bulk-http')}catch{}`;

// Install a MutationObserver before the Run click that records performance.now()
// at the first results-table row. firstRowS is (firstRowAt - clickAt); on the
// screening path the first row cannot land before both chunks finish (C20).
const installFirstRowObserver = `(() => {
	window.__harnessFirstRowAt = null;
	const sel = '.upgrades-results table.upgrades-results-table tbody tr';
	if (document.querySelector(sel)) { window.__harnessFirstRowAt = performance.now(); return {ok:true, already:true}; }
	const obs = new MutationObserver(() => {
		if (window.__harnessFirstRowAt == null && document.querySelector(sel)) {
			window.__harnessFirstRowAt = performance.now();
			obs.disconnect();
		}
	});
	obs.observe(document.body, { subtree: true, childList: true });
	return {ok:true, already:false};
})()`;

// Read the three timing marks after the run settles.
const readTimings = `(() => ({
	clickAt: window.__harnessClickAt ?? null,
	firstRowAt: window.__harnessFirstRowAt ?? null,
	doneAt: window.__harnessDoneAt ?? null,
}))()`;

// Read the eligible-candidate count from the Candidates placeholder (C13) and
// the runner attribute before the run (expected null on a fresh page, F4).
const preRun = `(() => {
	const input = document.querySelector('.upgrades-candidates-picker input');
	const ph = input ? (input.placeholder || '') : '';
	const m = ph.match(/all\\s+([0-9]+)\\s+eligible/i);
	const st = document.querySelector('.upgrades-status');
	return {
		eligibleCount: m ? parseInt(m[1],10) : null,
		placeholder: ph,
		runnerBeforeRun: st ? (st.getAttribute('data-runner') ?? null) : null,
	};
})()`;

const clickRun = `(async () => {
	const btn = document.querySelector('.upgrades-run-button');
	if(!btn) return {error:'no run button'};
	window.__harnessClickAt = performance.now();
	btn.click();
	return {ok:true};
})()`;

const pollDone = ms => `(async () => {
	const deadline = Date.now() + ${ms};
	// Ticket 416 moved the "Your current gear: N DPS. Took Ns." done line out of
	// .upgrades-status into .upgrades-baseline-summary, so the done signal is read
	// from both. "Ranking failed" still renders in .upgrades-status.
	const statusText = () => [
		document.querySelector('.upgrades-status')?.innerText ?? '',
		document.querySelector('.upgrades-baseline-summary')?.innerText ?? '',
	].join(' ');
	while (Date.now() < deadline) {
		const t = statusText();
		if (/Took\\s/i.test(t)) { window.__harnessDoneAt = performance.now(); return {done:true, status:t}; }
		if (/Ranking failed/i.test(t)) return {done:false, failed:true, status:t};
		await new Promise(r=>setTimeout(r,500));
	}
	return {done:false, timeout:true, status:statusText()};
})()`;

const readResults = `(() => {
	const root = document.querySelector('.upgrades-results');
	if(!root) return {error:'no results root'};
	// The below-cutoff rows live inside a collapsed <details>; while collapsed
	// their cells' innerText reads empty, so a positional parse yields empty
	// item/slot and T1's key-set check degenerates. Expand every disclosure
	// before reading so below-cutoff rows carry their real item/slot (the rows
	// are already in the DOM via replaceChildren; open only reveals them).
	for (const d of root.querySelectorAll('details')) d.open = true;
	const parseDelta = s => {
		const m = (s||'').match(/([+-]?[0-9]+(?:\\.[0-9]+)?)\\s*DPS/i);
		return m ? parseFloat(m[1]) : null;
	};
	const rows = [];
	const aboveCutoffItems = [];
	for (const table of root.querySelectorAll('table.upgrades-results-table')) {
		const below = table.classList.contains('upgrades-below-cutoff-table');
		for (const tr of table.querySelectorAll('tbody tr')) {
			const tds = Array.from(tr.querySelectorAll('td'));
			if (tds.length < 5) continue;
			const text = i => (tds[i]?.innerText ?? '').trim();
			const itemCell = text(1);
			const item = itemCell.split('\\n')[0].trim();
			const row = {
				rank: text(0),
				item,
				slot: text(2),
				dps: parseDelta(text(3)),
				source: text(4),
				belowCutoff: below,
			};
			rows.push(row);
			if (!below) aboveCutoffItems.push(item);
		}
	}
	const statusEl = document.querySelector('.upgrades-status');
	const statusText = statusEl ? statusEl.innerText : '';
	const runner = statusEl ? (statusEl.getAttribute('data-runner') ?? null) : null;
	const bodyText = document.body.innerText || '';
	const mBase = statusText.match(/Your current gear:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*DPS/i)
		|| bodyText.match(/Your current gear:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*DPS/i);
	const mTook = statusText.match(/Took\\s*([0-9]+(?:\\.[0-9]+)?)s/i)
		|| bodyText.match(/Took\\s*([0-9]+(?:\\.[0-9]+)?)s/i);
	const mAbove = bodyText.match(/([0-9]+)\\s+above the cutoff/i);
	return {
		rows,
		rowCount: rows.length,
		aboveCutoff: mAbove ? parseInt(mAbove[1],10) : aboveCutoffItems.length,
		aboveCutoffItems,
		baselineDps: mBase ? parseFloat(mBase[1]) : null,
		elapsedS: mTook ? parseFloat(mTook[1]) : null,
		panicHit: /panic|goroutine/i.test(statusText) || /panic|goroutine/i.test(bodyText),
		runner,
		statusText,
		sample: bodyText.slice(0, 700),
	};
})()`;

// --force-fallback: install, before any page script, a window.Worker subclass
// that throws once its one-shot counter is armed. The factory pool constructs
// at page load while the counter is 0, so it stays usable; after the page
// settles the harness arms the counter to 1, so the NEXT construction — the
// tab's transport probe `new WorkerPool(1)` (C26) — throws synchronously into
// the bare catch, the tab returns this.sim, the counter decrements back to 0,
// and any later pool-resize respawn (enable() -> setupWorker(), C25/G1)
// constructs normally.
const blockWorkerSource = `
	const W = window.Worker;
	window.__harnessBlockWorkers = 0;
	window.Worker = class extends W {
		constructor(...a) {
			if (window.__harnessBlockWorkers > 0) {
				window.__harnessBlockWorkers -= 1;
				throw new Error('harness: Worker construction blocked');
			}
			super(...a);
		}
	};
`;

// Determine the sim worker-pool size the page actually uses, for the
// workerSessionsAttached >= poolSize smoke assertion (G1). The pool is not
// exposed on a stable global, so use navigator.hardwareConcurrency (the value
// the fork's WorkerPool sizes itself from) and record which source was used.
const readPoolSize = `(() => {
	try {
		const n = navigator.hardwareConcurrency;
		return { poolSize: (typeof n === 'number' && n > 0) ? n : null, poolSizeSource: 'navigator.hardwareConcurrency' };
	} catch (e) {
		return { poolSize: null, poolSizeSource: 'unavailable' };
	}
})()`;

// --- ticket 522 live-check scripts (only reached through the new flags) ---

// The same DOM steps as scripts/tab-fixtures/record.mjs in the outer repo. It
// must run before `activate`: the picker is in the Gear tab, and once the
// Upgrades tab is active its chips fail the offsetParent filter. The 3 s
// settle mirrors record.mjs, which waits 5 s after navigating, so a chip click
// cannot land before the page's own init applies its default gear.
const loadPreset = (tabName, chipName) => `(async () => {
	const wf = async (fn,ms)=>{const e=Date.now()+ms;while(Date.now()<e){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}return fn();};
	const sleep = ms => new Promise(r=>setTimeout(r,ms));
	if(!await wf(()=>document.querySelector('.preset-group-picker .preset-group-phase-tab'),30000)) return {error:'no .preset-group-picker .preset-group-phase-tab after 30 s'};
	await sleep(3000);
	const picker = document.querySelector('.preset-group-picker');
	const tabs = [...picker.querySelectorAll('.preset-group-phase-tab')];
	const tabNames = tabs.map(t=>t.textContent.trim());
	const visibleChips = async t => {
		t.click();
		await sleep(400);
		return [...picker.querySelectorAll('.preset-group-section')]
			.filter(s=>s.querySelector('h6')?.textContent.trim()==='Gear Sets')
			.flatMap(s=>[...s.querySelectorAll('.saved-data-set-chip')])
			.filter(c=>c.offsetParent);
	};
	const names = chips => chips.map(c=>c.textContent.trim()).join(' | ');
	const want = ${JSON.stringify(tabName)};
	const chipWant = ${JSON.stringify(chipName)};
	if (chipWant === '?') {
		const listed = [];
		for (const t of tabs) {
			const name = t.textContent.trim();
			if (want !== '?' && name !== want) continue;
			listed.push(name+': '+names(await visibleChips(t)));
		}
		if (!listed.length) return {error:'no preset phase tab '+want+'; tabs: '+tabNames.join(' | ')};
		return {list: listed.join('; ')};
	}
	const tab = tabs.find(t=>t.textContent.trim()===want);
	if (!tab) return {error:'no preset phase tab '+want+'; tabs: '+tabNames.join(' | ')};
	const chips = await visibleChips(tab);
	const chip = chips.find(c=>c.textContent.trim()===chipWant);
	if (!chip) return {error:'no Gear Sets chip '+chipWant+' under '+want+'; visible: '+names(chips)+'; tabs: '+tabNames.join(' | ')};
	(chip.querySelector('.saved-data-set-name') ?? chip).click();
	await sleep(1500);
	return {ok:true};
})()`;

const wasmConcurrencySource = n => `try{localStorage.setItem('__tbc_new_wasmconcurrency','${n}')}catch{}`;

// Patches the prototype, so the page's pool and the tab's own pool (C34: a
// separate WorkerPool instance) are both captured through one module instance.
// The wrapper awaits the original call because the check needs the exact DPS of
// the very sim whose request it captured; the displayed number is rounded and
// the page's readout also matches its in-progress view (ticket 522 plan, R1).
const installSimCapture = `(async () => {
	let wp, api;
	try {
		wp = await import('/tbc/core/worker_pool.ts');
		api = await import('/tbc/core/proto/api.ts');
	} catch (e) {
		return {captureError: String((e && e.message) || e)};
	}
	window.__harnessSimCalls = [];
	window.__harnessPhase = 'tab';
	window.__harnessTabPool = null;
	window.__harnessApi = api;
	window.__harnessWp = wp;
	const original = wp.WorkerPool.prototype.raidSimAsync;
	wp.WorkerPool.prototype.raidSimAsync = async function (request, onProgress, signals) {
		const phase = window.__harnessPhase;
		const entry = {index: window.__harnessSimCalls.length, phase, done: false};
		try { entry.json = api.RaidSimRequest.toJson(request); } catch (e) { entry.jsonError = String((e && e.message) || e); }
		if (phase === 'page') entry.request = api.RaidSimRequest.clone(request);
		if (phase === 'tab' && window.__harnessTabPool === null) window.__harnessTabPool = this;
		entry.tabPool = this === window.__harnessTabPool;
		window.__harnessSimCalls.push(entry);
		let result;
		try {
			result = await original.call(this, request, onProgress, signals);
		} catch (e) {
			entry.thrown = String((e && e.message) || e);
			entry.done = true;
			throw e;
		}
		entry.raidDps = result?.raidMetrics?.dps?.avg ?? null;
		entry.playerDps = result?.raidMetrics?.parties?.[0]?.players?.[0]?.dps?.avg ?? null;
		entry.error = result?.error ? {type: result.error.type, message: result.error.message} : null;
		entry.done = true;
		return result;
	};
	return {ok:true};
})()`;

// Runs the page's own Simulate at the tab baseline's seed and iterations. 11 is
// the tab's baseline seed (DEFAULT_SEEDS[0], engine/rank.ts:568,733). The inputs
// are read back because a scripted value on the hidden settings-menu input is
// not known to stick; a wrong seed would make the comparison meaningless.
const runPageSim = (iterations, timeoutMs) => `(async () => {
	const wf = async (fn,ms)=>{const e=Date.now()+ms;while(Date.now()<e){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}return fn();};
	const setNum = async (sel, v) => {
		const input = await wf(()=>document.querySelector(sel),15000);
		if(!input) return 'no '+sel;
		const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
		nativeSetter.call(input, v);
		input.dispatchEvent(new Event('input',{bubbles:true}));
		input.dispatchEvent(new Event('change',{bubbles:true}));
		await new Promise(r=>setTimeout(r,400));
		const settled = document.querySelector(sel).value;
		return String(settled) === v ? null : sel+' did not stick: settled='+settled;
	};
	window.__harnessPhase = 'page';
	let err = await setNum('#simui-fixed-rng-seed', '11');
	if (err) return {error: err};
	err = await setNum('#simui-iterations', '${iterations}');
	if (err) return {error: err};
	const btn = await wf(()=>{const b=document.querySelector('button.dps-action');return b&&!b.disabled?b:null;},30000);
	if(!btn) return {error:'no enabled button.dps-action after 30 s'};
	btn.click();
	const deadline = Date.now() + ${timeoutMs};
	const found = () => window.__harnessSimCalls.find(e=>e.phase==='page' && e.tabPool===false && e.done);
	while (Date.now() < deadline) {
		if (found()) return {ok:true};
		await new Promise(r=>setTimeout(r,500));
	}
	return {error:'page sim did not finish within the timeout'};
})()`;

// Replays the page's request once on the tab's pool, with the two fields that
// the request comparison leaves out set to the tab's values: debugFirstIteration
// (the page sends true, which makes Go install an iteration-0 logger) and the
// player name. Equal DPS shows that those two fields and the warm-page-worker
// versus cold-tab-worker state do not move DPS (Gate B finding N1). Its phase
// is 'replay', so it is never taken as the tab baseline or the page sim.
const replayOnTabPool = `(async () => {
	const calls = window.__harnessSimCalls;
	const page = calls.find(e=>e.phase==='page' && e.tabPool===false && e.done);
	const base = calls.find(e=>e.phase==='tab');
	if (!page || !page.request) return {error:'no page request to replay'};
	if (!base || !base.json) return {error:'no tab baseline request'};
	if (!window.__harnessTabPool) return {error:'no tab pool'};
	const req = window.__harnessApi.RaidSimRequest.clone(page.request);
	req.requestId = window.__harnessWp.generateRequestId('raidSimAsync');
	req.simOptions.debugFirstIteration = false;
	req.raid.parties[0].players[0].name = base.json.raid?.parties?.[0]?.players?.[0]?.name ?? '';
	window.__harnessPhase = 'replay';
	try {
		await window.__harnessTabPool.raidSimAsync(req, () => {}, undefined);
	} catch (e) {
		return {ok:true, thrown: String((e && e.message) || e)};
	}
	return {ok:true};
})()`;

// Every comparison runs in the page, on the JS numbers themselves; the String()
// copies in `exact` let a reader confirm no transport rounding happened.
const readCapture = `(() => {
	const calls = window.__harnessSimCalls || [];
	const dbOf = j => j?.raid?.parties?.[0]?.players?.[0]?.database ?? {};
	const ids = rows => (rows || []).map(r => r.id ?? 0).sort((a,b)=>a-b);
	const sameIds = (a,b) => a.length===b.length && a.every((x,i)=>x===b[i]);
	const tabCalls = calls.filter(e=>e.phase==='tab');
	const pageCalls = calls.filter(e=>e.phase==='page');
	const base = tabCalls[0] || null;
	const page = pageCalls.find(e=>e.tabPool===false && e.done) || null;
	const replay = calls.find(e=>e.phase==='replay') || null;
	const slim = e => ({
		index: e.index, phase: e.phase, tabPool: e.tabPool, done: e.done,
		raidDps: e.raidDps ?? null, error: e.error ?? null, thrown: e.thrown ?? null, jsonError: e.jsonError ?? null,
		seed: e.json?.simOptions?.randomSeed ?? null, iterations: e.json?.simOptions?.iterations ?? null,
		consumableIds: ids(dbOf(e.json).consumables), spellEffectIds: ids(dbOf(e.json).spellEffects),
	});
	const out = {
		tabSimCalls: tabCalls.length,
		pageSimCalls: pageCalls.length,
		calls: calls.map(slim),
		tabBaseline: base ? {
			dps: base.raidDps ?? null, playerDps: base.playerDps ?? null,
			seed: base.json?.simOptions?.randomSeed ?? null, iterations: base.json?.simOptions?.iterations ?? null,
			error: base.error ?? base.thrown ?? null,
		} : null,
		tabBaselineRequest: base?.json ?? null,
		pageRequest: page?.json ?? null,
		replayRequest: replay?.json ?? null,
	};
	if (page) {
		out.pageDps = page.raidDps ?? null;
		out.pagePlayerDps = page.playerDps ?? null;
		out.pageSeed = page.json?.simOptions?.randomSeed ?? null;
		out.pageIterations = page.json?.simOptions?.iterations ?? null;
		out.pageError = page.error ?? page.thrown ?? null;
		if (base && typeof base.raidDps === 'number' && typeof page.raidDps === 'number') {
			out.dpsDiff = base.raidDps - page.raidDps;
			out.dpsEqual = out.dpsDiff === 0;
		}
	}
	if (replay) {
		out.replayDps = replay.raidDps ?? null;
		out.replayEqual = page != null && typeof replay.raidDps === 'number' && replay.raidDps === page.raidDps;
		out.replay = {
			tabPool: replay.tabPool,
			debugFirstIteration: replay.json?.simOptions?.debugFirstIteration ?? false,
			nameMatchesTab: (replay.json?.raid?.parties?.[0]?.players?.[0]?.name ?? '') === (base?.json?.raid?.parties?.[0]?.players?.[0]?.name ?? ''),
			error: replay.error ?? replay.thrown ?? null,
		};
	}
	out.exact = {
		tabBaselineDps: base ? String(base.raidDps) : null,
		pageDps: page ? String(page.raidDps) : null,
		pagePlayerDps: page ? String(page.playerDps) : null,
		replayDps: replay ? String(replay.raidDps) : null,
	};
	if (base && page && base.json && page.json) {
		const tdb = dbOf(base.json), pdb = dbOf(page.json);
		const tabCons = ids(tdb.consumables), pageCons = ids(pdb.consumables);
		const tabEff = ids(tdb.spellEffects), pageEff = ids(pdb.spellEffects);
		const effSet = new Set(tabEff);
		const strip = j => {
			const c = JSON.parse(JSON.stringify(j));
			delete c.requestId;
			if (c.simOptions) delete c.simOptions.debugFirstIteration;
			const p = c.raid?.parties?.[0]?.players?.[0];
			if (p) { delete p.name; delete p.database; }
			return c;
		};
		// Both sides are protobuf-ts toJson output, which drops defaults and empty
		// arrays the same way, so a listed path is a real value difference.
		const diffs = [];
		let diffCount = 0;
		const cut = v => v === undefined ? '(absent)' : JSON.stringify(v).slice(0, 200);
		const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
		const walk = (a, b, path) => {
			if (Array.isArray(a) && Array.isArray(b)) {
				for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], path+'['+i+']');
				return;
			}
			if (isObj(a) && isObj(b)) {
				const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
				for (const k of keys) walk(a[k], b[k], path ? path+'.'+k : k);
				return;
			}
			if (JSON.stringify(a) !== JSON.stringify(b)) {
				diffCount++;
				if (diffs.length < 50) diffs.push({path, tab: cut(a), page: cut(b)});
			}
		};
		walk(strip(base.json), strip(page.json), '');
		out.requestCheck = {
			tabConsumableIds: tabCons, pageConsumableIds: pageCons,
			tabSpellEffectIds: tabEff, pageSpellEffectIds: pageEff,
			consumableIdsEqual: sameIds(tabCons, pageCons),
			spellEffectIdsEqual: sameIds(tabEff, pageEff),
			consumablesWithEffects: (tdb.consumables || []).filter(c => (c.effectIds || []).length > 0).length,
			effectIdsCovered: (tdb.consumables || []).every(c => (c.effectIds || []).every(id => effSet.has(id))),
			tabCallsChecked: tabCalls.length,
			tabCallsWithPageRows: tabCalls.filter(e => sameIds(ids(dbOf(e.json).consumables), pageCons) && sameIds(ids(dbOf(e.json).spellEffects), pageEff)).length,
			otherDiffPaths: diffs,
			otherDiffCount: diffCount,
		};
	}
	return out;
})()`;

async function fetchServedWorker(origin) {
	const url = origin + '/tbc/sim_worker.js';
	try {
		const res = await fetch(url);
		const body = await res.text();
		const count = re => (body.match(re) || []).length;
		return {
			bytes: Buffer.byteLength(body, 'utf8'),
			wasmRefs: count(/WebAssembly/g),
			asyncProgressRefs: count(/asyncProgress/g),
			readyFalse: count(/ready\(false\)/g),
			firstLine: body.split('\n')[0].slice(0, 200),
			httpStatus: res.status,
		};
	} catch (e) {
		return { error: String(e), url };
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const started = Date.now();

	const servedWorker = await fetchServedWorker(args.origin);

	const chrome = await launchChrome();
	const client = cdp(chrome.wsUrl);
	await client.ready;

	// Attach to the page target.
	const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
	const { sessionId: pageSession } = await client.send('Target.attachToTarget', { targetId, flatten: true });
	const psend = (m, p) => client.send(m, p, pageSession);

	// Signal accumulators.
	const requests = { bulkSimAsync: 0, raidSimAsync: 0, asyncProgress: 0, other: 0 };
	const requestsSent = { bulkSimAsync: 0, raidSimAsync: 0, asyncProgress: 0, other: 0 };
	const requestsBySession = {};
	const firstUrls = { bulkSimAsync: [], raidSimAsync: [], asyncProgress: [], other: [] };
	let workerSessionsAttached = 0;
	const screeningFallbackWarnings = [];

	function classify(url) {
		try {
			const p = new URL(url).pathname;
			if (p.endsWith('/bulkSimAsync')) return 'bulkSimAsync';
			if (p.endsWith('/raidSimAsync')) return 'raidSimAsync';
			if (p.endsWith('/asyncProgress')) return 'asyncProgress';
			return 'other';
		} catch {
			if (url.endsWith('/bulkSimAsync')) return 'bulkSimAsync';
			if (url.endsWith('/raidSimAsync')) return 'raidSimAsync';
			if (url.endsWith('/asyncProgress')) return 'asyncProgress';
			return 'other';
		}
	}

	// Count sent requests (any session).
	client.on('*', 'Network.requestWillBeSent', params => {
		const kind = classify(params.request?.url ?? '');
		requestsSent[kind] += 1;
	});
	// Count completed 200 responses (any session). This is S2.
	client.on('*', 'Network.responseReceived', (params, sid) => {
		if (params.response?.status !== 200) return;
		const kind = classify(params.response.url ?? '');
		requests[kind] += 1;
		const sk = sid || '@page';
		requestsBySession[sk] = requestsBySession[sk] || {};
		requestsBySession[sk][kind] = (requestsBySession[sk][kind] || 0) + 1;
		if (firstUrls[kind].length < 5) firstUrls[kind].push(params.response.url);
	});
	// Page-console capture for the screening-fallback warnings (S4, C30).
	client.on(pageSession, 'Runtime.consoleAPICalled', params => {
		const first = params.args?.[0]?.value;
		if (typeof first === 'string' && first.startsWith('[upgrades] screening fell back')) {
			screeningFallbackWarnings.push(first);
		}
	});

	// Worker auto-attach: installed ONCE, before navigation, kept for the whole
	// run. Every worker attach gets Network.enable + runIfWaitingForDebugger, or
	// a respawned worker stays frozen (C25/G1).
	client.on('*', 'Target.attachedToTarget', async params => {
		const wsid = params.sessionId;
		const type = params.targetInfo?.type;
		try {
			if (type === 'worker') {
				workerSessionsAttached += 1;
				await client.send('Network.enable', {}, wsid);
				await client.send('Runtime.runIfWaitingForDebugger', {}, wsid);
			} else {
				await client.send('Runtime.runIfWaitingForDebugger', {}, wsid);
			}
		} catch {}
	});

	let out;
	let captureFiles = null;
	try {
		await psend('Page.enable', {});
		await psend('Runtime.enable', {});
		await psend('Network.enable', {});
		if (args.forceFallback) {
			await psend('Page.addScriptToEvaluateOnNewDocument', { source: blockWorkerSource });
		}
		if (args.bulkHttp) {
			await psend('Page.addScriptToEvaluateOnNewDocument', { source: bulkHttpSource });
		}
		if (args.wasmConcurrency !== null) {
			await psend('Page.addScriptToEvaluateOnNewDocument', { source: wasmConcurrencySource(args.wasmConcurrency) });
		}
		await psend('Target.setAutoAttach', {
			autoAttach: true,
			waitForDebuggerOnStart: true,
			flatten: true,
		});
		await psend('Emulation.setDeviceMetricsOverride', {
			width: WIDTH,
			height: HEIGHT,
			deviceScaleFactor: 1,
			mobile: false,
		});

		await psend('Page.navigate', { url: `${args.origin}${args.page}` });
		await sleep(500);

		if (args.preset !== null) {
			const loaded = await evaluate(psend, pageSession, loadPreset(args.presetTab, args.preset));
			if (loaded?.list !== undefined) throw new Error(`preset list: ${loaded.list}`);
			if (!loaded?.ok) throw new Error(`preset load failed: ${loaded?.error ?? 'unknown'}`);
		}

		const act = await evaluate(psend, pageSession, activate);
		if (!act?.ok) throw new Error(`activate failed: ${act?.error ?? 'unknown'}`);

		const phase = await evaluate(psend, pageSession, setPhase(args.phase));
		if (!phase?.ok) throw new Error(`phase select failed: ${phase?.error ?? 'unknown'}`);

		if (args.candidates > 0) {
			const cand = await evaluate(psend, pageSession, setCandidates(args.candidates));
			if (!cand?.ok) throw new Error(`candidates set failed: ${cand?.error ?? 'unknown'}`);
		}

		if (args.iterations > 0) {
			const iters = await evaluate(psend, pageSession, setIterations(args.iterations));
			if (!iters?.ok) throw new Error(`iterations set failed: ${iters?.error ?? 'unknown'}`);
		}

		const pre = await evaluate(psend, pageSession, preRun);
		const pool = await evaluate(psend, pageSession, readPoolSize);

		// Arm the one-shot Worker throw after the page has settled and the factory
		// pool exists, and before Run.
		if (args.forceFallback) {
			await evaluate(psend, pageSession, 'window.__harnessBlockWorkers = 1; true');
		}

		await evaluate(psend, pageSession, installFirstRowObserver);

		let captureInstall = null;
		if (args.captureRequests) {
			captureInstall = await evaluate(psend, pageSession, installSimCapture);
		}

		const run = await evaluate(psend, pageSession, clickRun);
		if (!run?.ok) throw new Error(`run click failed: ${run?.error ?? 'unknown'}`);

		const done = await evaluate(psend, pageSession, pollDone(args.timeoutMs));

		const results = await evaluate(psend, pageSession, readResults);
		if (results?.error) throw new Error(`read results failed: ${results.error}`);

		const timings = await evaluate(psend, pageSession, readTimings);
		const clickAt = typeof timings?.clickAt === 'number' ? timings.clickAt : null;
		const firstRowAt = typeof timings?.firstRowAt === 'number' ? timings.firstRowAt : null;
		const doneAt = typeof timings?.doneAt === 'number' ? timings.doneAt : null;
		const firstRowS = clickAt != null && firstRowAt != null ? +((firstRowAt - clickAt) / 1000).toFixed(3) : null;
		const clickToDoneS = clickAt != null && doneAt != null ? +((doneAt - clickAt) / 1000).toFixed(3) : null;

		let forceFallbackRemaining = null;
		if (args.forceFallback) {
			forceFallbackRemaining = await evaluate(psend, pageSession, 'window.__harnessBlockWorkers');
		}

		out = {
			...results,
			origin: args.origin,
			page: args.page,
			eligibleCount: pre?.eligibleCount ?? null,
			candidatesRequested: args.candidates,
			iterationsRequested: args.iterations > 0 ? args.iterations : null,
			bulkHttpRequested: args.bulkHttp,
			firstRowS,
			clickToDoneS,
			runnerBeforeRun: pre?.runnerBeforeRun ?? null,
			runner: results.runner ?? null,
			servedWorker,
			requests,
			requestsSent,
			requestsBySession,
			firstUrls,
			workerSessionsAttached,
			poolSize: pool?.poolSize ?? null,
			poolSizeSource: pool?.poolSizeSource ?? null,
			screeningFallbackWarnings: screeningFallbackWarnings.length,
			screeningFallbackTexts: screeningFallbackWarnings,
			forcedFallback: args.forceFallback,
			forceFallbackRemaining,
			phaseSet: phase.phaseSet,
			done: !!done.done,
			runTimedOut: !!done.timeout,
			runFailed: !!done.failed,
			wallClockS: +((Date.now() - started) / 1000).toFixed(1),
			recordedAt: new Date().toISOString(),
		};

		if (args.preset !== null) Object.assign(out, { presetTab: args.presetTab, preset: args.preset });
		if (args.wasmConcurrency !== null) out.wasmConcurrency = args.wasmConcurrency;
		if (args.captureRequests) {
			const extra = {};
			if (captureInstall?.captureError) {
				extra.captureError = captureInstall.captureError;
			} else {
				if (args.pageSim) {
					extra.pageSimRequested = true;
					if (!done.done) {
						extra.pageSimError = 'tab run did not finish; page sim skipped';
					} else {
						const iterations = args.iterations > 0 ? args.iterations : 3000;
						const ps = await evaluate(psend, pageSession, runPageSim(iterations, args.timeoutMs));
						if (!ps?.ok) {
							extra.pageSimError = ps?.error ?? 'unknown';
						} else {
							const rp = await evaluate(psend, pageSession, replayOnTabPool);
							if (!rp?.ok) extra.replayError = rp?.error ?? 'unknown';
						}
					}
				}
				const cap = await evaluate(psend, pageSession, readCapture);
				captureFiles = {
					'tab-baseline.json': cap.tabBaselineRequest,
					'page.json': cap.pageRequest,
					'replay.json': cap.replayRequest,
				};
				Object.assign(extra, cap);
				delete extra.replayRequest;
				if (cap.tabBaseline && typeof cap.tabBaseline.dps === 'number') {
					// The tab shows the baseline with toFixed(1) (upgrades_tab.tsx:2058), so
					// this checks that the first tab-phase call really was the baseline.
					extra.tabBaselineMatchesDisplay = Number(cap.tabBaseline.dps.toFixed(1)) === results.baselineDps;
				}
			}
			Object.assign(out, extra);
			out.wallClockS = +((Date.now() - started) / 1000).toFixed(1);
		}
	} finally {
		client.close();
		chrome.proc.kill();
		try {
			await fsp.rm(chrome.userDataDir, { recursive: true, force: true });
		} catch {}
	}

	const json = JSON.stringify(out, null, 2);
	if (args.out) await fsp.writeFile(args.out, json);
	else process.stdout.write(json + '\n');
	console.error(
		`origin=${out.origin} runner=${out.runner} rows=${out.rowCount} ` +
			`bulk=${out.requests.bulkSimAsync} raid=${out.requests.raidSimAsync} ` +
			`workerSessions=${out.workerSessionsAttached} poolSize=${out.poolSize} ` +
			`fallbackWarnings=${out.screeningFallbackWarnings} done=${out.done} elapsedS=${out.elapsedS} ` +
			`firstRowS=${out.firstRowS} clickToDoneS=${out.clickToDoneS}`,
	);
	if (args.captureRequests) {
		await fsp.mkdir(args.captureRequests, { recursive: true });
		for (const [name, body] of Object.entries(captureFiles ?? {})) {
			if (body) await fsp.writeFile(path.join(args.captureRequests, name), JSON.stringify(body, null, 2));
		}
		const rc = out.requestCheck;
		console.error(
			`tabBaselineDps=${out.exact?.tabBaselineDps} pageDps=${out.exact?.pageDps} dpsDiff=${out.dpsDiff} ` +
				`replayDps=${out.exact?.replayDps} replayEqual=${out.replayEqual} otherDiffCount=${rc?.otherDiffCount} ` +
				`tabCallsWithPageRows=${rc?.tabCallsWithPageRows}/${rc?.tabCallsChecked}` +
				(out.captureError ? ` captureError=${out.captureError}` : '') +
				(out.pageSimError ? ` pageSimError=${out.pageSimError}` : '') +
				(out.replayError ? ` replayError=${out.replayError}` : ''),
		);
	}
	// Exit 0 only when the run completed, did not panic, and the tab wrote the
	// attribute. The harness measures; the Python gate judges.
	process.exit(out.done && !out.panicHit && out.runner !== null ? 0 : 1);
}

main().catch(e => {
	console.error('crashed:', e.stack || e.message);
	process.exit(1);
});
