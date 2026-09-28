// A DOM-geometry + accessibility layout gate for the Upgrades tab (ticket 322).
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
// Node 22's global WebSocket -- no puppeteer, no playwright, no jsdom. The
// shared plumbing (build/serve/launch/attach/evaluate) lives in
// test-tab-harness.mjs so test-review.mjs can reuse it; this file keeps the
// assertions and main().
//
// The assertions are measured against the pre-run shell, which every viewport
// renders without a sim: the Upgrades tab builds its whole structure
// (settings card, view-controls host, sub-tab strip) in its constructor, so no
// WASM run is needed to see the layout the SCSS promises.
//
// Accessibility (visual-a11y-reviewer stage): after each pre-run probe, and once
// on the recorded fixture's results at RUN_WIDTH, axe-core runs on #upgrades-tab;
// a keyboard focus walk runs pre-run. A violation with impact critical/serious and a WCAG tag,
// not in the baseline (TBC_A11Y_BASELINE), fails the gate; moderate/minor,
// best-practice-only and baselined entries print as WARN. The verdict line
// carries a11yFailed / a11yWarned so check_layout_gate.py's contract is
// unchanged (it already blocks on any measured nonzero exit).

import {
	__dirname,
	OUT_DIR,
	PAGE_PATH,
	WIDTHS,
	HEIGHT,
	sleep,
	verdict,
	freePort,
	findChromium,
	run,
	build,
	startServer,
	launchChrome,
	cdp,
	attachPage,
	evaluate,
	RUN_WIDTH,
	MIN_ROWS,
	axeRun,
	focusWalk,
	a11yClassify,
	loadFixturePage,
} from './test-tab-harness.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OVERFLOW_TOL = 2; // px; sub-pixel rounding and scrollbar-less overflow slack

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
// The post-run legibility assertions (ticket 329).
//
// The five assertions above measure the pre-run shell. The legibility
// assertions the owner asked for target the results table, which does not
// exist until a run lands rows. Since ticket 520 they measure a recorded
// fixture's rows; the gate runs no sim. RUN_WIDTH and MIN_ROWS come from the
// harness.
// ---------------------------------------------------------------------------

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
// The DPS cell's sub-line classes that (6b), (11) and (13) measure. The fixture
// pass must find set-bonus lines; a %-arm line is checked where a fixture has one.
const SUB_LINE_CLASSES = ['upgrades-set-bonus', 'upgrades-cutoff-arm'];
const SUB_LINE_NAME = { 'upgrades-set-bonus': 'set-bonus', 'upgrades-cutoff-arm': '%-arm' };

