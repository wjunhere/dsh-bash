// Legacy directory-entry re-export: the Loader resolves `dsh-bash` to
// `<pkg>/index.js`, while Node's exports map serves `lib/index.js` for direct
// imports. Both entry points expose the same plugin.
export { apply, Config, inject, name } from './lib/index.js'
