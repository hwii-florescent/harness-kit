/**
 * Pi extension entry point.
 *
 * Phase 0 wiring: symlink into `~/.pi/agent/extensions/harness-kit.mjs`, or load
 * ad hoc with `pi -e <repo>/src/tier-b/pi.mjs`.
 */

import { install } from './shared.mjs';

export default function (pi) {
  install(pi, { harness: 'pi' });
}
