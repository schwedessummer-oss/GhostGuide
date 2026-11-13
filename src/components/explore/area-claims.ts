/**
 * "The newest area choice wins" for Explore.
 *
 * A place lookup (which can wait ~10 s for the shared Nominatim slot) or a
 * Near me location request can finish after the person has already chosen
 * another area: searched the map view, picked another place, pressed Back.
 * Every area choice claims the area first; a slow request checks that its
 * claim is still the current one before it moves the map, writes the URL or
 * starts a search, so a late answer can never override a newer choice.
 * Claiming also aborts the previous claim's request.
 */
export interface AreaClaim {
  /** Aborted as soon as a newer claim is made (pass it to fetch). */
  readonly signal: AbortSignal;
  /** True while no newer claim has been made. */
  isCurrent(): boolean;
}

export interface AreaClaims {
  claim(): AreaClaim;
  /** Invalidate every claim (unmount). */
  release(): void;
}

export function createAreaClaims(): AreaClaims {
  let seq = 0;
  let controller: AbortController | null = null;
  return {
    claim() {
      controller?.abort();
      const mine = ++seq;
      const ctrl = new AbortController();
      controller = ctrl;
      return { signal: ctrl.signal, isCurrent: () => mine === seq && !ctrl.signal.aborted };
    },
    release() {
      controller?.abort();
      controller = null;
      seq += 1;
    },
  };
}
