// Headless harness for the upgrades exporters: lets an exporter run the sim's real
// decision functions (canEquipItem and friends) under plain Node. Each shim stands in
// for a browser global some imported module touches at load time. The shims must stay
// inert placeholders: an exporter that depends on what a shim returns is borrowing UI
// behaviour, not a pure decision, and is no longer safe.
//
// No known module needs the window.location shim; whether one still does is untested.
//
//   window.location            (see above)
//   localStorage               ui/i18n/locale_service.ts     reads a saved language
//   virtual:i18next-loader     ui/i18n/config.ts             Vite-only specifier for
//                                                            the translation bundle
//                                                            (served by hooks.mjs)

const storage = {
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {},
	clear: () => {},
};

const nav = { language: 'en', languages: ['en'], userAgent: 'node' };

const location = {
	protocol: 'http:',
	host: 'localhost',
	hostname: 'localhost',
	origin: 'http://localhost',
	href: 'http://localhost/',
	pathname: '/',
	search: '',
};

const noopElement = () => ({
	style: {},
	classList: { add: () => {}, remove: () => {} },
	appendChild: () => {},
	setAttribute: () => {},
});

export function installBrowserShims(): void {
	const g = globalThis as Record<string, unknown>;
	g.localStorage ??= storage;
	g.sessionStorage ??= storage;
	g.window ??= {
		location,
		localStorage: storage,
		sessionStorage: storage,
		navigator: nav,
		addEventListener: () => {},
		removeEventListener: () => {},
		matchMedia: () => ({ matches: false, addEventListener: () => {} }),
	};
	g.document ??= {
		documentElement: { lang: 'en', classList: { add: () => {}, remove: () => {} } },
		addEventListener: () => {},
		createElement: noopElement,
		querySelector: () => null,
		querySelectorAll: () => [],
		body: { appendChild: () => {} },
	};
}
