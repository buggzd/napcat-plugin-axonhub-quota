# Bundled renderer

This plugin bundles unmodified `@resvg/resvg-wasm` version 2.6.2 (JavaScript wrapper and WebAssembly binary), distributed under the Mozilla Public License 2.0.

- Project and corresponding source: https://github.com/yisibl/resvg-js/tree/v2.6.2
- Package: https://www.npmjs.com/package/@resvg/resvg-wasm/v/2.6.2
- License: https://www.mozilla.org/MPL/2.0/

The renderer is loaded only by a temporary worker. Fonts are read from the host's existing font installation and are not bundled in the plugin archive.
