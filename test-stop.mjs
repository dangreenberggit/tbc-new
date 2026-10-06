// The Upgrades tab's Stop check (ticket 560, G5): a live run is started on a
// real page, Stop is pressed once a few rows have landed, and the tab must end
// in the stopped state with those rows kept and no console error. Run it before
// any fork commit that changes the run path (model/run.ts, model/run_reducer.ts,
// hooks/useUpgradesRun.ts, utils/select_run_fn.ts).
//
// It needs a running dev server with the WASM worker, which it does not start:
//   WASM_WORKER=1 node node_modules/vite/bin/vite.js serve --port 5174 --strictPort
//   node test-stop.mjs --base http://localhost:5174 --preset-tab "Phase 2" --preset P2
//
// Live runs start from the previous phase's preset gear (owner rule); the page's
// phase is left at its default. Exit 0 pass, 1 fail, 2 a prerequisite is missing.
// The last two lines are `STOP_CHECK_VERDICT pass|fail` and a JSON record.

import fs from 'node:fs';
import path from 'node:path';

import * as H from './test-tab-harness.mjs';

const VERDICT_TAG = 'STOP_CHECK_VERDICT';
const POLL_MS = 50;

function parseArgs(argv) {
	const out = {
		base: `http://localhost:${process.env.TBC_FORK_PORT ?? 5173}`,
		page: 'ret',
		presetTab: undefined,
		preset: undefined,
		rows: 5,
		timeoutMs: 120000,
	};
	const keys = { '--base': 'base', '--page': 'page', '--preset-tab': 'presetTab', '--preset': 'preset', '--rows': 'rows', '--timeout-ms': 'timeoutMs' };
	for (let i = 0; i < argv.length; i++) {
		const key = keys[argv[i]];
		if (!key) throw new Error(`unknown argument ${argv[i]}`);
		out[key] = argv[++i];
	}
	out.rows = Number(out.rows);
	out.timeoutMs = Number(out.timeoutMs);
	if (!Number.isInteger(out.rows) || out.rows < 1) throw new Error('--rows must be a positive integer');
	if ((out.presetTab === undefined) !== (out.preset === undefined)) throw new Error('give --preset-tab and --preset together');
	return out;
}

// The page's own words, so a reworded string fails the check rather than the regex.
function statusTexts() {
	const locale = JSON.parse(fs.readFileSync(path.join(H.__dirname, 'assets', 'locales', 'en', 'translation.json'), 'utf8'));
	const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const stoppedPartial = locale.upgrades_tab.status.stopped_partial;
	const pattern = escape(stoppedPartial).replace(/\\\{\\\{dps\\\}\\\}/, '.+');
	return { stopping: locale.upgrades_tab.status.stopping, stoppedPartial: `^${pattern}$` };
}

// Clicks the Gear Sets chip named `preset` under the preset phase tab `presetTab`
// (the same clicks as the repo's scripts/tab-fixtures/record.mjs).
const selectPresetExpression = (presetTab, preset) => `(async () => {
	const end = Date.now() + 30000;
	let tab;
	while (!(tab = [...document.querySelectorAll('[data-testid="preset-group-phase-tabs"] button')].find(t => t.textContent.trim() === ${JSON.stringify(presetTab)})) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
	if (!tab) return { error: 'no preset phase tab ' + ${JSON.stringify(presetTab)} };
	tab.click();
	// The chips render once the sim has loaded its presets, after the tabs.
	const gearChips = () =>
		[...document.querySelectorAll('[data-testid="preset-group-picker"] [data-testid="content-block"]')]
			.filter(s => s.querySelector('[data-testid="content-block-title"]')?.textContent.trim() === 'Gear Sets')
			.flatMap(s => [...s.querySelectorAll('[data-testid="saved-data-set-chip"]')])
			.filter(c => c.offsetParent);
	let chips = gearChips();
	let chip;
	while (!(chip = chips.find(c => c.textContent.trim() === ${JSON.stringify(preset)})) && Date.now() < end) {
		await new Promise(r => setTimeout(r, 100));
		chips = gearChips();
	}
	if (!chip) {
		const all = [...document.querySelectorAll('[data-testid="saved-data-set-chip"]')].map(c => c.textContent.trim() + (c.offsetParent ? '' : '(hidden)'));
		const selected = [...document.querySelectorAll('[data-testid="preset-group-phase-tabs"] [aria-selected="true"]')].map(t => t.textContent.trim());
		return { error: 'no Gear Sets chip ' + ${JSON.stringify(preset)} + '; visible: ' + chips.map(c => c.textContent.trim()).join(', ') + '; all chips: ' + all.join(', ') + '; selected tabs: ' + selected.join(', ') };
	}
	(chip.querySelector('[data-testid="saved-data-set-name"]') ?? chip).click();
	await new Promise(r => setTimeout(r, 1500));
	const worn = [...document.querySelectorAll('[data-testid="gear-picker-root"] [data-testid="item-picker-name"]')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 5);
	return { ok: true, worn };
})()`;

