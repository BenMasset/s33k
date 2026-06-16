import type { NextPage } from 'next';
import Head from 'next/head';
import { useState } from 'react';

// Public waitlist page. Thin and functional: collects an email (and optional domain) and POSTs
// to the PUBLIC /api/waitlist endpoint, then shows a thank-you. No auth, no server-side work
// (SSR-safe). The endpoint dedupes and never reveals whether an email is already on the list,
// so this page shows the same success state either way.

const Waitlist: NextPage = () => {
   const [email, setEmail] = useState<string>('');
   const [domain, setDomain] = useState<string>('');
   const [submitting, setSubmitting] = useState<boolean>(false);
   const [error, setError] = useState<string>('');
   const [done, setDone] = useState<boolean>(false);

   const join = async () => {
      if (submitting) { return; }
      if (!email.trim()) {
         setError('Please enter your email.');
         return;
      }
      setSubmitting(true);
      setError('');
      try {
         const res = await fetch(`${window.location.origin}/api/waitlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ email: email.trim(), domain: domain.trim() || undefined }),
         }).then((r) => r.json());
         if (res && res.success) {
            setDone(true);
         } else {
            setError((res && res.error) || 'Could not join the waitlist.');
         }
      } catch (fetchError) {
         setError('The server is not responding. Try again shortly.');
      }
      setSubmitting(false);
   };

   const label = 'mb-2 font-semibold inline-block text-sm text-gray-700';
   const input = 'w-full p-2 border border-gray-200 rounded mb-3 focus:outline-none focus:border-blue-300';
   const card = 'relative bg-white rounded-md text-sm border p-6 shadow-sm';

   return (
      <div className='Waitlist'>
         <Head><title>Join the s33k waitlist</title></Head>
         <div className='flex items-center justify-center w-full min-h-screen bg-gray-50 p-4'>
            <div className='w-full max-w-md'>
               <h3 className='py-6 text-2xl font-bold text-blue-700 text-center'>s33k</h3>
               <div className={card}>
                  {!done ? (
                     <>
                        <p className='text-base font-semibold mb-1'>Join the waitlist</p>
                        <p className='text-gray-600 mb-4'>
                           s33k is invite-only right now. Leave your email and we will be in touch.
                        </p>
                        <label className={label}>Email</label>
                        <input
                           className={input}
                           type='email'
                           value={email}
                           placeholder='you@company.com'
                           onChange={(event) => setEmail(event.target.value)}
                        />
                        <label className={label}>Your domain (optional)</label>
                        <input
                           className={input}
                           type='text'
                           value={domain}
                           placeholder='company.com'
                           onChange={(event) => setDomain(event.target.value)}
                        />
                        <button
                           onClick={() => join()}
                           disabled={submitting}
                           className='py-3 px-5 w-full rounded cursor-pointer bg-blue-700 text-white font-semibold text-sm disabled:opacity-50'>
                           {submitting ? 'Joining...' : 'Join the waitlist'}
                        </button>
                        {error && (
                           <div className='mt-4 rounded text-center p-3 bg-red-100 text-red-600 text-sm font-semibold'>
                              {error}
                           </div>
                        )}
                     </>
                  ) : (
                     <>
                        <p className='text-base font-semibold mb-1'>Thanks.</p>
                        <p className='text-gray-600'>You are on the waitlist and we will be in touch.</p>
                     </>
                  )}
               </div>
            </div>
         </div>
      </div>
   );
};

export default Waitlist;
