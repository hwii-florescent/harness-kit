/**
 * Pi extension entry point.
 *
 * Phase 0 wiring: `pi install <repo>` registers the package; load ad hoc with
 * `pi -e <repo>/src/tier-b/pi.mjs` when testing without changing registration.
 */

import { install } from './shared.mjs';

export default function (pi) {
  install(pi, { harness: 'pi' });
}
