// The Upgrades tab's layout gate on the React tab (ticket 560; the old tab's
// gate was ticket 322). No static check renders the page, so an element past
// the viewport or a control below the results it governs passes all of them.
// This gate renders the tab at four widths and measures the live DOM:
//
//   pre-run, at each width:
//     (1) nothing inside the tab extends past the viewport (a table's own
//         scroll box may scroll);
//     (2) below `xl` the settings are behind the summary button, which opens
//         them; at 1280 they show and the button is hidden;
//     (3) below `xl` the run card sits above the results;
//     axe on the tab.
//   on a recorded fixture (TBC_TAB_FIXTURE), at each width, in the open pane
//   with its below-cutoff group open:
//     (6) slot and ΔDPS figures on one line;
//     (7) no clipped text, and nothing in a table cell past the cell;
//     (12) the ΔDPS figure inside its cell;
//     (13) at 1280, at least 8 px between the two columns;
//     the A1 fact: how far each below-cutoff column sits from its head;
//     axe once, at 653.
//
// An unbaselined critical or serious WCAG violation fails the gate
// (TBC_A11Y_BASELINE holds the accepted debt). The verdict is one
// LAYOUT_GATE_VERDICT line (test-tab-harness.mjs `verdict`) that
// scripts/check_layout_gate.py parses: "measured" when every width ran,
// "unmeasured" with a reason when a prerequisite stopped it.
//
// Server: TBC_FORK_PORT names a running server to reuse (a dev server serves
// fixtures too); otherwise this builds the fixture-enabled bundle into dist/
// and serves it.

import fs from 'node:fs';
import path from 'node:path';

import * as H from './test-tab-harness.mjs';

const WIDTHS = [375, 653, 768, 1280];
const HEIGHT = 900;
const XL = 1200; // ui/styles/theme/breakpoints.css --breakpoint-xl
const POST_RUN_AXE_WIDTH = 653;
const TOL = 2; // px of sub-pixel slack
const MIN_COLUMN_GAP = 8;
const ROOT = '[data-testid="upgrades-tab-root"]';
const FIXTURE_DIR = path.resolve(H.__dirname, '..', '..', 'data', 'tab-fixtures');
const DEFAULT_FIXTURE = 'feral-p3-p2bis.json';

class Unmeasured extends Error {}

const results = [];
const check = (id, width, ok, detail) => {
	results.push({ check: id, width, ok, ...(detail === undefined ? {} : { detail }) });
	console.log(`${ok ? 'PASS' : 'FAIL'} (${id}) @${width}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};

// Page-side helpers, prepended to every measuring expression.
const PAGE_HELPERS = `
	const TOL = ${TOL};
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(100); } return fn(); };
	const root = document.querySelector(${JSON.stringify(ROOT)});
	const byTestId = id => root.querySelector('[data-testid="' + id + '"]');
	const shown = el => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;
	const name = el => el.tagName.toLowerCase() + (el.dataset.testid ? '[' + el.dataset.testid + ']' : '') + (el.textContent ? ' "' + el.textContent.trim().slice(0, 30) + '"' : '');
	const lineCount = node => { const range = document.createRange(); range.selectNodeContents(node); return new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size; };
	const openPane = () => [...root.querySelectorAll('[id^="upgrades-pane-"][data-testid="tab-pane"]:not([inert])')].find(p => !p.hidden);
