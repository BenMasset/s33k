import type { NextPage } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';

// Invite-accept page. Thin and functional: it shows the invite, takes an optional name, and
// POSTs the code to the PUBLIC /api/invite/accept endpoint. On success it displays the minted
// API key (shown once) plus the MCP config the recipient pastes into their LLM client.
//
// The page does no server-side work and does not pre-fetch the invite: the code in the URL is
// the credential, and validity is decided by the accept endpoint when the user submits. That
// keeps the page a static render (SSR-safe, no getServerSideProps) and avoids leaking whether a
// code exists before the user acts on it.

type AcceptResult = {
   apiKey?: string,
   accountId?: number,
   role?: 'admin' | 'member',
   mcpConfig?: { S33K_BASE_URL: string, S33K_API_KEY: string },
   mcpCommand?: string,
   onboardingHint?: string,
   error?: string | null,
};

const InviteAccept: NextPage = () => {
   const router = useRouter();
   const code = typeof router.query.code === 'string' ? router.query.code : '';
   const [name, setName] = useState<string>('');
   const [submitting, setSubmitting] = useState<boolean>(false);
   const [error, setError] = useState<string>('');
   const [result, setResult] = useState<AcceptResult | null>(null);

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

   const label = 'mb-2 font-semibold inline-block text-sm text-gray-700';
   const input = 'w-full p-2 border border-gray-200 rounded mb-3 focus:outline-none focus:border-gray-400';
   const card = 'relative bg-white rounded-md text-sm border p-6 shadow-sm';

   return (
      <div className='Invite'>
         <Head><title>Accept your s33k invite</title></Head>
         <div className='flex items-center justify-center w-full min-h-screen bg-gray-50 p-4'>
            <div className='w-full max-w-md'>
               <h3 className='py-6 text-2xl font-bold text-gray-900 text-center'>s33k</h3>

               {!result && (
                  <div className={card}>
                     <p className='text-base font-semibold mb-1'>You have been invited to s33k</p>
                     <p className='text-gray-600 mb-4'>
                        Activate your access below. You will get an API key for your LLM of choice.
                     </p>
                     <label className={label}>Your name (optional)</label>
                     <input
                        className={input}
                        type='text'
                        value={name}
                        placeholder='Jane Marketer'
                        onChange={(event) => setName(event.target.value)}
                     />
                     <button
                        onClick={() => accept()}
                        disabled={submitting || !code}
                        className='py-3 px-5 w-full rounded cursor-pointer bg-gray-900 text-white font-semibold text-sm disabled:opacity-50'>
                        {submitting ? 'Activating...' : 'Accept invite'}
                     </button>
                     {error && (
                        <div className='mt-4 rounded text-center p-3 bg-red-100 text-red-600 text-sm font-semibold'>
                           {error}
                        </div>
                     )}
                  </div>
               )}

               {result && (
                  <div className={card}>
                     <p className='text-base font-semibold mb-1'>You are in.</p>
                     <p className='text-gray-600 mb-4'>
                        {result.role === 'member'
                           ? 'You have a read-only member key. Save it now: it is shown only once.'
                           : 'Your account is ready. Save your API key now: it is shown only once.'}
                     </p>
                     <label className={label}>API key</label>
                     <code className='block w-full p-2 border border-gray-200 rounded mb-4 break-all bg-gray-50'>
                        {result.apiKey}
                     </code>
                     <label className={label}>Connect in one line</label>
                     <p className='text-gray-600 text-xs mb-2'>
                        Paste this into your terminal in Claude Code. No install, nothing to run locally.
                     </p>
                     <pre className='block w-full p-3 border border-gray-900 rounded mb-4 overflow-x-auto bg-gray-900 text-gray-50 text-xs'>
{result.mcpCommand || ''}
                     </pre>
                     <details className='mb-4'>
                        <summary className='cursor-pointer text-gray-500 text-xs select-none'>Prefer to set it up by hand?</summary>
                        <pre className='block w-full mt-2 p-3 border border-gray-200 rounded overflow-x-auto bg-gray-50 text-xs'>
{`S33K_BASE_URL=${result.mcpConfig?.S33K_BASE_URL || ''}
S33K_API_KEY=${result.mcpConfig?.S33K_API_KEY || ''}`}
                        </pre>
                     </details>
                     {result.onboardingHint && (
                        <p className='text-gray-600 text-sm'>{result.onboardingHint}</p>
                     )}
                  </div>
               )}
            </div>
         </div>
      </div>
   );
};

export default InviteAccept;
