import { useEffect, type RefObject } from "react";

type GlideOptions = {
  /** Items the hover highlight follows. Omit for no hover highlight. */
  hover?: string;
  /** The selected item, which a second highlight slides to. */
  active?: string;
  /** A scrolling list inside the host whose edges clip the highlights. */
  clip?: string;
};

/**
 * Highlights that glide between items instead of jumping: one follows the
 * pointer, one sits under the selected item and slides when the selection
 * changes. They are absolutely placed layers inside `host`; items paint over
 * them because the host's CSS lifts items with `.glide-host`.
 */
export function useGlide(host: RefObject<HTMLElement | null>, opts: GlideOptions): void {
  const { hover, active, clip } = opts;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.classList.add("glide-host");
    const hoverLayer = hover ? layer("glide-hover") : null;
    const activeLayer = active ? layer("glide-active") : null;
    for (const l of [hoverLayer, activeLayer]) if (l) el.prepend(l);

    let hovered: HTMLElement | null = null;
    let frame = 0;

    function layer(kind: string): HTMLDivElement {
      const d = document.createElement("div");
      d.className = `glide ${kind}`;
      d.setAttribute("aria-hidden", "true");
      return d;
    }

    /**
     * Where `node` sits in the host's content box. Offsets rather than client
     * rects, so a host that is still scaling in (⌘K springing open) measures
     * the same as one at rest.
     */
    function offsetIn(node: HTMLElement): { x: number; y: number } {
      let x = 0;
      let y = 0;
      let n: HTMLElement | null = node;
      while (n && n !== el) {
        x += n.offsetLeft;
        y += n.offsetTop;
        n = n.offsetParent as HTMLElement | null;
      }
      for (let p = node.parentElement; p && p !== el; p = p.parentElement) {
        x -= p.scrollLeft;
        y -= p.scrollTop;
      }
      return { x, y };
    }

    /** Moves `l` under `target`; jumps instead of sliding when it was hidden or `slide` is false. */
    function place(l: HTMLDivElement, target: HTMLElement | null, slide: boolean) {
      if (!target || !el!.contains(target)) {
        l.classList.remove("on");
        return;
      }
      const { x, y } = offsetIn(target);
      const w = target.offsetWidth;
      const h = target.offsetHeight;
      let top = 0;
      let bottom = 0;
      const box = clip ? target.closest<HTMLElement>(clip) : null;
      if (box && box !== el && el!.contains(box)) {
        const visible = offsetIn(box).y + box.clientTop;
        top = Math.max(0, visible - y);
        bottom = Math.max(0, y + h - (visible + box.clientHeight));
      }
      if (top + bottom >= h) {
        l.classList.remove("on");
        return;
      }
      const jump = !slide || !l.classList.contains("on");
      if (jump) l.style.transition = "none";
      const radius = getComputedStyle(target).borderRadius;
      l.style.borderRadius = radius;
      l.style.width = `${w}px`;
      l.style.height = `${h}px`;
      l.style.transform = `translate(${x}px, ${y}px)`;
      l.style.clipPath = top || bottom ? `inset(${top}px 0 ${bottom}px 0 round ${radius})` : "";
      l.classList.add("on");
      if (jump) {
        void l.offsetWidth;
        l.style.transition = "";
      }
    }

    const selected = () => (active ? el.querySelector<HTMLElement>(active) : null);

    function update(slide: boolean) {
      const sel = selected();
      if (activeLayer) place(activeLayer, sel, slide);
      if (hoverLayer) place(hoverLayer, hovered && hovered !== sel ? hovered : null, slide);
    }

    const schedule = (slide: boolean) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => update(slide));
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch" || !hover) return;
      const item = (e.target as Element).closest<HTMLElement>(hover);
      if (item === hovered) return;
      hovered = item && el.contains(item) ? item : null;
      update(true);
    };
    const onLeave = () => {
      hovered = null;
      update(true);
    };
    const onScroll = () => schedule(false);
    const onResize = () => schedule(false);

    // Selection and list changes show up as class and child changes.
    const mo = new MutationObserver((records) => {
      if (records.every((r) => r.target === hoverLayer || r.target === activeLayer)) return;
      if (hovered && !hovered.isConnected) hovered = null;
      schedule(true);
    });
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    el.addEventListener("pointerover", onOver);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    update(false);

    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      ro.disconnect();
      el.removeEventListener("pointerover", onOver);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      hoverLayer?.remove();
      activeLayer?.remove();
      el.classList.remove("glide-host");
    };
  }, [host, hover, active, clip]);
}
