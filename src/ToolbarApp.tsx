import { defineToolbarApp } from "astro/toolbar";

type RulesetConfig = { tagName?: string; weight?: number };
type Config = {
    rulesets: RulesetConfig[];
    classnames: Record<string, string | undefined>;
    halfDetectionWindow: number;
    ambiguousThreshold?: number;
};

type PaletteEntry = {
    tagName: string;
    rgb: [number, number, number];
    hex: string;
    weight?: number;
    count: number;
};

const VIS_STYLE_ID = "mojikit-viz-style";
const AUX_STYLE_ID = "mojikit-aux-style";
const TOOLTIP_ID = "mojikit-tooltip";
const MARK_ATTR = "data-mjk-viz";

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    s /= 100;
    l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) =>
        l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function toHex(rgb: [number, number, number]): string {
    return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export default defineToolbarApp({
    init(canvas, app) {
        let palette = new Map<string, PaletteEntry>();
        let enabled = true;
        let windowElement: HTMLElement | null = null;
        let active = false;
        let dragging = false;

        buildUI();
        buildPalette();
        ensureAuxStyle();
        setupOutsideClick();
        setupDrag();

        app.onToggled(({ state }) => {
            active = state;
            if (state) refresh();
            else removeVisualization();
        });

        app.onToolbarPlacementUpdated(({ placement }) => {
            if (windowElement && "placement" in windowElement) {
                (windowElement as any).placement = placement;
            }
        });

        document.addEventListener("astro:after-swap", onNavigation);
        document.addEventListener("astro:page-load", onNavigation);
        document.addEventListener("mouseover", onMouseOver);
        document.addEventListener("mouseout", onMouseOut);

        function onNavigation() {
            buildPalette();
            refresh();
        }

        function readConfig(): Config {
            const el = document.getElementById("mojikit-config");
            if (el?.textContent) {
                try {
                    return JSON.parse(el.textContent);
                } catch {
                    /* fall through to DOM discovery */
                }
            }
            const tagNames = new Set<string>();
            document
                .querySelectorAll(`[data-mjk-scores]`)
                .forEach((n) => tagNames.add(n.tagName.toLowerCase()));
            return {
                rulesets: [...tagNames].map((tagName) => ({ tagName })),
                classnames: {},
                halfDetectionWindow: 0,
            };
        }

        function buildPalette() {
            palette.clear();
            const { rulesets } = readConfig();
            let tagged = rulesets.filter((r) => r.tagName);
            if (tagged.length === 0) {
                const tagNames = new Set<string>();
                document
                    .querySelectorAll(`[data-mjk-scores]`)
                    .forEach((n) => tagNames.add(n.tagName.toLowerCase()));
                tagged = [...tagNames].map((tagName) => ({ tagName }));
            }
            tagged.forEach((r, i) => {
                const hue = Math.round((i * 137.508) % 360);
                const rgb = hslToRgb(hue, 72, 55);
                palette.set(r.tagName!, {
                    tagName: r.tagName!,
                    rgb,
                    hex: toHex(rgb),
                    weight: r.weight,
                    count: 0,
                });
            });
        }

        function buildUI() {
            windowElement = document.createElement("astro-dev-toolbar-window");
            windowElement.innerHTML = `
                <style>
                    .mjk-panel {
                        color: #fff;
                        font-family: system-ui, sans-serif;
                        font-size: 14px;
                        min-width: 320px;
                        max-width: 480px;
                    }
                    * { box-sizing: border-box; }
                    header {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 16px;
                        margin-bottom: 8px;
                    }
                    h2 { margin: 0; font-size: 16px; }
                    .mjk-hint { color: rgba(204, 206, 216, 1); margin: 0 0 16px; font-size: 12px; }
                    label.mjk-toggle {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        font-size: 13px;
                        cursor: pointer;
                        user-select: none;
                    }
                    #mjk-legend {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }
                    .mjk-legend-item {
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 4px 8px;
                        border-radius: 6px;
                        background: rgba(255, 255, 255, 0.04);
                    }
                    .mjk-swatch {
                        width: 14px;
                        height: 14px;
                        border-radius: 4px;
                        flex: 0 0 auto;
                        border: 1px solid rgba(255, 255, 255, 0.25);
                    }
                    .mjk-legend-name { font-family: monospace; flex: 1; }
                    .mjk-legend-count { color: rgba(145, 152, 173, 1); font-variant-numeric: tabular-nums; }
                    .mjk-empty { color: rgba(145, 152, 173, 1); font-size: 12px; }
                    header {
                        cursor: move;
                        user-select: none;
                    }
                    label.mjk-toggle { cursor: pointer; }
                </style>
                <div class="mjk-panel">
                    <header>
                        <h2>mojikit &middot; language detection</h2>
                        <label class="mjk-toggle">
                            <input type="checkbox" id="mjk-toggle" checked />
                            Highlight
                        </label>
                    </header>
                    <p class="mjk-hint">
                        Each character is tinted by the mix of ruleset scores.
                        Hover a character to inspect its scores.
                    </p>
                    <div id="mjk-legend"></div>
                </div>
            `;
            canvas.append(windowElement);

            const toggle = windowElement.querySelector("#mjk-toggle");
            toggle?.addEventListener("change", (e) => {
                enabled = (e.target as HTMLInputElement).checked;
                refresh();
            });
        }

        function setupOutsideClick() {
            function onPageClick(event: Event) {
                if (!active) return;
                const target = event.target as Element | null;
                if (!target || typeof target.closest !== "function") return;
                if (target.closest("astro-dev-toolbar")) return;
                app.toggleState({ state: false });
            }
            document.addEventListener("click", onPageClick, true);
        }

        function setupDrag() {
            const el = windowElement;
            const handle = el?.querySelector("header");
            if (!el || !handle) return;

            el.style.opacity = "0.6";
            el.addEventListener("mouseenter", () => {
                if (!dragging) el.style.opacity = "1";
            });
            el.addEventListener("mouseleave", () => {
                if (!dragging) el.style.opacity = "0.6";
            });

            let startX = 0;
            let startY = 0;
            let startLeft = 0;
            let startTop = 0;

            handle.addEventListener("mousedown", (e) => {
                if ((e.target as Element).closest(".mjk-toggle")) return;
                dragging = true;
                const rect = el.getBoundingClientRect();
                startX = e.clientX;
                startY = e.clientY;
                startLeft = rect.left;
                startTop = rect.top;
                el.style.opacity = "1";
                e.preventDefault();
            });

            window.addEventListener("mousemove", (e) => {
                if (!dragging) return;
                el.style.position = "fixed";
                el.style.left = `${startLeft + e.clientX - startX}px`;
                el.style.top = `${startTop + e.clientY - startY}px`;
                el.style.bottom = "auto";
                el.style.right = "auto";
                el.style.transform = "none";
            });

            window.addEventListener("mouseup", () => {
                dragging = false;
                el.style.opacity = "0.9";
            });
        }

        function renderLegend() {
            const legend = windowElement?.querySelector("#mjk-legend");
            if (!legend) return;
            if (palette.size === 0) {
                legend.innerHTML = `<div class="mjk-empty">No mojikit elements found on this page.</div>`;
                return;
            }
            legend.innerHTML = [...palette.values()]
                .map(
                    (p) => `
                        <div class="mjk-legend-item">
                            <span class="mjk-swatch" style="background:${p.hex}"></span>
                            <span class="mjk-legend-name">${escapeHtml(p.tagName)}${
                                p.weight ? ` (w=${p.weight})` : ""
                            }</span>
                            <span class="mjk-legend-count">${p.count}</span>
                        </div>
                    `,
                )
                .join("");
        }

        function blend(scores: Record<string, number>): string {
            let r = 0;
            let g = 0;
            let b = 0;
            let total = 0;
            let max = 0;
            for (const [tag, score] of Object.entries(scores)) {
                const entry = palette.get(tag);
                if (!entry) continue;
                total += score;
                max = Math.max(max, score);
                r += entry.rgb[0] * score;
                g += entry.rgb[1] * score;
                b += entry.rgb[2] * score;
            }
            if (total <= 0) return "";
            const confidence = max / total;
            const alpha = 0.18 + 0.55 * confidence;
            return `rgba(${Math.round(r / total)}, ${Math.round(g / total)}, ${Math.round(b / total)}, ${alpha.toFixed(3)})`;
        }

        function ensureVizStyle() {
            if (document.getElementById(VIS_STYLE_ID)) return;
            const style = document.createElement("style");
            style.id = VIS_STYLE_ID;
            style.textContent = `[${MARK_ATTR}] { background-color: var(--mjk-bg, rgba(0, 0, 0, 0.05)); }`;
            document.head.appendChild(style);
        }

        function ensureAuxStyle() {
            if (document.getElementById(AUX_STYLE_ID)) return;
            const style = document.createElement("style");
            style.id = AUX_STYLE_ID;
            style.textContent = `
                #${TOOLTIP_ID} {
                    position: fixed;
                    z-index: 2147483647;
                    pointer-events: none;
                    display: none;
                    max-width: 360px;
                    padding: 10px 12px;
                    background: rgba(19, 21, 26, 0.96);
                    border: 1px solid rgba(52, 56, 65, 1);
                    border-radius: 8px;
                    color: #fff;
                    font-family: system-ui, sans-serif;
                    font-size: 12px;
                    line-height: 1.5;
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
                }
                #${TOOLTIP_ID} .mjk-tt-title { margin-bottom: 6px; font-size: 13px; }
                #${TOOLTIP_ID} .mjk-tt-title code { color: rgba(224, 204, 250, 1); }
                #${TOOLTIP_ID} .mjk-tt-row {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                #${TOOLTIP_ID} .mjk-tt-row code { min-width: 72px; }
                #${TOOLTIP_ID} .mjk-tt-score {
                    text-align: right;
                    min-width: 40px;
                    font-variant-numeric: tabular-nums;
                }
                #${TOOLTIP_ID} .mjk-tt-pct {
                    color: rgba(145, 152, 173, 1);
                    text-align: right;
                    min-width: 40px;
                    font-variant-numeric: tabular-nums;
                }
                #${TOOLTIP_ID} .mjk-tt-meta { color: rgba(145, 152, 173, 1); margin-top: 2px; }
            `;
            document.head.appendChild(style);
        }

        function refresh() {
            if (!enabled) {
                removeVisualization();
                return;
            }
            ensureVizStyle();
            palette.forEach((p) => (p.count = 0));
            document.querySelectorAll(`[data-mjk-scores]`).forEach((el) => {
                const raw = el.getAttribute("data-mjk-scores");
                if (!raw) return;
                let scores: Record<string, number>;
                try {
                    scores = JSON.parse(raw);
                } catch {
                    return;
                }
                const css = blend(scores);
                if (!css) return;
                el.setAttribute(MARK_ATTR, "");
                (el as HTMLElement).style.setProperty("--mjk-bg", css);
                const entry = palette.get(el.tagName.toLowerCase());
                if (entry) entry.count++;
            });
            renderLegend();
        }

        function removeVisualization() {
            document.getElementById(VIS_STYLE_ID)?.remove();
            document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => {
                el.removeAttribute(MARK_ATTR);
                (el as HTMLElement).style.removeProperty("--mjk-bg");
            });
            hideTooltip();
        }

        function onMouseOver(e: Event) {
            const el = (e.target as Element).closest?.(
                `[${MARK_ATTR}]`,
            ) as HTMLElement | null;
            if (!el) return;
            showTooltip(el);
        }

        function onMouseOut(e: Event) {
            const from = (e.target as Element).closest?.(
                `[${MARK_ATTR}]`,
            ) as HTMLElement | null;
            if (!from) return;
            const to = (e as MouseEvent).relatedTarget as Node | null;
            if (to && from.contains(to)) return;
            hideTooltip();
        }

        function showTooltip(el: HTMLElement) {
            const raw = el.getAttribute("data-mjk-scores") ?? "{}";
            let scores: Record<string, number> = {};
            try {
                scores = JSON.parse(raw);
            } catch {
                /* ignore malformed scores */
            }
            const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
            const rows = [...palette.entries()].map(([tag, p]) => {
                const score = scores[tag] ?? 0;
                const pct = Math.round((score / total) * 100);
                return { tag, score, pct, hex: p.hex };
            });
            const flags = el.getAttribute("data-mjk-flags");
            const note = el.getAttribute("data-note");
            const classes = (el.getAttribute("class") ?? "")
                .split(/\s+/)
                .filter(Boolean);

            let tooltip = document.getElementById(TOOLTIP_ID) as HTMLElement | null;
            if (!tooltip) {
                tooltip = document.createElement("div");
                tooltip.id = TOOLTIP_ID;
                document.body.appendChild(tooltip);
            }

            tooltip.innerHTML = `
                <div class="mjk-tt-title">&ldquo;${escapeHtml(
                    el.textContent ?? "",
                )}&rdquo; <code>${escapeHtml(el.tagName.toLowerCase())}</code></div>
                ${rows
                    .map(
                        (r) => `
                            <div class="mjk-tt-row">
                                <span class="mjk-swatch" style="background:${r.hex};width:10px;height:10px;border-radius:3px;"></span>
                                <code>${escapeHtml(r.tag)}</code>
                                <span class="mjk-tt-score">${r.score}</span>
                                <span class="mjk-tt-pct">${r.pct}%</span>
                            </div>
                        `,
                    )
                    .join("")}
                ${flags ? `<div class="mjk-tt-meta">flags: ${escapeHtml(flags)}</div>` : ""}
                ${classes.length ? `<div class="mjk-tt-meta">classes: ${escapeHtml(classes.join(" "))}</div>` : ""}
                ${note ? `<div class="mjk-tt-meta">note: ${escapeHtml(note)}</div>` : ""}
            `;

            const rect = el.getBoundingClientRect();
            tooltip.style.display = "block";
            const tw = tooltip.offsetWidth;
            const th = tooltip.offsetHeight;
            let left = rect.left + rect.width / 2 - tw / 2;
            let top = rect.top - th - 8;
            if (top < 4) top = rect.bottom + 8;
            left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        }

        function hideTooltip() {
            const tooltip = document.getElementById(TOOLTIP_ID);
            if (tooltip) tooltip.style.display = "none";
        }
    },
});
