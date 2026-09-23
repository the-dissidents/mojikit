import type { DOMAdapter } from ".";

export type Options = {
    /**
     * If `mojikit` is run without a browser context, eg. as an Astro middleware, you should supply a DOM polyfill. For example using `happy-dom`:
     * 
     * ```typescript
        domAdapter: async (html) => {
            const { Window } = await import("happy-dom");
            const dom = new Window().document;
            dom.write(html);
            return dom as unknown as Document;
        }
     * ```
     */
    domAdapter?: DOMAdapter;

    /** Embed debug information in the output that is required by the Astro inspector toolbar app. This will greatly increase output size and processing time. */
    isDev?: boolean,
    rulesets: CharacterRuleset[],

    /** Half detection window. */
    halfDetectionWindow: number,

    /** Decay base `a` in the detection window, typically <= 1. E.g. a character that is `n` character away from the inspected one gets a multiplier of `a^n`. */
    weightDecay?: number,

    startAtElement?: string,
    warnIfStartElementNotFound?: boolean,
    ambiguousThreshold?: number,

    /** Optional label used in console warnings (e.g. the request URL). */
    label?: string,

    classnames: {
        squeezeLeft?: string,
        squeezeRight?: string,
        squeezeMiddle?: string,
        quarter?: string,
        ambiguous?: string,
    }
}

export type CharacterRuleset = {
    /**
     * Heuristic detection regex for this ruleset. Not matching it does NOT mean this ruleset will not be used on a character. Instead, it is used statistically; this ruleset will apply to a character if *most characters around it* match this regex. If undefined, it will match if no other ruleset's heuristic matches.
     */
    heuristic?: RegExp,
    weight?: number,

    /**
     * The custom element name that is used to wrap characters that this ruleset applies to, e.g. `mjk-chs` or `mjk-lat`. For the definition of valid custom element names, refer to https://html.spec.whatwg.org/multipage/custom-elements.html#custom-elements-core-concepts.
     */
    tagName?: string,

    addClass?: RegExp,

    /**
     * Indicate the character can be compressed from the left side.
     */
    squeezeLeft?: RegExp,

    /**
     * Indicate the character can be compressed from the right side.
     */
    squeezeRight?: RegExp,

    /**
     * Indicate the character can be compressed from both sides.
     */
    squeezeMiddle?: RegExp,

    /**
     * Insert a word joiner (U+2060) before a character that matches it.
     */
    noBreakBefore?: RegExp,

    /**
     * Insert a word joiner (U+2060) after a character that matches it.
     */
    noBreakAfter?: RegExp,
};

export const SimplifiedChineseRules: CharacterRuleset = {
    heuristic: /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2fa1f}\u{30000}-\u{3134a}“”‘’—·⸺⋯…\d]/u,
    tagName: 'mjk-chs',
    squeezeLeft: /[“‘《（「『]/,
    squeezeRight: /[”’》）」』，。、：；？！]/,
    noBreakBefore: /[”’》）」』，。、：；？！—·⸺⋯－]/,
    noBreakAfter: /[“‘《（「『—·⸺⋯－]/,
    addClass: /[—·⸺⋯－…]/,
};

export const LatinRules: CharacterRuleset = {
    heuristic: /[\u0021-\u007e\u00a1-\u00ff\p{Script=Latin}“”‘’]/u,
    tagName: 'mjk-lat',
};

const boundary = new Set([
    // block-level elements
    'address', 'article', 'aside', 'blockquote', 'canvas', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'noscript', 'ol', 'p', 'pre', 'section', 'table', 'tfoot', 'ul', 'video', 'tr', 'td', 'th', 
    // plus BR
    'br'
]);

const ignore = new Set(['script', 'style', 'svg']);

// nodeType constants, used instead of `instanceof` so that the same code works
// across DOM implementations (and across iframes in a browser context).
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

type Character = {
    ch: string,
    pos: number,
    from: Text,
    flags: string[],
    tagName?: string,
    ambiguous?: boolean,
    matches: string[],
    scores: Record<string, number>,
    classnames: (string | undefined)[],
};

class Context {
    chars: Character[] = [];
};

const whitespace = /[ \n\t]/;

function lineWhitespacePositions(data: string) {
    const ignored = new Set<number>();
    let lineStart = 0;

    for (;;) {
        const nl = data.indexOf('\n', lineStart);
        const lineEnd = nl === -1 ? data.length : nl;

        if (nl !== -1) ignored.add(nl);

        let i = lineStart;
        while (i < lineEnd && whitespace.test(data[i]))
            ignored.add(i++);

        let j = lineEnd - 1;
        while (j > i && whitespace.test(data[j]))
            ignored.add(j--);

        if (nl === -1) break;
        lineStart = nl + 1;
    }

    return ignored;
}

