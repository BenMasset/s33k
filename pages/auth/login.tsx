import type { NextPage } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';

// Magic-link login page. Two modes, decided by the URL:
//   - NO ?token=  -> the EMAIL FORM. The user enters their email, we POST /api/auth/request-link,
//     and we ALWAYS show the same neutral "if that email has an account, a link is on its way"
//     message (non-leak: the page never reveals whether the email maps to an account).
//   - ?token=...  -> AUTO-VERIFY. On load we POST the token to /api/auth/verify-link once; on
//     success we reveal the minted API key ONCE inside the copyable connect commands (identical
//     UX to the invite-accept page); on failure we show the single generic reject.
//
// The page does no server-side work and does not pre-validate the token: the token in the URL is
// the credential and validity is decided by the verify endpoint. That keeps the page a static
// render (no getServerSideProps) and avoids leaking whether a token exists before the user acts.
//
// Visual identity is the same s33k monochrome terminal look as the invite-accept page and the
// emails: white surface, near-black ink, gray, hairline borders, the 8px square dot wordmark, a
// system-mono stack, sharp corners, black copy buttons with white text. Inline styles only, so the
// page is cohesive regardless of the Tailwind config and matches the email byte-for-byte.

type VerifyResult = {
   apiKey?: string,
   accountId?: number,
   role?: 'admin' | 'member',
   mcpConfig?: { S33K_BASE_URL: string, S33K_API_KEY: string },
   mcpCommand?: string,
   onboardingHint?: string,
   error?: string | null,
};

const MONO = "'SF Mono', ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";
const INK = '#0a0a0a';
const GRAY = '#737373';
const HAIRLINE = '#ededed';