`;

const preRunExpression = width => `(async () => {
	${PAGE_HELPERS}
	const vw = document.documentElement.clientWidth;
	const past = [];
	for (const el of root.querySelectorAll('*')) {
		if (!shown(el) || el.closest('[data-testid="upgrades-table-scroll"] *')) continue;
		const r = el.getBoundingClientRect();
		if (r.right > vw + TOL || r.left < -TOL) past.push({ el: name(el), left: Math.round(r.left), right: Math.round(r.right), vw });
	}
	const summary = byTestId('upgrades-run-settings-summary');
	const body = byTestId('upgrades-run-settings-body');
	const disclosure = { summaryShown: shown(summary), bodyShown: shown(body), expanded: summary?.getAttribute('aria-expanded') };
	if (${width < XL} && disclosure.summaryShown && !disclosure.bodyShown) {
		summary.click();
		await waitFor(() => shown(body), 2000);
		Object.assign(disclosure, { bodyShownAfterClick: shown(body), expandedAfterClick: summary.getAttribute('aria-expanded') });
	}
	const card = byTestId('upgrades-run-settings').getBoundingClientRect();
	const results = byTestId('upgrades-tab-left').getBoundingClientRect();
	return { past: past.slice(0, 10), pastCount: past.length, disclosure, cardBottom: Math.round(card.bottom), resultsTop: Math.round(results.top) };
})()`;

const postRunExpression = `(async () => {
	${PAGE_HELPERS}
	const pane = openPane();
	if (!pane) return { error: 'no open results pane' };
	const group = pane.querySelector('[data-testid="upgrades-below-cutoff"]');
	if (group && !group.querySelector('[data-testid="upgrades-results-table"]')) {
		group.querySelector('[data-testid="upgrades-below-cutoff-trigger"]')?.click();
		await waitFor(() => group.querySelector('[data-testid="upgrades-results-table"] tbody tr'), 5000);
		await sleep(200);
	}
	const multiLine = [], clipped = [], pastCell = [], figureOutside = [];
	const tables = [...pane.querySelectorAll('[data-testid="upgrades-results-table"]')];
	let rows = 0;
	for (const tr of tables.flatMap(t => [...t.querySelectorAll('tbody tr')])) {
		rows++;
		const [, , slot, delta] = tr.children;
		const figure = delta.querySelector(':scope > span')?.firstChild;
		if (lineCount(slot) > 1) multiLine.push('slot: ' + slot.textContent);
		if (figure && lineCount(figure) > 1) multiLine.push('dps: ' + delta.textContent);
		if (figure) {
			const range = document.createRange(); range.selectNodeContents(figure);
			const f = range.getBoundingClientRect(), c = delta.getBoundingClientRect();
			if (f.left < c.left - TOL || f.right > c.right + TOL) figureOutside.push(delta.textContent.trim());
		}
	}
	for (const cell of tables.flatMap(t => [...t.querySelectorAll('td, th')])) {
		const c = cell.getBoundingClientRect();
		for (const el of cell.querySelectorAll('*')) {
			const r = el.getBoundingClientRect();
			if (r.width > 1 && (r.right > c.right + TOL || r.left < c.left - TOL)) { pastCell.push(name(el)); break; }
		}
	}
	for (const el of root.querySelectorAll('*')) {
		const style = getComputedStyle(el);
		if (!shown(el) || style.clip !== 'auto' || style.position === 'absolute') continue;
		if ((style.overflowX === 'hidden' || style.overflowX === 'clip') && el.scrollWidth > el.clientWidth + TOL && el.textContent.trim()) clipped.push(name(el));
	}
	const head = tables[0]?.querySelectorAll('thead th') ?? [];
	const offsets = [...head].map(() => 0);
	const groupTable = group?.querySelector('[data-testid="upgrades-results-table"]');
	for (const tr of groupTable?.querySelectorAll('tbody tr') ?? []) {
		[...tr.children].forEach((td, i) => {
			if (!head[i]) return;
			const d = Math.round(td.getBoundingClientRect().left - head[i].getBoundingClientRect().left);
			if (Math.abs(d) > Math.abs(offsets[i])) offsets[i] = d;
		});
	}
	const left = byTestId('upgrades-tab-left').getBoundingClientRect();
	const card = byTestId('upgrades-run-settings').getBoundingClientRect();
	return {
		pane: pane.id, rows, multiLine: multiLine.slice(0, 10), clipped: clipped.slice(0, 10), pastCell: pastCell.slice(0, 10),
		figureOutside: figureOutside.slice(0, 10), counts: [multiLine.length, clipped.length, pastCell.length, figureOutside.length],
		a1: { measuredRows: groupTable ? groupTable.querySelectorAll('tbody tr').length : 0, offsets, maxAbs: Math.max(0, ...offsets.map(Math.abs)) },
		columnGap: Math.round(card.left - left.right), cardBesideResults: card.top < left.bottom && card.left > left.left,
	};
})()`;

function fixturePath() {
	const asked = process.env.TBC_TAB_FIXTURE ?? DEFAULT_FIXTURE;
	const candidates = [path.resolve(asked), path.join(FIXTURE_DIR, asked)];
	const found = candidates.find(p => fs.existsSync(p));
	if (!found) throw new Unmeasured(`fixture ${asked} not found (looked in ${candidates.join(', ')})`);
	return found;
}

async function serverBase() {
	const port = process.env.TBC_FORK_PORT;
	if (port) {
		const base = `http://localhost:${port}`;
		try {
			if ((await fetch(`${base}${H.PAGE_PATH}`)).ok) return { base, stop: () => {} };
		} catch {
			// not running: build and serve below
		}
	}
	if (!fs.existsSync(path.join(H.OUT_DIR, H.WASM_FILE)) || !fs.existsSync(path.join(H.OUT_DIR, 'assets')))
		throw new Unmeasured(`dist/tbc/${H.WASM_FILE} or dist/tbc/assets is missing -- run \`make -C <fork> dist/tbc/.dirstamp\` once`);
	await H.build();
	const server = await H.startServer();
	return { base: `http://127.0.0.1:${server.port}`, stop: () => server.proc.kill() };
}

async function setWidth(send, width) {
	await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
	await H.sleep(400);
}