// Measure the first MIN_ROWS rows' Slot (col 3) and DPS (col 4) cells plus the
// scroller state, at the current emulated width. Returns a plain object so all
// measurement is one round trip.
function legibilityProbeExpression() {
	return `(() => {
		const table = document.querySelector('.upgrades-results-table');
		if (!table) return { error: 'no results table' };
		// Each table scrolls inside its own host (ticket 483); the shared
		// \`.upgrades-results\` wrapper no longer scrolls.
		const wrap = table.closest('.upgrades-table-scroll');
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
		// The DPS figure is the cell's first text node; set-bonus and other
		// sub-lines are block children below it, so a Range over the whole cell
		// would count a real sub-line as the figure wrapping. (6b) checks the
		// sub-lines on their own.
		const figureHeight = td => {
			const text = [...td.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
			if (!text) return contentHeight(td);
			const range = document.createRange();
			range.selectNodeContents(text);
			return range.getBoundingClientRect().height;
		};
		const dpsCells = rows.map(tr => { const td = tr.querySelector('td:nth-child(4)'); return { ...cellInfo(td), contentH: figureHeight(td) }; });
		// Every rendered cell in the sampled rows, for the clip check.
		const allCells = rows.flatMap(tr => [...tr.querySelectorAll('td')].map(cellInfo));
		const wrapInfo = wrap ? (() => { const s = getComputedStyle(wrap); return { overflowX: s.overflowX, clientW: wrap.clientWidth, scrollW: wrap.scrollWidth, tableScrollW: table.scrollWidth }; })() : null;

		// Column alignment (ticket 423): the header cell and its body cell must
		// share a text-align, and their box edges (right for a right-aligned
		// column, left otherwise) must sit on the same line -- so a right-aligned
		// DPS header reads over its right-aligned numbers, not the left. Measured
		// on Rank (col 1), Slot (col 3) and DPS (col 4) against the first body row.
		const headRow = table.querySelector('thead tr');
		const bodyRow = rows[0];
		const alignFor = n => {
			const th = headRow ? headRow.querySelector('th:nth-child(' + n + ')') : null;
			const td = bodyRow.querySelector('td:nth-child(' + n + ')');
			if (!th || !td) return { col: n, missing: true };
			const thAlign = getComputedStyle(th).textAlign;
			const tdAlign = getComputedStyle(td).textAlign;
			const thR = th.getBoundingClientRect();
			const tdR = td.getBoundingClientRect();
			const rightish = tdAlign === 'right' || tdAlign === 'end';
			const edge = rightish ? Math.abs(thR.right - tdR.right) : Math.abs(thR.left - tdR.left);
			return { col: n, thAlign, tdAlign, rightish, edge };
		};
		const columnAlign = [1, 3, 4].map(alignFor);

		// BiS-badge crowding (ticket 423): a "★ BiS" badge that has wrapped BELOW
		// the item name (its top past the name's bottom) must clear the name by at
		// least 2px, so the tag does not sit flush against the text.
		const badgeGaps = [];
		for (const tr of rows) {
			const name = tr.querySelector('.upgrades-item-name');
			const badge = tr.querySelector('.upgrades-bis-badge');
			if (!name || !badge) continue;
			const nr = name.getBoundingClientRect();
			const br = badge.getBoundingClientRect();
			if (br.top >= nr.bottom) badgeGaps.push({ text: name.innerText, gap: br.top - nr.bottom });
		}

		// Every set-bonus sub-line in every landed results table, not the sampled
		// rows: set rows are rare, and the sample can miss them all (ticket 493).
		// The sub-line is display:block + nowrap, so its own box is the cell's
		// content box whatever the text does; only a Range over its text shows
		// the text running past the cell into Source. Hidden panes (clientWidth
		// 0) have no layout and are skipped.
		// Every DPS-cell sub-line class is measured, not only the set-bonus one:
		// the %-arm line overflowed into Source unseen while only
		// .upgrades-set-bonus was checked (ticket 506).
		const subLines = [...document.querySelectorAll(${JSON.stringify(SUB_LINE_CLASSES.map(c => `.upgrades-results-table td:nth-child(4) .${c}`).join(', '))})]
			.filter(s => s.closest('td').clientWidth > 0)
			.map(s => {
				const td = s.closest('td');
				const range = document.createRange();
				range.selectNodeContents(s);
				const r = range.getBoundingClientRect();
				return {
					cls: ${JSON.stringify(SUB_LINE_CLASSES)}.find(c => s.classList.contains(c)),
					text: s.textContent,
					rangeW: r.width,
					rangeH: r.height,
					lh: lineHeightPx(s),
					rangeRight: r.right,
					tdClientW: td.clientWidth,
					tdRight: td.getBoundingClientRect().right,
					scrollW: s.scrollWidth,
				};
			});

		return { innerWidth: window.innerWidth, bodyLh, rowRects, slotCells, dpsCells, allCells, wrapInfo, columnAlign, badgeGaps, subLines };
	})()`;
}

// Legibility assertions (6),(7),(8) at one width, on the landed rows.
// `opts.fixture` names the recorded fixture being measured (ticket 504): every
// message gets a `[fixture <name>]` prefix, and (11) fails when it finds no
// sub-line, because the fixture was chosen to have set rows.
function assertLegibility(width, m, opts = {}) {
	const results = legibilityResults(width, m, opts);
	return opts.fixture ? results.map(r => ({ ...r, msg: `[fixture ${opts.fixture}] ${r.msg}` })) : results;
}

