import type { NextPage } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';

// POST-CHECKOUT landing. Stripe Checkout returns the user here:
//   - ?billing=success   -> "You are subscribed. Your sites are unlocked." + the next step (connect
//     s33k to the LLM you already use). The actual subscription state is reconciled server-side by
//     the Stripe webhook, so this page is a confirmation + pointer ONLY: it never reads the account
//     and never prints a key, host, or script. It points the user back into the app dashboard and to
//     the in-LLM connect flow.
//   - ?billing=cancelled -> a neutral "checkout cancelled, you can subscribe any time" state with a
//     path back. Cancelling is not an error, so the copy stays calm and offers the next move.
//   - no param           -> defaults to the cancelled/neutral state (a bare /welcome visit is treated
//     as "nothing happened yet").
//
// Visual identity is the same s33k monochrome terminal look as /signup and /auth/login: white
// surface, near-black ink, gray, hairline borders, the square dot wordmark, a system-mono stack,
// sharp corners, a black button with white text. Inline styles only, so the page is cohesive
// regardless of the Tailwind config and matches the signup / login pages byte-for-byte.

const MONO = "'SF Mono', ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";
const INK = '#0a0a0a';
const GRAY = '#737373';
const HAIRLINE = '#ededed';

const cardStyle: React.CSSProperties = {
   background: '#ffffff',
   border: `1px solid ${INK}`,
   padding: 26,
   fontFamily: MONO,
};

// A black pill-free, sharp-cornered primary button styled as a link (matches the signup button).
const buttonStyle: React.CSSProperties = {
   display: 'block',
   width: '100%',
   boxSizing: 'border-box',
   padding: '13px 18px',
   textAlign: 'center',
   cursor: 'pointer',
   background: INK,
   color: '#ffffff',
   border: 'none',
   fontFamily: MONO,
   fontWeight: 700,
   fontSize: 13.5,
   letterSpacing: 0.4,
   textDecoration: 'none',
};

const Welcome: NextPage = () => {
   const router = useRouter();
   // Anything that is not an explicit success (the cancelled return, or a bare /welcome with no
   // param) falls through to the neutral cancelled state. Cancelling is not an error.
   const success = router.query.billing === 'success';

   const wordmark = (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '26px 0' }}>
         <span style={{ display: 'inline-block', width: 9, height: 9, background: INK }} />
         <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, letterSpacing: 1, color: INK }}>s33k</span>
      </div>
   );

   return (
      <div className='Welcome' style={{ fontFamily: MONO }}>
         <Head>
            <title>{success ? 'You are subscribed · s33k' : 'Welcome · s33k'}</title>
         </Head>
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
                  {success && (
                     <>
                        <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 8px' }}>
                           You are subscribed. Your sites are unlocked.
                        </p>
                        <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 6px' }}>
                           You are on the $7/site/month plan. Each site includes 50 tracked keywords.
                        </p>
                        <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 20px' }}>
                           Next: connect s33k to the AI client you already use (Claude Code, Claude Desktop, Cursor,
                           or any MCP client), then just ask it how your site is doing. Open your dashboard for the
                           ready-to-paste connect command.
                        </p>
                        <Link href='/' passHref>
                           <a style={buttonStyle}>Open my dashboard {'->'}</a>
                        </Link>
                        <p style={{
                           fontSize: 12.5,
                           lineHeight: 1.7,
                           color: GRAY,
                           margin: '20px 0 0',
                           borderTop: `1px solid ${HAIRLINE}`,
                           paddingTop: 18,
                        }}>
                           Need to manage your plan or card later? Ask your AI client to open the billing portal,
                           or use the billing menu in your dashboard.
                        </p>
                     </>
                  )}
                  {!success && (
                     <>
                        <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 8px' }}>
                           Checkout cancelled.
                        </p>
                        <p style={{ fontSize: 13.5, lineHeight: 1.7, color: GRAY, margin: '0 0 20px' }}>
                           No charge was made. You can subscribe any time to keep your sites running once your
                           trial ends.
                        </p>
                        <Link href='/' passHref>
                           <a style={buttonStyle}>Back to my dashboard {'->'}</a>
                        </Link>
                        <p style={{ fontSize: 12.5, lineHeight: 1.7, color: GRAY, margin: '20px 0 0' }}>
                           When you are ready, ask your AI client to start checkout, or open the billing menu in
                           your dashboard.
                        </p>
                     </>
                  )}
               </div>

               <p style={{ fontSize: 12, lineHeight: 1.7, color: GRAY, textAlign: 'center', margin: '18px 0 0' }}>
                  Lost your key?
                  <Link href='/auth/login' style={{ color: INK, fontWeight: 700, marginLeft: 6 }}>
                     Log in to get a fresh one
                  </Link>
               </p>
            </div>
         </div>
      </div>
   );
};

export default Welcome;
