import { Document, Element, Node, Text, Window } from "happy-dom";
import type { MiddlewareHandler } from "astro";

export type Options = {
    isDev?: boolean,
    rulesets: CharacterRuleset[],
    halfDetectionWindow: number,
    startAtElement?: string,
    warnIfStartElementNotFound?: boolean,
    ambiguousThreshold?: number,
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

type Character = {
    ch: string,
    pos: number,
    from: Text,
    flags: string[],
    tagName?: string,
    notes?: string,
    classnames: (string | undefined)[],
};

class Context {
    chars: Character[] = [];
};

function extract(body: Element) {
    const contexts: Context[] = [];
    let current = new Context();

    function flush() {
        if (current.chars.length == 0) return;
        contexts.push(current);
        current = new Context();
    }

    function traverse(n: Node) {
        if (n instanceof Text) {
            if (n.data.trim().length == 0)
                return;
            for (let i = 0; i < n.data.length; i++)
                current.chars.push({
                    ch: n.data[i],
                    pos: i, from: n, flags: [], classnames: []
                });
        }
        if (n instanceof Element) {
            if (ignore.has(n.tagName.toLowerCase()))
                return;

            const interrupt = boundary.has(n.tagName.toLowerCase());
            if (interrupt) flush();
            for (const child of n.childNodes)
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
    notes?: string,
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
        if (range.notes)
            element.dataset['note'] = range.notes;

        if (isDev && range.flags.length > 0)
            element.dataset['mjk-flags'] = range.flags.join(' ');

        middleNode.parentNode!.insertBefore(element, middleNode);
        element.appendChild(middleNode);
        if (range.replace !== undefined)
            middleNode.data = range.replace;
    });
}

export function mojikit(opt: Options) {
    return (async (ctx, next) => {
        const response = await next();
        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("text/html")) {
            return response;
        }

        const html = await response.text();

        const window = new Window();
        const dom = window.document;
        dom.write(html);

        const body = opt.startAtElement 
            ? dom.querySelector(opt.startAtElement)
            : dom.body;

        if (!body) {
            if (opt.warnIfStartElementNotFound)
                console.warn('[mojikit] starting element not found:', ctx.url);
        } else {
            let ambiguous = 0;
            let modifications = new Map<Text, Range[]>();

            for (const ctx of extract(body)) {
                const m = ctx.chars.map((x) => {
                    const explicit = opt.rulesets.map((r) => r.heuristic?.test(x.ch));
                    const noExplicitMatch = !explicit.find((x) => !!x);
                    const match = explicit.map((m) => m === undefined ? noExplicitMatch : m);
                    return { ...x, match }
                });

                m.forEach((x, i) => {
                    let ruleset: CharacterRuleset;

                    if (x.match.filter((x) => x).length == 1) {
                        ruleset = opt.rulesets[x.match.indexOf(true)];
                    } else {
                        if (opt.rulesets.length == 0) return;

                        const window = m.slice(
                            Math.max(0, i - opt.halfDetectionWindow),
                            Math.min(m.length, i + opt.halfDetectionWindow)
                        );
                        const histogram = opt.rulesets
                            .map((r, j) => ({
                                ruleset: r, 
                                score: window.reduce(
                                    (p, c) => p+ (c.match[j] ? (r.weight ?? 1) : 0), 0)
                            }))
                            .sort((a, b) => b.score - a.score);

                        if (histogram.length > 1
                         && histogram[1].score > 0
                         && histogram[0].score
                                < histogram[1].score * (opt.ambiguousThreshold ?? 1.5))
                        {
                            ambiguous++;
                            x.notes = `${histogram[0].ruleset.tagName}=${histogram[0].score}, ${histogram[1].ruleset.tagName}=${histogram[1].score}`;
                            if (opt.classnames.ambiguous)
                                x.classnames.push(opt.classnames.ambiguous);
                        }

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
                    
                    if (x.tagName && (x.classnames.length > 0 || x.notes || opt.isDev)) {
                        if (!modifications.has(x.from))
                            modifications.set(x.from, []);

                        modifications.get(x.from)!.push({
                            start: x.pos,
                            end: x.ch.length + x.pos,
                            tagName: x.tagName,
                            classnames: x.classnames.filter((x) => !!x) as string[],
                            flags: x.flags,
                            notes: x.notes,
                            replace
                        });
                    }
                })
            }

            if (ambiguous > 0)
                console.warn(`[mojikit] ${ctx.url}: ${ambiguous} ambiguous character(s) found`)
            
            for (const [t, r] of modifications)
                wrapRanges(t, r, dom, !!opt.isDev);
        }

        return new Response(dom.documentElement.outerHTML, {
            status: response.status,
            headers: response.headers
        });
    }) satisfies MiddlewareHandler;
}