function legibilityResults(width, m, opts) {
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
				? `[${width}] one-line cells: all Slot text and DPS figure heights <= ${LINE_MULTIPLE_ONE_LINE}x line-height (${lh.toFixed(1)}px)`
				: `[${width}] ${bad.col} cell "${bad.text}" content height ${bad.contentH.toFixed(1)} > ${LINE_MULTIPLE_ONE_LINE}x line-height ${bad.lh.toFixed(1)} -- text wrapped to multiple lines`,
		});
	}

	// (6b) Each sub-line under a DPS figure is one line of its own.
	{
		const subs = m.subLines ?? [];
		const bad = subs.find(s => s.rangeH > s.lh * LINE_MULTIPLE_ONE_LINE + 0.5);
		const counts = SUB_LINE_CLASSES.map(c => `${subs.filter(s => s.cls === c).length} ${SUB_LINE_NAME[c]}`).join(', ');
		results.push({
			ok: !bad,
			msg: bad
				? `[${width}] (6b) ${SUB_LINE_NAME[bad.cls]} sub-line "${bad.text}" height ${bad.rangeH.toFixed(1)} > ${LINE_MULTIPLE_ONE_LINE}x line-height ${bad.lh.toFixed(1)} -- it wrapped`
				: `[${width}] (6b) DPS-cell sub-lines one line each: ${counts} checked`,
		});
	}

	// (7) No clipped text. A cell whose content overflows its box WHILE an
	// ancestor hides overflow is invisible text -- fail. The sanctioned
	// `.upgrades-table-scroll` scroller is exempt (it is overflow-x:auto, not hidden)
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
				: `[${width}] table (${m.wrapInfo.tableScrollW}px) wider than its .upgrades-table-scroll host (${m.wrapInfo.clientW}px) but overflow-x is ${m.wrapInfo.overflowX} -- content clips instead of scrolling`,
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

	// (11) DPS-cell sub-lines stay inside their cell (tickets 493, 506): the
	// text's right edge within the cell's, and no scroll overflow. At >= md the
	// DPS column is fixed at 5.5rem, so a string longer than it drew over the
	// Source text at every Source width. One result per class. Only the
	// set-bonus class fails when absent from a fixture: the fixtures were chosen
	// for set rows, and not every fixture has a %-arm row.
	for (const cls of SUB_LINE_CLASSES) {
		const name = SUB_LINE_NAME[cls];
		const subs = (m.subLines ?? []).filter(s => s.cls === cls);
		const bad = subs.find(s => s.rangeRight > s.tdRight + CLIP_TOL || s.scrollW > s.tdClientW + CLIP_TOL);
		const vacuousFail = !bad && subs.length === 0 && !!opts.fixture && cls === 'upgrades-set-bonus';
		const ok = !bad && !vacuousFail;
		results.push({
			ok,
			msg: bad
				? `[${width}] (11) ${name} sub-line (.${cls}) "${bad.text}" runs ${(bad.rangeRight - bad.tdRight).toFixed(1)}px past its cell (text ${bad.rangeW.toFixed(1)}px, scroll ${bad.scrollW} vs cell ${bad.tdClientW})`
				: vacuousFail
					? `[${width}] (11) ${name} sub-lines (.${cls}): 0 present in the fixture's rows -- the fixture pass exists to check them, so 0 checked is a failure`
					: subs.length === 0
						? `[${width}] (11) ${name} sub-lines (.${cls}): 0 present (vacuous)`
						: `[${width}] (11) ${name} sub-lines (.${cls}) inside their cell: ${subs.length} checked`,
		});
	}

	// (9),(10) Narrow-width alignment (ticket 423). Only below the md breakpoint,
	// where the Step-7 mobile SCSS applies; at 768/1280 the desktop block governs
	// and this shape is not asserted.
	if (width < 768) {
		// (9) Header/body column alignment for Rank, Slot, DPS: same text-align,
		// and the shared edge (right for a right-aligned column, left otherwise)
		// within 1px, so a header sits over its own column's content edge.
		const COL_NAME = { 1: 'Rank', 3: 'Slot', 4: 'DPS' };
		const EDGE_TOL = 1; // px
		// `start`/`end` are the logical spellings of `left`/`right` in this LTR
		// table -- a <th> can compute `left` while its <td> computes `start` for
		// the same rendered edge -- so canonicalise before comparing, or an
		// unstyled column (Slot) false-fails on the spelling alone.
		const canonAlign = a => (a === 'start' ? 'left' : a === 'end' ? 'right' : a);
		for (const c of m.columnAlign ?? []) {
			if (c.missing) {
				results.push({ ok: false, msg: `[${width}] col ${c.col} alignment: header or body cell missing` });
				continue;
			}
			const aligned = canonAlign(c.thAlign) === canonAlign(c.tdAlign);
			const edgeOk = c.edge <= EDGE_TOL;
			const ok = aligned && edgeOk;
			const side = c.rightish ? 'right' : 'left';
			results.push({
				ok,
				msg: ok
					? `[${width}] ${COL_NAME[c.col]} alignment: header/body text-align ${c.thAlign}, ${side} edges within ${c.edge.toFixed(2)}px`
					: !aligned
						? `[${width}] ${COL_NAME[c.col]} alignment: header text-align ${c.thAlign} != body ${c.tdAlign}`
						: `[${width}] ${COL_NAME[c.col]} alignment: ${side} edges differ by ${c.edge.toFixed(2)}px (> ${EDGE_TOL}px)`,
			});
		}

		// (10) BiS-tag spacing: a badge wrapped below the item name clears it by
		// >= 2px. Passes vacuously when no badge wrapped in the sampled rows --
		// the crowding only exists when the tag drops onto its own line.
		{
			const BADGE_GAP_MIN = 2; // px
			const tight = (m.badgeGaps ?? []).find(g => g.gap < BADGE_GAP_MIN);
			const ok = !tight;
			results.push({
				ok,
				msg: ok
					? `[${width}] BiS-tag spacing: ${(m.badgeGaps ?? []).length} wrapped badge(s), all >= ${BADGE_GAP_MIN}px below the name`
					: `[${width}] BiS-tag "${tight.text}" only ${tight.gap.toFixed(2)}px below the item name (< ${BADGE_GAP_MIN}px)`,
			});
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// DPS cell assertions (12)-(15) (tickets 495, 499, round 2c).
//
// Measured over every visible results row, not the first five: the rows these
// check (wide figures, set rows with a tooltip) are rare and scattered. In the
// fixture pass each assertion must check at least one, or it has proved
// nothing.
// ---------------------------------------------------------------------------

const DPS_GAP_MIN = 8; // px, Slot text to the DPS figure or the set-bonus line (ticket 495)
const RING_TOL = 0.5; // px

function dpsCellProbeExpression() {
	return `(async () => {
		document.querySelectorAll('#upgrades-tab details').forEach(d => { d.open = true; });
		await new Promise(r => setTimeout(r, 100));
		const rows = [...document.querySelectorAll('.upgrades-results-table')]
			.filter(t => t.getBoundingClientRect().height > 0)
			.flatMap(t => [...t.querySelectorAll('tbody tr')])
			.filter(r => r.children.length >= 5 && r.querySelector('.upgrades-item-name'));
		const rects = el => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].filter(x => x.width > 0 && x.height > 0).map(x => ({ top: x.top, bottom: x.bottom, left: x.left, right: x.right })); };
		const textRects = el => { const out = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); for (const x of r.getClientRects()) if (x.width > 0) out.push({ top: x.top, bottom: x.bottom, left: x.left, right: x.right }); } return out; };
		const figureNode = td => [...td.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
		const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

		// (12) and (13): every row's figure against its cell, and the gaps.
		const fig = [];
		for (const tr of rows) {
			const td = tr.children[3];
			const n = figureNode(td);
			if (!n) continue;
			const f = rects(n)[0];
			if (!f) continue;
			const b = td.getBoundingClientRect(), s = getComputedStyle(td);
			const boxL = b.left + parseFloat(s.paddingLeft), boxR = b.right - parseFloat(s.paddingRight);
			const slotR = Math.max(-1e9, ...rects(tr.children[2]).map(x => x.right));
			const subGaps = ${JSON.stringify(SUB_LINE_CLASSES)}.flatMap(cls => [...td.querySelectorAll('.' + cls)].map(sub => ({ cls, gap: Math.min(...rects(sub).map(x => x.left)) - slotR })).filter(s => isFinite(s.gap)));
			fig.push({ text: n.textContent.trim(), slot: tr.children[2].innerText.trim(), overR: f.right - boxR, overL: boxL - f.left, gap: f.left - slotR, subGaps });
		}

		// Set rows with a tooltip and a neighbour on each side in the same table.
		const setRows = rows.filter(tr => tr.children[3]._tippy && tr.previousElementSibling && tr.nextElementSibling);

		// (14): focus each such row's cell; the ring must be drawn, and its band
		// must not cross text in that row or the rows beside it.
		const focus = [];
		for (const tr of setRows) {
			const td = tr.children[3];
			td.focus({ focusVisible: true });
			const st = getComputedStyle(tr);
			const w = parseFloat(st.outlineWidth) || 0;
			const drawn = st.outlineStyle !== 'none' && w > 0;
			let crossing = null;
			if (drawn) {
				// An outline starts outline-offset outside the border edge and grows
				// outward by its width: with offset -2 and width 2 it fills the row's
				// outer 2px.
				const off = parseFloat(st.outlineOffset) || 0;
				const r = tr.getBoundingClientRect();
				const inner = { top: r.top - off, bottom: r.bottom + off, left: r.left - off, right: r.right + off };
				const outer = { top: inner.top - w, bottom: inner.bottom + w, left: inner.left - w, right: inner.right + w };
				const bands = [
					{ top: outer.top, bottom: inner.top, left: outer.left, right: outer.right },
					{ top: inner.bottom, bottom: outer.bottom, left: outer.left, right: outer.right },
					{ top: outer.top, bottom: outer.bottom, left: outer.left, right: inner.left },
					{ top: outer.top, bottom: outer.bottom, left: inner.right, right: outer.right },
				].map(b => ({ top: b.top + ${RING_TOL}, bottom: b.bottom - ${RING_TOL}, left: b.left + ${RING_TOL}, right: b.right - ${RING_TOL} }));
				for (const row of [tr.previousElementSibling, tr, tr.nextElementSibling]) {
					for (const t of textRects(row)) if (bands.some(b => hit(b, t))) { crossing = row.querySelector('.upgrades-item-name')?.innerText.trim() ?? '?'; break; }
					if (crossing) break;
				}
			}
			td._tippy?.hide();
			td.blur();
			focus.push({ name: tr.querySelector('.upgrades-item-name').innerText.trim(), drawn, width: w, crossing });
		}

		// (15): the tallest hover among those rows. Right of the figure when it
		// fits, else above (owner, 2026-09-25); on screen; and when it opens to the
		// right it covers no DPS text in its own row or the rows beside it.
		const tips = [];
		for (const tr of setRows) {
			const td = tr.children[3];
			td._tippy.show();
			await new Promise(r => setTimeout(r, 60));
			const box = td._tippy.popper.querySelector('.tippy-box');
			const b = box.getBoundingClientRect();
			tips.push({ tr, height: b.height });
			td._tippy.hide();
		}
		await new Promise(r => setTimeout(r, 80));
		let hover = null;
		const tallest = tips.sort((a, b) => b.height - a.height)[0];
		if (tallest) {
			const tr = tallest.tr, td = tr.children[3];
			tr.scrollIntoView({ block: 'center' });
			await new Promise(r => setTimeout(r, 100));
			td._tippy.show();
			await new Promise(r => setTimeout(r, 200));
			const box = td._tippy.popper.querySelector('.tippy-box');
			const b = box.getBoundingClientRect();
			const tip = { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
			const cell = td.getBoundingClientRect();
			const offset = 10; // tippy's default distance
			const fitsRight = innerWidth - cell.right - offset >= b.width;
			const coveredDps = [tr.previousElementSibling, tr, tr.nextElementSibling].filter(row => textRects(row.children[3]).some(t => hit(t, tip))).map(row => row.querySelector('.upgrades-item-name')?.innerText.trim() ?? '?');
			hover = { name: tr.querySelector('.upgrades-item-name').innerText.trim(), placement: box.getAttribute('data-placement'), fitsRight, width: b.width, height: b.height, onScreen: b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1, coveredDps };
			td._tippy.hide();
		}
		return { fig, focus, hover, setRows: setRows.length };
	})()`;
}

function assertDpsCell(width, m, opts = {}) {
	const tag = opts.fixture ? `[fixture ${opts.fixture}] [${width}]` : `[${width}]`;
	const results = [];
	const need = n => !opts.fixture || n > 0; // the fixture pass must check something
	if (!m || m.error) return [{ ok: false, msg: `${tag} DPS-cell PROBE FAILED: ${m?.error ?? 'no result'}` }];

	// (12) Every DPS figure inside its cell's content box.
	{
		const bad = m.fig.find(f => f.overR > CLIP_TOL || f.overL > CLIP_TOL);
		const ok = !bad && need(m.fig.length);
		results.push({
			ok,
			msg: bad
				? `${tag} (12) DPS figure "${bad.text}" runs ${Math.max(bad.overR, bad.overL).toFixed(1)}px outside its cell`
				: `${tag} (12) DPS figures inside their cell: ${m.fig.length} checked`,
		});
	}

	// (13) Slot text to DPS figure, and to each sub-line, >= 8px. The fixed
	// columns apply from md up; below it the table sizes itself. Sub-lines of
	// every class in SUB_LINE_CLASSES are measured (ticket 506); the fixture pass
	// must find set-bonus lines, and reports %-arm lines where it has them.
	if (width >= 768) {
		const subs = m.fig.flatMap(f => f.subGaps.map(s => ({ ...s, slot: f.slot })));
		const badFig = m.fig.find(f => f.gap < DPS_GAP_MIN);
		const badSub = subs.find(s => s.gap < DPS_GAP_MIN);
		const minFig = Math.min(...m.fig.map(f => f.gap));
		const perClass = SUB_LINE_CLASSES.map(cls => {
			const g = subs.filter(s => s.cls === cls).map(s => s.gap);
			return `${g.length} ${SUB_LINE_NAME[cls]} lines (min ${g.length ? Math.min(...g).toFixed(1) : '-'}px)`;
		}).join(', ');
		const ok = !badFig && !badSub && need(m.fig.length) && need(subs.filter(s => s.cls === 'upgrades-set-bonus').length);
		results.push({
			ok,
			msg: badFig
				? `${tag} (13) Slot "${badFig.slot}" is ${badFig.gap.toFixed(1)}px from DPS figure "${badFig.text}" (< ${DPS_GAP_MIN}px)`
				: badSub
					? `${tag} (13) Slot "${badSub.slot}" is ${badSub.gap.toFixed(1)}px from its ${SUB_LINE_NAME[badSub.cls]} line (.${badSub.cls}) (< ${DPS_GAP_MIN}px)`
					: `${tag} (13) Slot-to-DPS gap >= ${DPS_GAP_MIN}px: ${m.fig.length} figures (min ${isFinite(minFig) ? minFig.toFixed(1) : '-'}px), ${perClass} checked`,
		});
	}

	// (14) The row focus ring is drawn and crosses no text.
	{
		const drawn = m.focus.filter(f => f.drawn);
		const bad = drawn.find(f => f.crossing);
		const ok = !bad && need(drawn.length);
		results.push({
			ok,
			msg: bad
				? `${tag} (14) focus ring on "${bad.name}" crosses text in row "${bad.crossing}"`
				: drawn.length === 0 && m.focus.length > 0
					? `${tag} (14) focus ring: none drawn on ${m.focus.length} focused row(s) -- :focus-visible did not match or the row rule is gone`
					: `${tag} (14) focus ring clear of text: ${drawn.length} checked`,
		});
	}

	// (15) The tallest hover opens right of the figure when it fits, else above;
	// on screen; covering no DPS text when it opens right.
	{
		const h = m.hover;
		let ok = need(h ? 1 : 0);
		let msg = `${tag} (15) hover placement: 0 checked`;
		if (h) {
			const expected = h.fitsRight ? 'right' : 'top';
			const placed = h.placement === expected;
			const clear = h.placement !== 'right' || h.coveredDps.length === 0;
			ok = placed && h.onScreen && clear;
			msg = !placed
				? `${tag} (15) hover on "${h.name}" opened ${h.placement}, expected ${expected} (fits right: ${h.fitsRight})`
				: !h.onScreen
					? `${tag} (15) hover on "${h.name}" (${h.placement}) is partly off screen`
					: !clear
						? `${tag} (15) hover on "${h.name}" opened right and covers DPS text of ${h.coveredDps.join(', ')}`
						: `${tag} (15) hover on "${h.name}" (${Math.round(h.height)}px, tallest of ${m.setRows}) opened ${h.placement} as expected: 1 checked`;
		}
		results.push({ ok, msg });
	}
	return results;
}

// ---------------------------------------------------------------------------
// Accessibility helpers (visual-a11y-reviewer stage).
// ---------------------------------------------------------------------------

// The baseline of known/accepted a11y violations, read from TBC_A11Y_BASELINE.
// Absent env -> empty baseline (strict: every critical/serious WCAG violation
// then fails). Shape: { _comment, entries: [{ ruleId, selector, ticket?, reason? }] }.
function readA11yBaseline() {
	const p = process.env.TBC_A11Y_BASELINE;
	if (!p) return [];
	try {
		const data = JSON.parse(fs.readFileSync(p, 'utf8'));
		return Array.isArray(data.entries) ? data.entries : [];
	} catch (err) {
		console.error(`a11y baseline: could not read ${p} (${err.message}); running strict (empty baseline)`);
		return [];
	}
}

// The fork HEAD, for the dump's provenance. A git absence returns null rather
// than crashing the gate.
function gitForkHead() {
	try {
		return execFileSync('git', ['-C', __dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
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

	// a11y state (visual-a11y-reviewer stage).
	const baseline = readA11yBaseline();
	const a11yFailures = [];
	const a11yWarnings = [];
	const a11yDump = []; // every raw violation, for baseline seeding via TBC_A11Y_DUMP
	const baselineMatched = new Set();
	let focusUnmeasured = false;

	const collectAxe = async (send, state, width) => {
		const res = await axeRun(send, '#upgrades-tab');
		for (const v of res.violations || []) {
			for (const n of v.nodes || []) {
				a11yDump.push({
					state,
					width,
					ruleId: v.id,
					impact: v.impact,
					help: v.help,
					helpUrl: v.helpUrl,
					tags: v.tags,
					selector: (n.target || []).join(' '),
					html: n.html,
					failureSummary: n.failureSummary,
				});
			}
		}
		return res;
	};

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

			// a11y: axe + focus walk on the pre-run shell at this width.
			const axeRes = await collectAxe(send, 'pre-run', width);
			const walk = await focusWalk(send, '#upgrades-tab');
			if (walk.unmeasured) focusUnmeasured = true;
			const cls = a11yClassify(axeRes.violations, walk, baseline, { state: 'pre-run', width });
			for (const i of cls.matched) baselineMatched.add(i);
			for (const f of cls.fail) a11yFailures.push(f);
			for (const w of cls.warn) a11yWarnings.push(w);
			if (cls.fail.length === 0)
				passes.push(
					`a11y [pre-run ${width}] no unbaselined critical/serious violations (axe ${axeRes.ms}ms${walk.unmeasured ? ', focus-walk unmeasured' : `, ${walk.missed.length} focus miss`})`,
				);
		}

		// Post-run pass (tickets 504, 520): the gate runs no sim. A recorded
		// fixture renders a finished ranking, set rows included, in seconds and is
		// measured at every width. Without TBC_TAB_FIXTURE the post-run checks are
		// skipped.
		const fixturePath = process.env.TBC_TAB_FIXTURE;
		if (fixturePath) {
			const name = path.basename(fixturePath, '.json');
			let text = null;
			try {
				text = fs.readFileSync(fixturePath, 'utf8');
			} catch (err) {
				failures.push(`[fixture ${name}] could not read ${fixturePath}: ${err.message}`);
			}
			if (text !== null) {
				const { send } = await attachPage(client);
				await send('Emulation.setDeviceMetricsOverride', { width: RUN_WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
				const loaded = await loadFixturePage(send, server.port, text);
				if (loaded.error) {
					failures.push(`[fixture ${name}] load FAILED: ${loaded.error}`);
				} else {
					console.log(`fixture ${name}: ${loaded.rows} rows settled in ${(loaded.ms / 1000).toFixed(1)}s; measuring legibility across widths...`);

					// a11y: axe once, at RUN_WIDTH, on the settled results (no focus
					// walk post-run -- the pre-run walk covers operability). One width:
					// on this full table axe took about 4 s per width (ticket 520).
					const axeRes = await collectAxe(send, 'post-run', RUN_WIDTH);
					const cls = a11yClassify(axeRes.violations, null, baseline, { state: 'post-run', width: RUN_WIDTH });
					for (const i of cls.matched) baselineMatched.add(i);
					for (const f of cls.fail) a11yFailures.push(f);
					for (const w of cls.warn) a11yWarnings.push(w);
					if (cls.fail.length === 0) passes.push(`a11y [post-run ${RUN_WIDTH}] no unbaselined critical/serious violations (axe ${axeRes.ms}ms)`);

					for (const width of WIDTHS) {
						await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
						await sleep(200);
						const lm = await evaluate(send, legibilityProbeExpression());
						for (const r of assertLegibility(width, lm, { fixture: name })) {
							if (r.ok) passes.push(r.msg);
							else failures.push(r.msg);
						}
						for (const r of assertDpsCell(width, await evaluate(send, dpsCellProbeExpression()), { fixture: name })) {
							if (r.ok) passes.push(r.msg);
							else failures.push(r.msg);
						}
					}
				}
			}
		}
	} finally {
		client.close();
		chrome.kill();
		server.proc.kill();
		try {
			await fsp.rm(chrome.userDataDir, { recursive: true, force: true });
		} catch {
			// best-effort temp cleanup
		}
	}

	// Stale-baseline warnings: entries that never fired this run. An entry
	// flagged `mayNotFire` covers debt this run's capture may not show (the
	// rare-quality item name: the recorded fixture can hold no rare item), so its
	// silence proves nothing and the "remove it" advice would be wrong.
	for (let i = 0; i < baseline.length; i++) {
		if (!baselineMatched.has(i) && baseline[i].mayNotFire !== true) {
			const e = baseline[i];
			a11yWarnings.push(`WARN a11y stale-baseline ${e.ruleId} ${e.selector} (never fired this run -- remove it)`);
		}
	}

	// Opt-in dump of every raw violation, for seeding the baseline (Step 10).
	if (process.env.TBC_A11Y_DUMP) {
		try {
			const forkHead = gitForkHead();
			fs.writeFileSync(
				process.env.TBC_A11Y_DUMP,
				JSON.stringify({ forkHead, generatedAt: new Date().toISOString(), violations: a11yDump }, null, 2) + '\n',
			);
			console.log(`a11y dump: wrote ${a11yDump.length} raw violation(s) to ${process.env.TBC_A11Y_DUMP}`);
		} catch (err) {
			console.error(`a11y dump: could not write ${process.env.TBC_A11Y_DUMP} (${err.message})`);
		}
	}

	console.log('\n--- passed ---');
	for (const p of passes) console.log('  PASS ' + p);

	if (a11yWarnings.length) {
		console.log('\n--- a11y warnings ---');
		for (const w of a11yWarnings) console.log('  ' + w);
	}

	if (focusUnmeasured) {
		console.log(
			'\n  WARN a11y focus-walk unmeasured -- synthetic Tab did not move DOM focus in this headless browser; operability was not checked (C23).',
		);
	}

	const anyFail = failures.length || a11yFailures.length;
	if (anyFail) {
		if (failures.length) {
			console.log('\n--- FAILED (layout) ---');
			for (const f of failures) console.log('  FAIL ' + f);
		}
		if (a11yFailures.length) {
			console.log('\n--- FAILED (a11y) ---');
			for (const f of a11yFailures) console.log('  ' + f);
		}
		console.error(
			`\nlayout gate: ${failures.length} layout failure(s) and ${a11yFailures.length} a11y failure(s) across widths ${WIDTHS.join(', ')}`,
		);
		verdict('measured', { passed: passes.length, failed: failures.length, a11yFailed: a11yFailures.length, a11yWarned: a11yWarnings.length });
		process.exit(1);
	}

	console.log(`\nlayout gate: OK -- ${passes.length} assertion(s) passed at widths ${WIDTHS.join(', ')}`);
	verdict('measured', { passed: passes.length, failed: 0, a11yFailed: 0, a11yWarned: a11yWarnings.length });
	process.exit(0);
}

main().catch(err => {
	console.error('layout gate crashed:', err.stack || err.message);
	// The gate never got as far as measuring geometry, so its exit 1 says
	// nothing about the tab's layout. Say so in a form the caller can read
	// without parsing a stack trace: scripts/check_layout_gate.py turns
	// `unmeasured` into an honest SKIP instead of accusing the tab.
	verdict('unmeasured', { reason: String((err && err.message) || err).split('\n')[0] });
	process.exit(1);
});