const installErrorHooksExpression = `(() => {
	window.__stopCheckErrors = [];
	const push = (kind, detail) => window.__stopCheckErrors.push({ kind, detail: String(detail).slice(0, 500) });
	const original = console.error.bind(console);
	console.error = (...args) => { push('console.error', args.map(String).join(' ')); original(...args); };
	window.addEventListener('error', e => push('error', e.message));
	window.addEventListener('unhandledrejection', e => push('unhandledrejection', e.reason?.stack ?? e.reason));
	return true;
})()`;

// One in-page script: click Run, poll every ${POLL_MS} ms, press Stop at `rows`
// landed rows, read the dialog's message until it closes, then read what is kept.
// Times are ms from the Run click (performance.now()).
const runAndStopExpression = (rows, timeoutMs) => `(async () => {
	const POLL = ${POLL_MS};
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const q = s => document.querySelector(s);
	const runBtn = q('[data-testid="upgrades-run-button"]');
	if (!runBtn || runBtn.disabled) return { error: 'the Run button is missing or disabled' };
	const t0 = performance.now();
	const at = () => Math.round(performance.now() - t0);
	runBtn.click();
	const provisional = () => [...document.querySelectorAll('[data-testid="upgrades-results-table"] tbody tr')];
	const timeline = [];
	let last = -1;
	let atClick;
	while (performance.now() - t0 < ${timeoutMs}) {
		const landed = provisional();
		if (landed.length !== last) { last = landed.length; timeline.push([at(), last]); }
		if (landed.length >= ${rows}) {
			const cancel = q('[data-testid="progress-tracker-modal-cancel-btn"]');
			if (!cancel) return { error: 'no Cancel button in the progress dialog', timeline };
			atClick = {
				t: at(),
				rows: landed.length,
				nonOwned: landed.filter(r => r.dataset.owned !== 'true').length,
				names: landed.map(r => r.querySelector('[data-testid="upgrades-item-name"]')?.textContent.trim()),
			};
			cancel.click();
			break;
		}
		if (!q('[data-testid="upgrades-run-progress"]') && performance.now() - t0 > 2000) return { error: 'the run ended before ' + ${rows} + ' rows landed', timeline };
		await sleep(POLL);
	}
	if (!atClick) return { error: 'fewer than ' + ${rows} + ' rows in ' + ${timeoutMs} + ' ms', timeline };
	const messages = [];
	let closedAt;
	while (performance.now() - t0 < ${timeoutMs} * 2) {
		const dialog = q('[data-testid="upgrades-run-progress"]');
		if (!dialog) { closedAt = at(); break; }
		const text = q('[data-testid="progress-tracker-modal-message"]')?.textContent.trim() ?? '';
		if (messages.at(-1)?.text !== text) messages.push({ t: at(), text });
		const landed = provisional().length;
		if (landed !== last) { last = landed; timeline.push([at(), last]); }
		await sleep(POLL);
	}
	if (closedAt === undefined) return { error: 'the progress dialog never closed after Stop', atClick, messages, timeline };
	await sleep(500);
	const pane = q('[id^="upgrades-pane-"][data-testid="tab-pane"]:not([inert])');
	const shortlistRows = pane ? [...pane.querySelectorAll('[data-testid="upgrades-results-table"] tbody tr')].filter(r => !r.closest('[data-testid="upgrades-below-cutoff"]')).length : 0;
	const groupText = pane?.querySelector('[data-testid="upgrades-below-cutoff"]')?.textContent ?? '';
	const groupCount = Number(/(\\d+) item/.exec(groupText)?.[1] ?? 0);
	return {
		ok: true,
		atClick,
		messages,
		closedAt,
		timeline,
		pane: pane?.id ?? null,
		shortlistRows,
		groupCount,
		rowsKept: shortlistRows + groupCount,
		baselineSummary: q('[data-testid="upgrades-baseline-summary"]')?.textContent.trim() ?? null,
		errorLine: q('[data-testid="upgrades-run-error"]')?.textContent.trim() ?? null,
		consoleErrors: window.__stopCheckErrors ?? [],
	};
})()`;

