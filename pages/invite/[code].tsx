import type { NextPage } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';

// Invite-accept page. Thin and functional: it shows the invite, takes an optional name, and
// POSTs the code to the PUBLIC /api/invite/accept endpoint. On success it reveals the connect
// instructions the recipient pastes into their LLM client. The minted API key is shown ONCE and
// only ever appears INSIDE the copyable connect commands/configs, never as its own field.
//
// The page does no server-side work and does not pre-fetch the invite: the code in the URL is
// the credential, and validity is decided by the accept endpoint when the user submits. That
// keeps the page a static render (SSR-safe, no getServerSideProps) and avoids leaking whether a
// code exists before the user acts on it.
//
// Visual identity is the s33k monochrome terminal look (matches the invite email and landing):
// white surface, near-black ink (#0a0a0a), gray (#737373), hairline borders, the 8px square dot
// wordmark, a system-mono stack, sharp corners (radius 0), black copy buttons with white text.
// Inline styles are used so the page is cohesive regardless of the Tailwind config and matches
// the email byte-for-byte on color and shape.

type AcceptResult = {
   apiKey?: string,
   accountId?: number,
   role?: 'admin' | 'member',
   mcpConfig?: { S33K_BASE_URL: string, S33K_API_KEY: string },
   mcpCommand?: string,
   onboardingHint?: string,
   error?: string | null,
};

// The shared s33k mono stack. Mirrors send-invite.ts MONO so the page and email read identically.
const MONO = "'SF Mono', ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";
const INK = '#0a0a0a';
const GRAY = '#737373';
const HAIRLINE = '#ededed';

// A single copyable code block with a black copy button in its top-right corner. The button
// writes `value` to the clipboard and shows a transient "Copied" state for ~1.6s. Accessible:
// it is a real <button> with an aria-label and an aria-live region announcing the copy. The
// <pre> wraps long content (overflow-x for one-liners, word-break for keys) so a long key never
// overflows the card on mobile.
const CopyBlock = ({ label, value, note }: { label: string, value: string, note?: string }) => {
   const [copied, setCopied] = useState<boolean>(false);

   const copy = async () => {
      try {
         await navigator.clipboard.writeText(value);
         setCopied(true);
         window.setTimeout(() => setCopied(false), 1600);
      } catch {
         // Clipboard API unavailable (insecure context / denied). Leave the value visible so the
         // user can select it by hand; do not claim success.
         setCopied(false);
      }
   };

   return (
      <div style={{ marginBottom: 18 }}>
         <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: GRAY, marginBottom: 6 }}>
            {label}
         </div>
         {note && (
            <p style={{ fontSize: 12, lineHeight: 1.6, color: GRAY, margin: '0 0 8px' }}>{note}</p>
         )}
         <div style={{ position: 'relative', border: `1px solid ${INK}`, background: '#0a0a0a' }}>
            <button
               type='button'
               onClick={copy}
               aria-label={copied ? 'Copied to clipboard' : `Copy ${label}`}
               style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  zIndex: 1,
                  cursor: 'pointer',
                  background: copied ? '#ffffff' : '#1c1c1c',
                  color: copied ? INK : '#ffffff',
                  border: '1px solid #3a3a3a',
                  fontFamily: MONO,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  padding: '5px 10px',
               }}>
               {copied ? 'Copied' : 'Copy'}
            </button>
            <pre style={{
               margin: 0,
               padding: '14px 70px 14px 14px',
               color: '#f5f5f5',
               fontFamily: MONO,
               fontSize: 12.5,
               lineHeight: 1.6,
               whiteSpace: 'pre-wrap',
               wordBreak: 'break-all',
               overflowX: 'auto',
            }}>{value}</pre>
         </div>
         <span aria-live='polite' style={{
            position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)',
         }}>
            {copied ? `${label} copied` : ''}
         </span>
      </div>
   );
};

// The four platform tabs, in priority order. Claude Code is primary (first + default).
const PLATFORMS = ['claude-code', 'desktop-cursor', 'other', 'raw'] as const;
type Platform = typeof PLATFORMS[number];
const PLATFORM_LABEL: Record<Platform, string> = {
   'claude-code': 'Claude Code',
   'desktop-cursor': 'Claude Desktop / Cursor',
   other: 'Other apps',
   raw: 'Raw values',
};

