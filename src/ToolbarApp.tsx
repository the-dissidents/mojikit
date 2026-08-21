import { defineToolbarApp } from "astro/toolbar";

export default defineToolbarApp({
    init(canvas, app, server) {
      canvas.append(<h1>Hello</h1>)
    },
});