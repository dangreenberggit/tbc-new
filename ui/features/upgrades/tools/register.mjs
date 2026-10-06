// Registers the upgrades exporters' ESM loader hooks (see hooks.mjs).
// Pass this to node via --import; hooks.mjs itself is the hook module and
// must be registered, not imported directly.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
