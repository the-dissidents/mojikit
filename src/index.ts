import type { MiddlewareHandler } from "astro";
import { processDocument, type Options } from "./Core";

export type { Options, CharacterRuleset } from "./Core";
export { processDocument, SimplifiedChineseRules, LatinRules } from "./Core";

export type DOMAdapter = (html: string) => Document | Promise<Document>;

const browserAdapter: DOMAdapter = (html) => new DOMParser().parseFromString(html, "text/html");

/** Run `mojikit` on an HTML string. */
export async function processHTML(html: string, opt: Options): Promise<string> {
    const adapter = opt.domAdapter ?? browserAdapter;
    const dom = await adapter(html);
    processDocument(dom, opt);
    return dom.documentElement.outerHTML;
}

/** `mojikit` as an Astro middleware */
export function mojikit(opt: Options) {
    return (async (ctx, next) => {
        const response = await next();
        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("text/html"))
            return response;

        const html = await response.text();
        const processed = await processHTML(html, { ...opt, label: ctx.url.toString() });

        return new Response(processed, {
            status: response.status,
            headers: response.headers
        });
    }) satisfies MiddlewareHandler;
}
