/**
 * omp (Oh-My-Pi) extension entry point.
 *
 * Identical to pi.mjs today — omp exposes the same extension API and runs
 * Pi-authored extensions through a compatibility shim. Kept as a separate file
 * so that any future divergence has an obvious home.
 *
 * Phase 0 wiring: symlink into `~/.omp/agent/extensions/harness-kit.mjs`, or
 * load ad hoc with `omp -e <repo>/src/tier-b/omp.mjs`.
 */

import { install } from './shared.mjs';

export default function (pi) {
  install(pi, { harness: 'omp' });
}