// A single copyable code block with a black copy button in its top-right corner. Mirrors the
// invite-accept page's CopyBlock exactly so the two reveal surfaces read identically.
const CopyBlock = ({ label, value, note }: { label: string, value: string, note?: string }) => {
   const [copied, setCopied] = useState<boolean>(false);

   const copy = async () => {
      try {
         await navigator.clipboard.writeText(value);
         setCopied(true);
         window.setTimeout(() => setCopied(false), 1600);
      } catch {
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

const PLATFORMS = ['claude-code', 'desktop-cursor', 'other', 'raw'] as const;
type Platform = typeof PLATFORMS[number];
const PLATFORM_LABEL: Record<Platform, string> = {
   'claude-code': 'Claude Code',
   'desktop-cursor': 'Claude Desktop / Cursor',
   other: 'Other apps',
   raw: 'Raw values',
};

const cardStyle: React.CSSProperties = {
   background: '#ffffff',
   border: `1px solid ${INK}`,
   padding: 26,
   fontFamily: MONO,
};

// The shared uppercase eyebrow-label style (matches the invite-accept page's inline labels).
const labelStyle: React.CSSProperties = {
   display: 'block', fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: GRAY, marginBottom: 6,
};

const AuthLogin: NextPage = () => {
   const router = useRouter();
   const token = typeof router.query.token === 'string' ? router.query.token : '';

   const [email, setEmail] = useState<string>('');
   const [submitting, setSubmitting] = useState<boolean>(false);
   const [requested, setRequested] = useState<boolean>(false);
   const [verifying, setVerifying] = useState<boolean>(false);
   const [error, setError] = useState<string>('');
   const [result, setResult] = useState<VerifyResult | null>(null);
   const [platform, setPlatform] = useState<Platform>('claude-code');
   // Guard so the auto-verify POST fires at most once, even across the router-query hydration
   // re-renders that surface the token.
   const verifiedRef = useRef<boolean>(false);

   // Auto-verify when the page loads with a token. Wait for the router to be ready so the token is
   // populated, then POST it exactly once.
   useEffect(() => {
      if (!router.isReady || !token || verifiedRef.current) { return; }
      verifiedRef.current = true;
      setVerifying(true);
      (async () => {
         try {
            const res = await fetch(`${window.location.origin}/api/auth/verify-link`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
               body: JSON.stringify({ token }),
            }).then((r) => r.json());
            if (res && res.apiKey) {
               setResult(res as VerifyResult);
            } else {
               setError((res && res.error) || 'Invalid or expired link.');
            }
         } catch (fetchError) {
            setError('The server is not responding. Try again shortly.');
         }
         setVerifying(false);
      })();
   }, [router.isReady, token]);

   const requestLink = async () => {
      if (submitting) { return; }
      setSubmitting(true);
      setError('');
      try {
         await fetch(`${window.location.origin}/api/auth/request-link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ email: email.trim() }),
         }).then((r) => r.json());
         // NON-LEAK: regardless of the response, show the same neutral confirmation. The endpoint
         // returns { sent: true } whether or not the email maps to an account, and the UI does not
         // expose anything more.
         setRequested(true);
      } catch (fetchError) {
         setError('The server is not responding. Try again shortly.');
      }
      setSubmitting(false);
   };

   const wordmark = (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '26px 0' }}>
         <span style={{ display: 'inline-block', width: 9, height: 9, background: INK }} />
         <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, letterSpacing: 1, color: INK }}>s33k</span>
      </div>
   );

   return (
      <div className='AuthLogin' style={{ fontFamily: MONO }}>
         <Head><title>Log in to s33k</title></Head>
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

               {/* Mode 1: arrived with a token -> verifying / success / generic reject. */}
               {token && !result && (
                  <div style={cardStyle}>
                     <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 8px' }}>
                        {verifying ? 'Logging you in...' : 'Log in to s33k'}
                     </p>
                     <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 6px' }}>
                        {verifying
                           ? 'Checking your link and minting a fresh key.'
                           : 'This link could not be used.'}
                     </p>
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
                     {!verifying && error && (
                        <p style={{ fontSize: 12.5, lineHeight: 1.7, color: GRAY, margin: '16px 0 0' }}>
                           Login links work once and expire after 15 minutes.
                           <Link href='/auth/login' style={{ color: INK, fontWeight: 700, marginLeft: 6 }}>
                              Request a new link
                           </Link>
                        </p>
                     )}
                  </div>
               )}

               {/* Mode 2: no token -> the email form (or its neutral confirmation). */}
               {!token && (
                  <div style={cardStyle}>
                     {!requested && (
                        <>
                           <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 8px' }}>
                              Log in to s33k
                           </p>
                           <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 20px' }}>
                              Enter the email for your s33k account. We will send you a one-time login link that
                              works once and expires in 15 minutes.
                           </p>
                           <label htmlFor='login-email' style={labelStyle}>
                              Email
                           </label>
                           <input
                              id='login-email'
                              type='email'
                              value={email}
                              placeholder='you@company.com'
                              onChange={(event) => setEmail(event.target.value)}
                              onKeyDown={(event) => { if (event.key === 'Enter') { requestLink(); } }}
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
                              onClick={() => requestLink()}
                              disabled={submitting || !email.trim()}
                              style={{
                                 width: '100%',
                                 padding: '13px 18px',
                                 cursor: submitting || !email.trim() ? 'default' : 'pointer',
                                 background: INK,
                                 color: '#ffffff',
                                 border: 'none',
                                 fontFamily: MONO,
                                 fontWeight: 700,
                                 fontSize: 13.5,
                                 letterSpacing: 0.4,
                                 opacity: submitting || !email.trim() ? 0.5 : 1,
                              }}>
                              {submitting ? 'Sending...' : 'Send login link ->'}
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
                        </>
                     )}
                     {requested && (
                        <>
                           <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 8px' }}>
                              Check your email
                           </p>
                           <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 6px' }}>
                              If that email has an account, a login link is on its way. It works once and expires
                              in 15 minutes.
                           </p>
                        </>
                     )}
                  </div>
               )}

               {result && (
                  <SuccessState result={result} platform={platform} setPlatform={setPlatform} />
               )}
            </div>
         </div>
      </div>
   );
};

// The post-login success state. Built entirely from the verify response. The minted key is
// interpolated into every connect block (and into nothing else), so each copy button yields a
// ready-to-paste value. No standalone "API key" field by design: this is the one-time reveal.
const SuccessState = ({
   result, platform, setPlatform,
}: {
   result: VerifyResult,
   platform: Platform,
   setPlatform: (p: Platform) => void,
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
            You are logged in.
         </p>
         <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 6px' }}>
            Here is a fresh key for your account. Connect it to the LLM you already use with one of the
            options below.
         </p>
         <p style={{ fontSize: 12.5, lineHeight: 1.7, color: INK, margin: '0 0 20px', fontWeight: 700 }}>
            Save this now. Your key is embedded in the commands below and is shown only once.
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

         {result.onboardingHint && (
            <p style={{ fontSize: 12.5, lineHeight: 1.7, color: GRAY, margin: '18px 0 0', borderTop: `1px solid ${HAIRLINE}`, paddingTop: 18 }}>
               {result.onboardingHint}
            </p>
         )}
      </div>
   );
};

export default AuthLogin;
