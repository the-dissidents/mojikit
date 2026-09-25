# mojikit

Rule-based mojikumi for Astro, applied at build time via middleware. It parses the HTML output of each page, classifies characters against a set of rulesets, and wraps them in custom elements with class names so that spacing can be controlled purely in CSS. It also inserts word joiners (U+2060) where line breaks are not allowed.

This is an internal tool and is still in early development.

## Usage

```ts
import { defineMiddleware } from "astro:middleware";
import { mojikit, SimplifiedChineseRules, LatinRules } from "mojikit";

export const onRequest = defineMiddleware(
  mojikit({
    // Astro middleware doesn't have a browser context
    // a polyfill such as `happy-dom` is required
    domAdapter: async (html) => {
      const { Window } = await import("happy-dom");
      const dom = new Window().document;
      dom.write(html);
      return dom as unknown as Document;
    },
    rulesets: [SimplifiedChineseRules, LatinRules],
    halfDetectionWindow: 5,
    classnames: {
      squeezeLeft: "mjk-sq-l",
      squeezeRight: "mjk-sq-r",
      squeezeMiddle: "mjk-sq-m",
      quarter: "mjk-q",
      ambiguous: "mjk-amb",
    },
  }),
);
```

The middleware only touches responses with a `text/html` content type.

## Standalone usage

The core processor is also exposed directly and can be used outside Astro:

```ts
import { processHTML, SimplifiedChineseRules, LatinRules } from "mojikit";

const output = await processHTML(inputHtml, {
  rulesets: [SimplifiedChineseRules, LatinRules],
  halfDetectionWindow: 5,
  classnames: { /* ... */ },
});
```

When a browser DOM is available (`DOMParser`), it uses the native DOM and does not load happy-dom. In a Node context without a DOM it falls back to happy-dom, which is loaded lazily.

## How it works

The basic idea is that we *don't* need a language/ruleset classifier that works for 100% of the characters. Instead, we only need to maximize correctness for characters that *matter* (mostly punctuations) and it's okay if the boundary is fuzzy at other places.

1. HTML is parsed into a DOM.
2. Text nodes are split into characters and grouped into contexts, interrupted by block-level elements.
3. Each character is matched to a ruleset, either directly or by majority vote within a sliding window (`halfDetectionWindow`).
4. For each character, `mojikit` checks if it needs mojikumi treatment according to this ruleset. If it does, it's wrapped in a custom element (`mjk-chs`, `mjk-lat`,
   …) and given class names for format. Word joiners are also inserted for no-break characters.
5. The modified DOM is serialized back to the response.

`mojikit` only marks up the text, the actual spacing is left to your own CSS. 

## Rulesets

A ruleset describes a script/character class:

```ts
type CharacterRuleset = {
  heuristic?: RegExp;    // used for classification
  weight?: number;
  tagName?: string;      // custom element used to wrap matches
  addClass?: RegExp;
  squeezeLeft?: RegExp;
  squeezeRight?: RegExp;
  squeezeMiddle?: RegExp;
  noBreakBefore?: RegExp;
  noBreakAfter?: RegExp;
};
```

Two rulesets ship with the package: `SimplifiedChineseRules` and `LatinRules`. Usually, however, you'd want to copy the definitions and modify them to suit your use case instead of directly importing the presets.
