"use client";

import { useEffect } from "react";

/**
 * Move keyboard and screen-reader focus to an element once it is on screen
 * (the GOV.UK error-summary pattern). The target needs tabIndex={-1}.
 * Server-rendered `role="alert"` content is often not announced on a full
 * page load, so focusing it is what makes the summary discoverable.
 */
export function FocusOnMount({ targetId }: { targetId: string }) {
  useEffect(() => {
    // focus() scrolls the summary into view only when it is off screen.
    document.getElementById(targetId)?.focus();
  }, [targetId]);
  return null;
}

const CARD_HASH = /^#(trail-[0-9a-f-]{36})$/;

/**
 * After "Sign in to save" the visitor comes back to the results with
 * `#trail-<id>` in the URL. The results stream in behind a loading state, so
 * the browser's own jump to the fragment can miss the card: scroll to it here
 * and put focus on its Save button.
 */
export function ReturnToCard() {
  useEffect(() => {
    const m = CARD_HASH.exec(window.location.hash);
    if (!m) return;
    const card = document.getElementById(m[1]);
    if (!card) return;
    card.scrollIntoView({ block: "start" });
    const save = card.querySelector<HTMLButtonElement>("button[data-save-trip]");
    (save ?? card).focus({ preventScroll: true });
  }, []);
  return null;
}