function extract(body: Element) {
    const contexts: Context[] = [];
    let current = new Context();

    function flush() {
        if (current.chars.length == 0) return;
        contexts.push(current);
        current = new Context();
    }

    function traverse(n: Node) {
        if (n.nodeType === TEXT_NODE) {
            const text = n as Text;
            if (text.data.trim().length == 0)
                return;
            const ignored = lineWhitespacePositions(text.data);
            for (let i = 0; i < text.data.length; i++) {
                if (ignored.has(i))
                    continue;
                current.chars.push({
                    ch: text.data[i], scores: {}, matches: [],
                    pos: i, from: text, flags: [], classnames: []
                });
            }
        } else if (n.nodeType === ELEMENT_NODE) {
            const el = n as Element;
            if (ignore.has(el.tagName.toLowerCase()))
                return;

            const interrupt = boundary.has(el.tagName.toLowerCase());
            if (interrupt) flush();
            for (const child of el.childNodes)
                traverse(child);
            if (interrupt) flush();
        }
    }

    traverse(body);
    flush();

    return contexts;
}

type Range = {
    start: number,
    end: number,
    tagName: string,
    classnames: string[],
    flags: string[],
    matches: string[],
    scores?: Record<string, number>,
    replace?: string
};

function wrapRanges(node: Text, ranges: Range[], doc: Document, isDev: boolean) {
    const sortedRanges = [...ranges].sort((a, b) => b.start - a.start);
    const newRanges: Range[] = [];
    let prev: Range | undefined;
    for (let i = 0; i < sortedRanges.length; i++) {
        const cur = sortedRanges[i];
        if (prev) {
            if (cur.start == prev.end
             && cur.replace == undefined
             && cur.classnames.length == prev.classnames.length
             && !cur.classnames.find((x) => !prev!.classnames.includes(x))
            ) {
                prev.end = cur.start;
                continue;
            } else {
                newRanges.push(prev);
            }
        }
        prev = cur;
    }
    if (prev) newRanges.push(prev);

    sortedRanges.forEach((range) => {
        if (range.end < node.data.length)
            node.splitText(range.end);

        const middleNode = node.splitText(range.start);
        const element = doc.createElement(range.tagName);
        range.classnames.forEach((x) => element.classList.add(x));

        if (isDev) {
            if (range.flags.length > 0)
                element.dataset['mjk-flags'] = range.flags.join(' ');
            if (range.matches.length > 0)
                element.dataset['mjk-matches'] = range.matches.join(' ');
            if (range.scores)
                element.dataset['mjk-scores'] = JSON.stringify(range.scores);
        }

        middleNode.parentNode!.insertBefore(element, middleNode);
        element.appendChild(middleNode);
        if (range.replace !== undefined)
            middleNode.data = range.replace;
    });
}

type MatchedCharacter = Character & {match: boolean[]};

/**
 * Apply mojikumi markup to an already-parsed DOM, mutating it in place. This
 * is the DOM-agnostic core; it relies only on standard DOM APIs.
 */