function finish(pass, record) {
	console.log(`${VERDICT_TAG} ${pass ? 'pass' : 'fail'}`);
	console.log(JSON.stringify(record));
	return pass ? 0 : 1;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const pagePath = args.page.startsWith('/') ? args.page : H.pagePathFor(args.page);
	const url = `${args.base}${pagePath}`;
	try {
		await fetch(args.base);
	} catch {
		console.error(
			`no server at ${args.base}. Start one in the fork first:\n  WASM_WORKER=1 node node_modules/vite/bin/vite.js serve --port 5174 --strictPort`,
		);
		return 2;
	}
	const texts = statusTexts();
	const chrome = await H.launchChrome();
	const client = H.cdp(chrome.wsUrl);
	try {
		await client.ready;
		const { send } = await H.attachPage(client);
		await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
		await send('Emulation.setFocusEmulationEnabled', { enabled: true });
		console.log(`opening ${url}`);
		await send('Page.navigate', { url });
		await H.sleep(3000);

		let preset = null;
		if (args.preset !== undefined) {
			preset = await H.evaluate(send, selectPresetExpression(args.presetTab, args.preset));
			if (preset?.error) throw new Error(preset.error);
			console.log(`preset ${args.presetTab} / ${args.preset}; first worn: ${preset.worn.join(' | ')}`);
		}
		const opened = await H.evaluate(send, H.activateTabExpression());
		if (opened?.error) throw new Error(opened.error);
		const ready = await H.evaluate(
			send,
			`(async () => { const end = Date.now() + 60000; let b; while (!((b = document.querySelector('[data-testid="upgrades-run-button"]')) && !b.disabled) && Date.now() < end) await new Promise(r => setTimeout(r, 100)); return !!b && !b.disabled; })()`,
		);
		if (!ready) throw new Error('the Run button never became enabled');

		await H.evaluate(send, installErrorHooksExpression);
		const r = await H.evaluate(send, runAndStopExpression(args.rows, args.timeoutMs));
		if (!r || r.error) return finish(false, { url, preset, ...r, error: r?.error ?? 'the run script returned nothing' });

		const stoppingShown = r.messages.find(m => m.text.includes(texts.stopping));
		const checks = {
			stoppedPartial: new RegExp(texts.stoppedPartial).test(r.baselineSummary ?? ''),
			stoppingShownInDialog: stoppingShown !== undefined,
			rowsKeptAtLeastNonOwnedAtClick: r.rowsKept >= r.atClick.nonOwned,
			noErrorLine: r.errorLine === null,
			noConsoleError: r.consoleErrors.length === 0,
		};
		const pass = Object.values(checks).every(Boolean);
		console.log(
			`rows at Stop ${r.atClick.rows} (non-owned ${r.atClick.nonOwned}) at ${r.atClick.t} ms; dialog closed at ${r.closedAt} ms (${r.closedAt - r.atClick.t} ms after Stop)`,
		);
		console.log(`kept ${r.rowsKept} = ${r.shortlistRows} rows in ${r.pane} + ${r.groupCount} below the cutoff; summary: ${r.baselineSummary}`);
		for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
		return finish(pass, {
			url,
			preset,
			checks,
			rowsAtClick: r.atClick,
			stoppingShownAt: stoppingShown?.t ?? null,
			closedAt: r.closedAt,
			stopToClosedMs: r.closedAt - r.atClick.t,
			rowsKept: r.rowsKept,
			shortlistRows: r.shortlistRows,
			groupCount: r.groupCount,
			pane: r.pane,
			baselineSummary: r.baselineSummary,
			messages: r.messages,
			timeline: r.timeline,
			consoleErrors: r.consoleErrors,
		});
	} finally {
		client.close();
		chrome.kill();
	}
}

main().then(
	code => process.exit(code),
	error => {
		console.error(error);
		console.log(`${VERDICT_TAG} fail`);
		process.exit(1);
	},
);
