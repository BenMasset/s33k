/**
 * Install-guide library for the s33k onboarding tracking snippet.
 *
 * Once a domain has a provisioned Umami website, the customer needs to add the Umami
 * tracking script to their site so s33k can collect analytics and AEO/AI-crawler signal.
 * This module turns a domain + its Umami website id into (1) the exact script snippet and
 * (2) accurate, copy-paste-ready, per-platform install instructions for the surfaces a
 * marketer is most likely to be on.
 *
 * It is pure product knowledge: no network calls, no LLM, no secrets. The snippet points
 * at the same self-hosted Umami instance the rest of s33k reads from (UMAMI_BASE_URL); the
 * script src is read from UMAMI_SCRIPT_URL when set, otherwise derived as
 * `${UMAMI_BASE_URL}/script.js`, which is the default path Umami serves its tracker from.
 *
 * Configuration (read at runtime, never committed):
 *   UMAMI_BASE_URL    Base URL of the self-hosted Umami instance. Used to derive the
 *                     script src when UMAMI_SCRIPT_URL is not set.
 *   UMAMI_SCRIPT_URL  Optional explicit full URL to the Umami tracker script (overrides
 *                     the derived `${UMAMI_BASE_URL}/script.js`).
 */

import { normalizeBaseUrl } from './umami';

export type InstallGuide = {
   platform: string,
   steps: string[],
};

export type InstallGuides = {
   snippet: string,
   scriptUrl: string,
   websiteId: string,
   platforms: InstallGuide[],
};

/**
 * Resolve the full URL of the Umami tracker script.
 * Prefers UMAMI_SCRIPT_URL; otherwise derives `${UMAMI_BASE_URL}/script.js`. Falls back to
 * a bare "/script.js" path when no base URL is configured so the snippet is still shaped
 * correctly (the customer can swap the host in).
 * @returns {string} The script src to use in the snippet.
 */
const resolveScriptUrl = (): string => {
   const explicit = String(process.env.UMAMI_SCRIPT_URL || '').trim();
   if (explicit) { return explicit; }
   const rawBase = process.env.UMAMI_BASE_URL;
   if (!rawBase) { return '/script.js'; }
   return `${normalizeBaseUrl(rawBase)}/script.js`;
};

/**
 * Build the exact Umami tracking snippet for a website id.
 * This is the single line a customer pastes into their site's <head>.
 * @param {string} scriptUrl - Full URL of the Umami tracker script.
 * @param {string} websiteId - The per-domain Umami website id.
 * @returns {string} The <script> snippet.
 */
const buildSnippet = (scriptUrl: string, websiteId: string): string => `<script defer src="${scriptUrl}" data-website-id="${websiteId}"></script>`;

/**
 * Build the snippet and the per-platform install instructions for a domain.
 *
 * Covers the platforms an SEO/marketing buyer is most likely to run: raw HTML, Google Tag
 * Manager, WordPress, Webflow, Shopify, Squarespace, Wix, and Next.js/React. Each guide is
 * a numbered list of exact, current steps ending at where the snippet goes.
 * @param {string} domain - The site domain, e.g. "getmasset.com" (used only for copy).
 * @param {string} umamiWebsiteId - The per-domain Umami website id to embed in the snippet.
 * @returns {InstallGuides} The snippet, resolved script URL, website id, and platform guides.
 */
export const getInstallGuides = (domain: string, umamiWebsiteId: string): InstallGuides => {
   const websiteId = String(umamiWebsiteId || '').trim();
   const scriptUrl = resolveScriptUrl();
   const snippet = buildSnippet(scriptUrl, websiteId);

   const platforms: InstallGuide[] = [
      {
         platform: 'Raw HTML',
         steps: [
            'Open the HTML template or layout file that renders the <head> of every page on your site.',
            'Paste the snippet immediately before the closing </head> tag.',
            'Save and deploy. Load any page once, then check s33k for analytics within a few minutes.',
         ],
      },
      {
         platform: 'Google Tag Manager',
         steps: [
            'In Google Tag Manager, open the container for your site and click Tags, then New.',
            'Click Tag Configuration and choose the "Custom HTML" tag type.',
            'Paste the snippet into the HTML field exactly as given.',
            'Under Triggering, choose "All Pages" (the built-in Page View trigger) so it fires site-wide.',
            'Name the tag (for example "Umami Analytics"), click Save, then click Submit and Publish to push it live.',
         ],
      },
      {
         platform: 'WordPress',
         steps: [
            'Easiest path: install a header-script plugin such as "WPCode" or "Insert Headers and Footers".',
            'Open the plugin\'s settings and find the "Header" or "Scripts in Header" box.',
            'Paste the snippet into that Header box and save. This injects it into <head> on every page.',
            'Alternative without a plugin: in Appearance, Theme File Editor, open header.php in a child theme and paste the snippet '
               + 'directly before </head> (use a child theme so a theme update does not overwrite it).',
         ],
      },
      {
         platform: 'Webflow',
         steps: [
            'In the Webflow Designer, open your project, then go to the project settings (the gear icon or Site Settings).',
            'Open the "Custom Code" tab.',
            'Paste the snippet into the "Head Code" box (the field labeled "Inside <head> tag").',
            'Click Save Changes, then Publish your site so the code goes live on the published domain.',
         ],
      },
      {
         platform: 'Shopify',
         steps: [
            'In Shopify admin, go to Online Store, then Themes.',
            'On your live theme click the three-dot menu (or "Actions"), then "Edit code".',
            'Under "Layout", open theme.liquid.',
            'Paste the snippet just before the closing </head> tag, then click Save. It now loads on every storefront page.',
         ],
      },
      {
         platform: 'Squarespace',
         steps: [
            'In the Squarespace dashboard, go to Settings, then Advanced, then "Code Injection".',
            'Paste the snippet into the "Header" box.',
            'Click Save. The script is injected into <head> across the whole site.',
            'Note: Code Injection requires a Business or Commerce plan.',
         ],
      },
      {
         platform: 'Wix',
         steps: [
            'In the Wix dashboard, go to Settings, then "Custom Code" (under the Advanced section).',
            'Click "Add Custom Code" in the Head section.',
            'Paste the snippet into the code box and give it a name (for example "Umami Analytics").',
            'Set it to load on "All pages" and place it in the "Head", then click Apply.',
         ],
      },
      {
         platform: 'Next.js / React',
         steps: [
            'App Router: in app/layout.tsx, import Script from "next/script" and render it inside the <head> (or at the top of <body>):',
            `  <Script defer src="${scriptUrl}" data-website-id="${websiteId}" strategy="afterInteractive" />`,
            'Pages Router: in pages/_document.tsx, add the snippet inside the <Head> element of the Document, '
               + 'or render the next/script <Script> tag in _app.tsx.',
            'Plain React (Vite/CRA) with no SSR: paste the raw snippet into the <head> of public/index.html.',
            'Deploy. Because the tracker is a plain script, it works regardless of which rendering strategy the rest of the app uses.',
         ],
      },
   ];

   return { snippet, scriptUrl, websiteId, platforms };
};

export default getInstallGuides;