async function loadFixture(send, base, text) {
	await send('Page.navigate', { url: `${base}${H.pagePathFor(JSON.parse(text).spec)}` });
	await H.sleep(300);
	const loaded = await H.evaluate(send, H.loadFixtureExpression(text));
	if (!loaded?.ok) throw new Unmeasured(`fixture load failed: ${loaded?.error ?? loaded?.reason ?? 'no answer'}`);
	const deadline = Date.now() + H.FIXTURE_DEADLINE_MS;
	while (!(await H.evaluate(send, H.fixtureSettledExpression))) {
		if (Date.now() > deadline) throw new Unmeasured('fixture did not settle');
		await H.sleep(250);
	}
}

function judgePreRun(width, m) {
	check(1, width, m.pastCount === 0, m.pastCount === 0 ? undefined : m.past);
	const d = m.disclosure;
	const disclosureOk =
		width < XL
			? d.summaryShown && !d.bodyShown && d.expanded === 'false' && d.bodyShownAfterClick === true && d.expandedAfterClick === 'true'
			: !d.summaryShown && d.bodyShown;
	check(2, width, disclosureOk, d);
	if (width < XL) check(3, width, m.cardBottom <= m.resultsTop + TOL, { cardBottom: m.cardBottom, resultsTop: m.resultsTop });
}

function judgePostRun(width, m, facts) {
	if (m.error) throw new Unmeasured(`post-run @${width}: ${m.error}`);
	check(6, width, m.multiLine.length === 0, m.multiLine.length ? m.multiLine : undefined);
	check(
		7,
		width,
		m.clipped.length === 0 && m.pastCell.length === 0,
		m.clipped.length || m.pastCell.length ? { clipped: m.clipped, pastCell: m.pastCell } : undefined,
	);
	check(12, width, m.figureOutside.length === 0, m.figureOutside.length ? m.figureOutside : undefined);
	if (width >= XL) check(13, width, m.cardBesideResults && m.columnGap >= MIN_COLUMN_GAP, { columnGap: m.columnGap });
	facts.push({ fact: 'a1-below-cutoff-column-offsets', width, pane: m.pane, rows: m.rows, ...m.a1 });
}

async function main() {
	const baseline = H.readA11yBaseline();
	const fixture = fixturePath();
	const fixtureText = fs.readFileSync(fixture, 'utf8');
	const violations = [];
	const matched = new Set();
	const facts = [];
	const audit = async (send, state, width) => {
		const { violations: found, ms } = await H.axeRun(send, ROOT);
		const cls = H.a11yClassify(found, baseline);
		for (const i of cls.matched) matched.add(i);
		for (const v of [...cls.fail.map(f => ({ ...f, fail: true })), ...cls.warn]) violations.push({ ...v, state, width });
		console.log(`axe [${state} ${width}] ${cls.fail.length} failing, ${cls.warn.length} warning (${ms} ms)`);
		for (const f of cls.fail) console.log(`FAIL a11y [${state} ${width}] ${f.id} ${f.selector} (${f.impact})`);
	};

	const { base, stop } = await serverBase();
	const chrome = await H.launchChrome();
	const client = H.cdp(chrome.wsUrl, { callTimeoutMs: 120000 });
	try {
		await client.ready;
		const { send } = await H.attachPage(client);
		for (const width of WIDTHS) {
			await setWidth(send, width);
			await send('Page.navigate', { url: `${base}${H.PAGE_PATH}` });
			await H.sleep(300);
			const opened = await H.evaluate(send, H.activateTabExpression());
			if (!opened?.ok) throw new Unmeasured(`pre-run @${width}: ${opened?.error ?? 'tab did not open'}`);
			judgePreRun(width, await H.evaluate(send, preRunExpression(width)));
			await audit(send, 'pre-run', width);
		}
		await loadFixture(send, base, fixtureText);
		for (const width of WIDTHS) {
			await setWidth(send, width);
			judgePostRun(width, await H.evaluate(send, postRunExpression), facts);
			if (width === POST_RUN_AXE_WIDTH) await audit(send, 'post-run', width);
		}
	} finally {
		client.close();
		chrome.kill();
		stop();
	}

	const stale = baseline.filter((e, i) => !matched.has(i) && e.mayNotFire !== true).map(e => `${e.ruleId} ${e.selector}`);
	for (const s of stale) console.log(`WARN a11y stale-baseline ${s} (never fired this run -- remove it)`);
	const failed = results.filter(r => !r.ok).length;
	const a11yFailed = violations.filter(v => v.fail).length;
	const pass = failed === 0 && a11yFailed === 0;
	H.verdict('measured', {
		pass,
		failed,
		a11yFailed,
		widths: WIDTHS,
		fixture: path.basename(fixture),
		checks: results,
		facts,
		violations: violations.map(({ id, selector, impact, state, width, fail, baselined }) => ({
			id,
			selector,
			impact,
			state,
			width,
			fail: !!fail,
			baselined: !!baselined,
		})),
		staleBaseline: stale,
	});
	return pass ? 0 : 1;
}

main().then(
	code => process.exit(code),
	err => {
		console.error(`test-layout: ${err?.stack ?? err}`);
		H.verdict('unmeasured', { reason: String(err?.message ?? err) });
		process.exit(1);
	},
);
