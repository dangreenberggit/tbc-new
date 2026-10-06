// Node ESM loader hooks for the upgrades exporters.
//
// `ui/i18n/config.ts` imports `virtual:i18next-loader`, a specifier that only
// Vite's i18next plugin can resolve. Nothing an exporter borrows reads the
// translation bundle, so it is served as an empty module. See headless.mts for
// the full list of browser-only things the exporters shim and why.

const VIRTUAL_I18N = 'virtual:i18next-loader';

export function resolve(specifier, context, next) {
	if (specifier === VIRTUAL_I18N) return { url: VIRTUAL_I18N, shortCircuit: true };
	return next(specifier, context);
}

export function load(url, context, next) {
	if (url === VIRTUAL_I18N) {
		return { format: 'module', source: 'export default {};', shortCircuit: true };
	}
	return next(url, context);
}
