import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

export const InspectorIntegration: AstroIntegration = {
  name: 'mojikit-inspector',
  hooks: {
    'astro:config:setup': ({ addDevToolbarApp }) => {
      addDevToolbarApp({
        id: "mojikit",
        name: "Mojikit",
        icon: "📃",
        entrypoint: fileURLToPath(new URL('./ToolbarApp.js', import.meta.url))
      });
    },
  },
};