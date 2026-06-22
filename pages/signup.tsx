import type { NextPage } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';

// PUBLIC self-serve signup page. The user enters an email, we POST /api/signup, and we ALWAYS show
// the same neutral "check your email" confirmation. The signup endpoint is NON-LEAKING (it returns
// the same { sent: true } whether the email is new or already held by an account), and this page
// surfaces nothing more: it never reveals whether an email already has an account.
//
// Signup is email-verified BY CONSTRUCTION: this page never receives or shows an API key. The new
// account becomes usable only after its owner clicks the emailed magic link (/auth/login ->
// /api/auth/verify-link), which mints the first key. So the whole reveal/connect UX lives on the
// login page; this page is just the front door.
//
// Visual identity is the same s33k monochrome terminal look as /auth/login and the emails: white
// surface, near-black ink, gray, hairline borders, the 8px square dot wordmark, a system-mono stack,
// sharp corners, a black button with white text. Inline styles only, so the page is cohesive
// regardless of the Tailwind config and matches the login page byte-for-byte.

const MONO = "'SF Mono', ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";
const INK = '#0a0a0a';
const GRAY = '#737373';

const cardStyle: React.CSSProperties = {
   background: '#ffffff',
   border: `1px solid ${INK}`,
   padding: 26,
   fontFamily: MONO,
};

const labelStyle: React.CSSProperties = {
   display: 'block', fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: GRAY, marginBottom: 6,
};

const Signup: NextPage = () => {
   const [email, setEmail] = useState<string>('');
   const [submitting, setSubmitting] = useState<boolean>(false);
   const [requested, setRequested] = useState<boolean>(false);
   const [error, setError] = useState<string>('');

   const requestSignup = async () => {
      if (submitting || !email.trim()) { return; }
      setSubmitting(true);
      setError('');
      try {
         await fetch(`${window.location.origin}/api/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ email: email.trim() }),
         }).then((r) => r.json());
         // NON-LEAK: regardless of the response, show the same neutral confirmation. The endpoint
         // returns { sent: true } whether or not the email already has an account.
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
      <div className='Signup' style={{ fontFamily: MONO }}>
         <Head><title>Start your free trial · s33k</title></Head>
         <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            minHeight: '100vh',
            background: '#fafafa',
            padding: 16,
         }}>
            <div style={{ width: '100%', maxWidth: 440 }}>
               {wordmark}

               <div style={cardStyle}>
                  {!requested && (
                     <>
                        <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 8px' }}>
                           Start your 14-day free trial
                        </p>
                        <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 6px' }}>
                           1 site, 50 keywords. No credit card.
                        </p>
                        <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 20px' }}>
                           Enter your email and we will send you a one-time link to set up your account and connect
                           it to the LLM you already use.
                        </p>
                        <label htmlFor='signup-email' style={labelStyle}>
                           Email
                        </label>
                        <input
                           id='signup-email'
                           type='email'
                           value={email}
                           placeholder='you@company.com'
                           onChange={(event) => setEmail(event.target.value)}
                           onKeyDown={(event) => { if (event.key === 'Enter') { requestSignup(); } }}
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
                           onClick={() => requestSignup()}
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
                           {submitting ? 'Sending...' : 'Start free trial ->'}
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
                        <p style={{ fontSize: 12.5, lineHeight: 1.7, color: GRAY, margin: '18px 0 0' }}>
                           Already have an account?
                           <Link href='/auth/login' style={{ color: INK, fontWeight: 700, marginLeft: 6 }}>
                              Log in
                           </Link>
                        </p>
                     </>
                  )}
                  {requested && (
                     <>
                        <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 8px' }}>
                           Check your email
                        </p>
                        <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 6px' }}>
                           If that email can start a trial, a setup link is on its way. It works once and expires
                           in 15 minutes.
                        </p>
                        <p style={{ fontSize: 12.5, lineHeight: 1.7, color: GRAY, margin: '10px 0 0' }}>
                           Already have an account?
                           <Link href='/auth/login' style={{ color: INK, fontWeight: 700, marginLeft: 6 }}>
                              Log in
                           </Link>
                        </p>
                     </>
                  )}
               </div>
            </div>
         </div>
      </div>
   );
};

export default Signup;
