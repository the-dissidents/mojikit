import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

export const InspectorIntegration: AstroIntegration = {
  name: 'my-astro-integration',
  hooks: {
    'astro:config:setup': ({ addDevToolbarApp }) => {
      addDevToolbarApp({
        id: "my-toolbar-app",
        name: "My Toolbar App",
        icon: "🚀",
        entrypoint: fileURLToPath(new URL('./ToolbarApp.js', import.meta.url))
      });
    },
  },
};