export function processDocument(dom: Document, opt: Options): void {
    function vote(m: MatchedCharacter[], i: number) {
        if (opt.rulesets.length == 0) return [];
        const x = m[i];

        x.scores = {};
        const start = Math.max(0, i - opt.halfDetectionWindow);
        const window = m.slice(
            start,
            Math.min(m.length, i + opt.halfDetectionWindow + 1)
        );
        const center = i - start;
        const histogram = opt.rulesets
            .map((r, j) => ({
                ruleset: r, 
                score: window.reduce((p, c, k) => {
                    let score = c.match[j] ? 1 : 0;

                    // weight only applies to unanimous cases
                    if (c.match.filter(Boolean).length == 1) {
                        const idx = c.match.indexOf(true);
                        if (idx == j) score = r.weight ?? 1;
                    }

                    const multiplier = opt.weightDecay
                        ? Math.pow(opt.weightDecay, Math.abs(k - center))
                        : 1;
                    return p + score * multiplier;
                }, 0)
            }))
            .sort((a, b) => b.score - a.score);

        histogram.forEach(({ ruleset: r, score }) => {
            if (r.tagName)
                x.scores[r.tagName] = score;
        });

        if (histogram.length > 1
            && histogram[1].score > 0
            && histogram[0].score
                < histogram[1].score * (opt.ambiguousThreshold ?? 1.5))
        {
            x.ambiguous = true;
        }
        return histogram;
    }

    const body = opt.startAtElement 
        ? dom.querySelector(opt.startAtElement)
        : dom.body;

    if (!body) {
        if (opt.warnIfStartElementNotFound)
            console.warn('[mojikit] starting element not found:', opt.label ?? '');
        return;
    }

    let ambiguous = 0;
    let modifications = new Map<Text, Range[]>();

    for (const ctx of extract(body)) {
        const m = ctx.chars.map((x) => {
            const explicit = opt.rulesets.map((r) => r.heuristic?.test(x.ch));
            const noExplicitMatch = !explicit.find((x) => !!x);
            const match = explicit.map((m) => m === undefined ? noExplicitMatch : m);
            x.matches = opt.rulesets
                .map((x, i) => explicit[i] ? x.tagName : undefined)
                .filter(Boolean) as string[];
            return { ...x, match };
        });

        m.forEach((x, i) => {
            let ruleset: CharacterRuleset;

            if (x.match.filter(Boolean).length == 1) {
                // when only one ruleset's heuristics matches this character.
                // we simply assume that this language applies to it
                const idx = x.match.indexOf(true);
                ruleset = opt.rulesets[idx];
                
                // in dev mode we still compute the vote for visualization
                if (opt.isDev) vote(m, i);

            } else {
                // otherwise we compute a vote result based on nearby characters
                const histogram = vote(m, i);
                ruleset = histogram[0].ruleset;
            }

            if (ruleset.squeezeLeft?.test(x.ch)) {
                x.flags.push('sql');
            }
            if (ruleset.squeezeMiddle?.test(x.ch)) {
                x.flags.push('sqm');
            }
            if (ruleset.squeezeRight?.test(x.ch)) {
                x.flags.push('sqr');
            }
            if (ruleset.noBreakBefore?.test(x.ch)) {
                x.flags.push('nbb');
            }
            if (ruleset.noBreakAfter?.test(x.ch)) {
                x.flags.push('nba');
            }

            if (x.flags.length > 0 || ruleset.addClass?.test(x.ch)) {
                x.flags.push('punct');
            }

            if (ruleset.tagName && (x.flags.length > 0 || opt.isDev))
                x.tagName = ruleset.tagName;
        });

        m.forEach((x, i) => {
            const prev = m[i-1];
            const next = m[i+1];

            /**
             * Squeezing Logic:
             * 
             * Check the next character
             * 
             * Squeeze Right [-> Squeeze Left] = sqr 1/2
             * Squeeze Right [-> Other] = sqr 1/4
             * 
             * Squeeze Middle [-> Squeeze Left] = sqr 1/4
             * Squeeze Middle [-> Squeeze Middle] = sqr 1/4
             * 
             * Check the previous character
             * 
             * [Squeeze Right ->] Squeeze Left = sql 1/2
             * [Other ->] Squeeze Left = sql 1/4
             * 
             * [Squeeze Right ->] Squeeze Middle = sql 1/4
             * [Squeeze Middle ->] Squeeze Middle = sql 1/4
             */

            // sqr + sql
            if (x.flags.includes('sqr') && next?.flags.includes('sql'))
                x.classnames.push(opt.classnames.squeezeRight);
            else if (x.flags.includes('sqr'))
                x.classnames.push(opt.classnames.squeezeRight, opt.classnames.quarter);

            if (x.flags.includes('sqm') && 
                    (next?.flags.includes('sql') || next?.flags.includes('sqm')))
                x.classnames.push(opt.classnames.squeezeRight, opt.classnames.quarter);
            
            if (prev?.flags.includes('sqr') && x.flags.includes('sql'))
                x.classnames.push(opt.classnames.squeezeLeft);
            else if (x.flags.includes('sql'))
                x.classnames.push(opt.classnames.squeezeLeft, opt.classnames.quarter);

            if (x.flags.includes('sqm') && 
                    (prev?.flags.includes('sqr') || prev?.flags.includes('sqm')))
                x.classnames.push(opt.classnames.squeezeLeft, opt.classnames.quarter);

            if (x.flags.includes('sqm'))
                x.classnames.push(opt.classnames.squeezeMiddle);
                
            // nobreak
            let replace: string | undefined;
            if (x.flags.includes('nbb'))
                replace = '\u2060' + (replace ?? x.ch);
            if (x.flags.includes('nba'))
                replace = (replace ?? x.ch) + '\u2060';
            
            if (x.tagName && (x.classnames.length > 0 || opt.isDev)) {
                if (x.classnames.length > 0 && x.ambiguous) {
                    ambiguous++;
                    if (opt.classnames.ambiguous)
                        x.classnames.push(opt.classnames.ambiguous);
                }

                if (!modifications.has(x.from))
                    modifications.set(x.from, []);

                modifications.get(x.from)!.push({
                    start: x.pos,
                    end: x.ch.length + x.pos,
                    tagName: x.tagName,
                    classnames: x.classnames.filter(Boolean) as string[],
                    flags: x.flags,
                    matches: x.matches,
                    scores: x.scores,
                    replace
                });
            }
        })
    }

    if (ambiguous > 0)
        console.warn(`[mojikit] ${opt.label ?? ''}: ${ambiguous} ambiguous character(s) found`)
    
    for (const [t, r] of modifications)
        wrapRanges(t, r, dom, !!opt.isDev);

    if (opt.isDev) {
        const config = dom.createElement('script');
        config.setAttribute('type', 'application/json');
        config.setAttribute('id', 'mojikit-config');
        config.textContent = JSON.stringify({
            rulesets: opt.rulesets.map((r) => ({ tagName: r.tagName, weight: r.weight })),
            classnames: opt.classnames,
            halfDetectionWindow: opt.halfDetectionWindow,
            ambiguousThreshold: opt.ambiguousThreshold,
        });
        (dom.head ?? dom.body)?.appendChild(config);
    }
}
