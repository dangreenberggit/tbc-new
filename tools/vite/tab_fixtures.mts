import fs from 'fs';
import { normalizePath, PluginOption } from 'vite';

import { fixtureSettledExpression, pagePathFor } from '../../test-tab-harness.mjs';

/**
 * Dev-server-only index and loader for the recorded Upgrades-tab fixtures (ticket 520).
 * `/tbc/tab-fixtures/` lists them; `<spec page>?upgrades-fixture=<name>` opens the Upgrades
 * tab on that recorded result without a run. The fixtures live in the main repo and are read
 * through Vite's `/@fs/` route. `apply: 'serve'` keeps all of this out of every build.
 */
export function tabFixtures(dir: string): PluginOption {
	const fsBase = '/tbc/@fs/' + normalizePath(dir).replace(/^\//, '') + '/';
	const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

	const autoload = `(async () => {
	const name = new URLSearchParams(location.search).get('upgrades-fixture');
	if (!name) return;
	const until = async (fn, ms) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 100)); return fn(); };
	const nav = () => document.querySelector('button[data-bs-target="#upgrades-tab"]');
	try {
		// A missing file comes back as the SPA fallback page with HTTP 200, so check the type too.
		const payload = fetch(${JSON.stringify(fsBase)} + name + '.json').then(r => {
			if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) throw new Error('no fixture named ' + name + ' (HTTP ' + r.status + ', ' + r.headers.get('content-type') + ')');
			return r.json();
		});
		payload.catch(() => {});
		if (!(await until(() => typeof window.__upgradesFixture === 'function' && nav(), 120000))) throw new Error('the Upgrades tab did not load in 120 s');
		nav().click();
		const res = await window.__upgradesFixture(await payload);
		if (!res.ok) throw new Error('fixture rejected: ' + res.reason + (res.detail ? ' (' + res.detail + ')' : ''));
		if (!(await until(() => ${fixtureSettledExpression}, 30000))) throw new Error('the table did not settle in 30 s');
		document.documentElement.dataset.upgradesFixture = 'loaded';
		console.info('[upgrades-fixture] ' + name + ': ' + res.rows + ' rows, settled ' + (performance.now() / 1000).toFixed(1) + ' s after navigation');
	} catch (e) {
		document.documentElement.dataset.upgradesFixture = 'failed';
		const msg = '[upgrades-fixture] ' + name + ': ' + (e && e.message ? e.message : e);
		console.error(msg);
		const p = document.createElement('p');
		p.id = 'upgrades-fixture-error';
		p.className = 'alert alert-danger m-2';
		p.textContent = msg;
		document.body.prepend(p);
	}
})();`;

	return {
		name: 'tab-fixtures',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use('/tbc/tab-fixtures', (req, res) => {
				if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/') {
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('Not Found');
					return;
				}
				const items = fs
					.readdirSync(dir)
					.filter(f => f.endsWith('.json'))
					.sort()
					.map(file => {
						const name = file.slice(0, -'.json'.length);
						const spec = JSON.parse(fs.readFileSync(`${dir}/${file}`, 'utf-8')).spec;
						let link = esc(name);
						try {
							link = `<a href="${pagePathFor(spec)}?upgrades-fixture=${esc(name)}">${link}</a>`;
						} catch {}
						return `<li>${link} (${esc(spec)})</li>`;
					});
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`<!doctype html><title>Tab fixtures</title><ul>${items.join('')}</ul>`);
			});
		},
		transformIndexHtml() {
			return [{ tag: 'script', children: autoload, injectTo: 'body' }];
		},
	};
}
