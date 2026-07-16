// "Freeze" a transient hover/popover UI so it can be spotlighted and captured.
//
// Hover- and focus-driven menus, tooltips and popovers vanish the instant the
// pointer leaves or focus shifts — which is exactly what happens when you move
// to the toolbar to select or capture them. Freeze pins the current UI two ways
// at once:
//
//   1. Force-hold the CSS `:hover` state. Every style rule that uses `:hover`
//      gets a clone with `:hover` swapped for a marker class, and that class is
//      stamped onto the element chain under the cursor. The hover styling then
//      sticks even after the pointer leaves (this is what DevTools' "force
//      :hover" does, from a content script).
//   2. Swallow the DOM events that dismiss JS-driven popovers (mouseleave/out,
//      pointerleave/out, focusout/blur, ...) so the page's own close handlers
//      never fire.
//
// It can't defeat everything: cross-origin stylesheets are unreadable (their
// `:hover` rules can't be held), and a few widgets tear their DOM down via
// capture-phase outside-click handlers. But it holds the common cases long
// enough to compose and grab a shot.

const NOCAPTURE_ATTR = 'data-nhost-ss-nocapture';
const MARKER_CLASS = 'nhost-ss-freeze-hover';

// The "pointer/focus left" event family. Blocking these keeps JS-driven
// popovers from noticing the cursor moved away. We never touch mousemove or
// click — the tool itself relies on those.
const DISMISS_EVENTS = [
  'mouseout',
  'mouseleave',
  'mouseover',
  'mouseenter',
  'pointerout',
  'pointerleave',
  'pointerover',
  'pointerenter',
  'focusout',
  'blur',
];

function isToolNode(node: EventTarget | null): boolean {
  return (
    node instanceof Element && node.closest(`[${NOCAPTURE_ATTR}]`) !== null
  );
}

export class FreezeController {
  private frozen = false;
  private styleEl: HTMLStyleElement | null = null;
  private marked: Element[] = [];
  // Last seen cursor position, tracked continuously so freeze (triggered by a
  // hotkey, which carries no coordinates) knows what UI is under the pointer.
  private pointer: { x: number; y: number; known: boolean } = {
    x: 0,
    y: 0,
    known: false,
  };

  /** Invoked when freeze ends by its own doing (Escape), so the toolbar can
   * sync its state (leave select mode, drop the on-screen hint). */
  onEnd: () => void = () => {};

  private readonly trackPointer = (event: MouseEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY, known: true };
  };

  private readonly swallow = (event: Event): void => {
    // The tool's own UI (its no-capture shadow host) must keep behaving
    // normally — only block dismissal events bound for the page.
    if (isToolNode(event.target)) {
      return;
    }
    event.stopImmediatePropagation();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.end();
      this.onEnd();
    }
  };

  constructor() {
    document.addEventListener('mousemove', this.trackPointer, true);
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  /** Freeze whatever hover/popover UI is currently showing under the cursor. */
  begin(): void {
    if (this.frozen) {
      return;
    }
    this.frozen = true;
    this.markHoverChain();
    this.installForcedHover();
    for (const type of DISMISS_EVENTS) {
      window.addEventListener(type, this.swallow, true);
    }
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  /** Release the freeze and undo every page mutation it made. */
  end(): void {
    if (!this.frozen) {
      return;
    }
    this.frozen = false;
    document.removeEventListener('keydown', this.onKeyDown, true);
    for (const type of DISMISS_EVENTS) {
      window.removeEventListener(type, this.swallow, true);
    }
    this.styleEl?.remove();
    this.styleEl = null;
    for (const el of this.marked) {
      el.classList.remove(MARKER_CLASS);
    }
    this.marked = [];
  }

  /** Full teardown, including the always-on pointer tracker. */
  destroy(): void {
    this.end();
    document.removeEventListener('mousemove', this.trackPointer, true);
  }

  // Stamp the marker class onto every page element under the cursor (the
  // element plus its ancestors), so the substitute `:hover` rules match them.
  private markHoverChain(): void {
    if (!this.pointer.known) {
      return;
    }
    for (const el of document.elementsFromPoint(
      this.pointer.x,
      this.pointer.y,
    )) {
      if (isToolNode(el)) {
        continue;
      }
      el.classList.add(MARKER_CLASS);
      this.marked.push(el);
    }
  }

  // Append a stylesheet of `:hover` rules rewritten to fire on the marker class
  // instead, so the hover styling holds without a live cursor.
  private installForcedHover(): void {
    const chunks: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | undefined;
      try {
        rules = sheet.cssRules;
      } catch {
        // Cross-origin stylesheet: rules are unreadable — skip it.
        continue;
      }
      if (rules) {
        this.collectHoverRules(rules, chunks);
      }
    }
    if (chunks.length === 0) {
      return;
    }
    const styleEl = document.createElement('style');
    styleEl.setAttribute(NOCAPTURE_ATTR, '');
    styleEl.textContent = chunks.join('\n');
    (document.head ?? document.documentElement).appendChild(styleEl);
    this.styleEl = styleEl;
  }

  // Collect substitute rules for every `:hover` rule, preserving @media /
  // @supports context so conditional hover styles still apply.
  private collectHoverRules(rules: CSSRuleList, out: string[]): void {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (rule.selectorText.includes(':hover')) {
          const selector = rule.selectorText.replace(
            /:hover/g,
            `.${MARKER_CLASS}`,
          );
          out.push(`${selector}{${rule.style.cssText}}`);
        }
      } else if (rule instanceof CSSMediaRule) {
        const inner: string[] = [];
        this.collectHoverRules(rule.cssRules, inner);
        if (inner.length) {
          out.push(`@media ${rule.conditionText}{${inner.join('\n')}}`);
        }
      } else if (rule instanceof CSSSupportsRule) {
        const inner: string[] = [];
        this.collectHoverRules(rule.cssRules, inner);
        if (inner.length) {
          out.push(`@supports ${rule.conditionText}{${inner.join('\n')}}`);
        }
      }
    }
  }
}