const InviteAccept: NextPage = () => {
   const router = useRouter();
   const code = typeof router.query.code === 'string' ? router.query.code : '';
   const [name, setName] = useState<string>('');
   const [submitting, setSubmitting] = useState<boolean>(false);
   const [error, setError] = useState<string>('');
   const [result, setResult] = useState<AcceptResult | null>(null);
   const [platform, setPlatform] = useState<Platform>('claude-code');

   const accept = async () => {
      if (!code || submitting) { return; }
      setSubmitting(true);
      setError('');
      try {
         const res = await fetch(`${window.location.origin}/api/invite/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ code, name: name.trim() || undefined }),
         }).then((r) => r.json());
         if (res && res.apiKey) {
            setResult(res as AcceptResult);
         } else {
            setError((res && res.error) || 'Could not accept this invite.');
         }
      } catch (fetchError) {
         setError('The server is not responding. Try again shortly.');
      }
      setSubmitting(false);
   };

   // The s33k wordmark: an 8px black square + the name, matching the email header.
   const wordmark = (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '26px 0' }}>
         <span style={{ display: 'inline-block', width: 9, height: 9, background: INK }} />
         <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, letterSpacing: 1, color: INK }}>s33k</span>
      </div>
   );

   const cardStyle: React.CSSProperties = {
      background: '#ffffff',
      border: `1px solid ${INK}`,
      padding: 26,
      fontFamily: MONO,
   };

   return (
      <div className='Invite' style={{ fontFamily: MONO }}>
         <Head><title>Accept your s33k invite</title></Head>
         <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            minHeight: '100vh',
            background: '#fafafa',
            padding: 16,
         }}>
            <div style={{ width: '100%', maxWidth: result ? 600 : 440 }}>
               {wordmark}

               {!result && (
                  <div style={cardStyle}>
                     <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 8px' }}>
                        You have been invited to s33k
                     </p>
                     <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 20px' }}>
                        Activate your access below. You will get a connect command for the LLM you already use:
                        SEO rankings, traffic, and AI search visibility, all in one place.
                     </p>
                     <label
                        htmlFor='invite-name'
                        style={{ display: 'block', fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: GRAY, marginBottom: 6 }}>
                        Your name (optional)
                     </label>
                     <input
                        id='invite-name'
                        type='text'
                        value={name}
                        placeholder='Jane Marketer'
                        onChange={(event) => setName(event.target.value)}
                        style={{
                           width: '100%',
                           boxSizing: 'border-box',
                           padding: '10px 12px',
                           border: `1px solid ${INK}`,
                           background: '#ffffff',
                           color: INK,
                           fontFamily: MONO,
                           fontSize: 13.5,
                           marginBottom: 18,
                           outline: 'none',
                        }}
                     />
                     <button
                        type='button'
                        onClick={() => accept()}
                        disabled={submitting || !code}
                        style={{
                           width: '100%',
                           padding: '13px 18px',
                           cursor: submitting || !code ? 'default' : 'pointer',
                           background: INK,
                           color: '#ffffff',
                           border: 'none',
                           fontFamily: MONO,
                           fontWeight: 700,
                           fontSize: 13.5,
                           letterSpacing: 0.4,
                           opacity: submitting || !code ? 0.5 : 1,
                        }}>
                        {submitting ? 'Activating...' : 'Accept invite ->'}
                     </button>
                     {error && (
                        <div style={{
                           marginTop: 16,
                           padding: 12,
                           textAlign: 'center',
                           border: `1px solid ${INK}`,
                           background: '#0a0a0a',
                           color: '#ffffff',
                           fontSize: 12.5,
                           fontWeight: 700,
                        }}>
                           {error}
                        </div>
                     )}
                  </div>
               )}

               {result && (
                  <SuccessState result={result} platform={platform} setPlatform={setPlatform} cardStyle={cardStyle} />
               )}
            </div>
         </div>
      </div>
   );
};

// The post-accept success state. Built entirely from the API response. The key is interpolated
// into every connect block (and into nothing else), so each copy button yields a ready-to-paste
// value. There is no standalone "API key" field by design: the page is the one-time reveal, and
// the key surfaces only where it is actually used.
const SuccessState = ({
   result, platform, setPlatform, cardStyle,
}: {
   result: AcceptResult,
   platform: Platform,
   setPlatform: (p: Platform) => void,
   cardStyle: React.CSSProperties,
}) => {
   const base = (result.mcpConfig?.S33K_BASE_URL || '').replace(/\/$/, '');
   const key = result.mcpConfig?.S33K_API_KEY || '';
   const mcpUrl = `${base}/api/mcp`;
   const command = result.mcpCommand || `claude mcp add --transport http s33k ${mcpUrl} --header "Authorization: Bearer ${key}"`;

   const desktopConfig = JSON.stringify({
      mcpServers: { s33k: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } },
   }, null, 2);

   const bridgeConfig = JSON.stringify({
      mcpServers: {
         s33k: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization: Bearer ${key}`] },
      },
   }, null, 2);

   // The closing example uses the shared domain when we can recover it. The accept response has no
   // dedicated domain field, but a share invite's onboardingHint embeds it ("...key for <domain>
   // only..."). Pull it from there when present; otherwise fall back to a neutral "your site".
   const domainMatch = /key for (\S+?) only/.exec(result.onboardingHint || '');
   const domain = domainMatch ? domainMatch[1] : 'your site';

   const tab = (p: Platform) => (
      <button
         key={p}
         type='button'
         onClick={() => setPlatform(p)}
         aria-pressed={platform === p}
         style={{
            cursor: 'pointer',
            background: platform === p ? INK : '#ffffff',
            color: platform === p ? '#ffffff' : INK,
            border: `1px solid ${INK}`,
            fontFamily: MONO,
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: 0.3,
            padding: '7px 11px',
            whiteSpace: 'nowrap',
         }}>
         {PLATFORM_LABEL[p]}
      </button>
   );

   return (
      <div style={cardStyle}>
         <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 8px' }}>
            You are in.
         </p>
         <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 6px' }}>
            {result.role === 'member'
               ? 'You have a read-only key. Connect it to the LLM you already use with one of the options below.'
               : 'Your account is ready. Connect s33k to the LLM you already use with one of the options below.'}
         </p>
         <p style={{ fontSize: 12.5, lineHeight: 1.7, color: INK, margin: '0 0 20px', fontWeight: 700 }}>
            Save these now. Your key is embedded in the commands below and is shown only once.
         </p>

         <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
            {PLATFORMS.map((p) => tab(p))}
         </div>

         {platform === 'claude-code' && (
            <CopyBlock
               label='Claude Code (terminal)'
               note='Paste this into your terminal in Claude Code. No install, nothing to run locally.'
               value={command}
            />
         )}

         {platform === 'desktop-cursor' && (
            <CopyBlock
               label='Claude Desktop / Cursor (config file)'
               note={'In Claude Desktop this goes in claude_desktop_config.json (Settings, Developer, Edit Config). '
                  + 'In Cursor: Settings, MCP, Add new server (or ~/.cursor/mcp.json). Restart the app after saving.'}
               value={desktopConfig}
            />
         )}

         {platform === 'other' && (
            <CopyBlock
               label='Other apps (mcp-remote bridge)'
               note='For MCP clients that only support local servers. This bridges the hosted s33k server to any client that only speaks local stdio.'
               value={bridgeConfig}
            />
         )}

         {platform === 'raw' && (
            <>
               <CopyBlock label='Server URL' value={mcpUrl} />
               <CopyBlock label='Header' value={`Authorization: Bearer ${key}`} />
            </>
         )}

         <p style={{ fontSize: 13, lineHeight: 1.7, color: INK, margin: '18px 0 0', borderTop: `1px solid ${HAIRLINE}`, paddingTop: 18 }}>
            Then ask s33k anything about {domain}, for example: show me an overview.
         </p>

         {result.onboardingHint && (
            <p style={{ fontSize: 12.5, lineHeight: 1.7, color: GRAY, margin: '14px 0 0' }}>
               {result.onboardingHint}
            </p>
         )}
      </div>
   );
};

export default InviteAccept;
