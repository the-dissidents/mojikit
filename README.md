# mojikit

Rule-based mojikumi for Astro, applied at build time via middleware. It parses the
HTML output of each page, classifies characters against a set of rulesets, and
wraps them in custom elements with class names so that spacing can be controlled
purely in CSS. It also inserts word joiners (U+2060) where line breaks are not
allowed.

This is an internal tool and is still in early development.

## Usage

```ts
import { defineMiddleware } from "astro:middleware";
import { mojikit, SimplifiedChineseRules, LatinRules } from "mojikit";

export const onRequest = defineMiddleware(
  mojikit({
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

## How it works

1. HTML is parsed into a DOM.
2. Text nodes are split into characters and grouped into contexts, interrupted
   by block-level elements.
3. Each character is matched to a ruleset, either directly or by majority vote
   within a sliding window (`halfDetectionWindow`).
4. Matched characters are wrapped in a custom element (`mjk-chs`, `mjk-lat`,
   …) and given class names for left/right/middle squeeze and quarter-width
   spacing. Word joiners are inserted for no-break characters.
5. The modified DOM is serialized back to the response.

The actual spacing is left to your own CSS; mojikit only marks up the text.

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

Two rulesets ship with the package: `SimplifiedChineseRules` and `LatinRules`.
