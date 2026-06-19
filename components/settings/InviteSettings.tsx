import React, { useState } from 'react';
import Icon from '../common/Icon';
import {
   useInvites,
   useSendInvite,
   usedExternalInvites,
   DEFAULT_EXTERNAL_QUOTA,
   InviteCreateData,
} from '../../services/invites';

// Member-facing "Invite people" panel. Any logged-in account can invite someone to create their
// OWN s33k account with a 14-day free trial. Quota is shown as "X of N invites left", computed from
// the account's sent external invites (pending + accepted) against the per-account quota.
//
// Styling nudges toward the s33k monochrome identity (near-black, mono, sharp corners, black
// button) for this NEW surface without rebranding the inherited app.

// A deliberately permissive client-side email shape check, matching the server's looksLikeEmail.
const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const InviteSettings = () => {
   const [email, setEmail] = useState<string>('');
   const [validationError, setValidationError] = useState<string>('');
   const [sent, setSent] = useState<InviteCreateData | null>(null);
   const [sentEmail, setSentEmail] = useState<string>('');
   const [copied, setCopied] = useState<boolean>(false);

   const { data, isLoading } = useInvites();
   const invites = data?.invites || [];
   const used = usedExternalInvites(invites);
   const quota = DEFAULT_EXTERNAL_QUOTA;
   const remaining = Math.max(0, quota - used);
   const exhausted = remaining <= 0;

   const onSent = (result: InviteCreateData) => {
      setSent(result);
      setSentEmail(email.trim());
      setEmail('');
      setCopied(false);
   };
   const { mutate: sendInvite, isLoading: isSending } = useSendInvite(onSent);

   const submit = () => {
      const trimmed = email.trim();
      if (!trimmed) { setValidationError('Enter an email address.'); return; }
      if (!looksLikeEmail(trimmed)) { setValidationError('Enter a valid email address.'); return; }
      setValidationError('');
      sendInvite(trimmed);
   };

   const copyLink = async () => {
      if (!sent?.link) { return; }
      try {
         await navigator.clipboard.writeText(sent.link);
         setCopied(true);
         setTimeout(() => setCopied(false), 2000);
      } catch (clipboardError) {
         // Clipboard can be blocked (insecure context / permissions). The link stays visible to
         // copy by hand, so a failed copy is not worth an error toast.
      }
   };

   const inputStyle = `w-full p-2 border rounded-none text-sm bg-white border-neutral-300 text-neutral-900
   focus:outline-none focus:border-neutral-900 font-mono`;

   return (
      <div data-testid="invite_settings" className='settings__content styled-scrollbar p-6 text-sm'>
         <div className='mb-4'>
            <p className='text-base font-semibold mb-1 text-neutral-900'>Invite people to s33k</p>
            <p className='text-neutral-500'>
               An invite lets someone create their OWN s33k account with a 14-day free trial. No card required.
            </p>
         </div>

         <div className='mb-4 flex items-center justify-between'>
            <span
            data-testid="invites_left"
            className={`inline-block px-2 py-1 text-xs font-mono font-semibold border rounded-none
            ${exhausted ? 'text-red-700 border-red-300 bg-red-50' : 'text-neutral-700 border-neutral-300 bg-neutral-50'}`}>
               {isLoading ? 'Loading invites...' : `${remaining} of ${quota} invites left`}
            </span>
         </div>

         <label className='mb-2 font-semibold inline-block text-sm text-neutral-700'>Email</label>
         <input
         data-testid="invite_email"
         className={inputStyle}
         type='email'
         value={email}
         disabled={exhausted}
         placeholder='teammate@company.com'
         onChange={(event) => { setEmail(event.target.value); setValidationError(''); }}
         onKeyDown={(event) => { if (event.key === 'Enter') { submit(); } }}
         />

         <button
         data-testid="invite_button"
         onClick={() => submit()}
         disabled={isSending || exhausted}
         className={`mt-3 py-3 px-5 w-full rounded-none cursor-pointer font-semibold text-sm transition-colors
         bg-neutral-900 text-white hover:bg-black disabled:opacity-40 disabled:cursor-not-allowed`}>
            {isSending && <Icon type='loading' size={14} />} {exhausted ? 'No invites left' : 'Invite'}
         </button>

         {validationError && (
            <div className='mt-3 p-2 text-xs font-semibold bg-red-50 text-red-700 border border-red-200 rounded-none'>
               {validationError}
            </div>
         )}

         {exhausted && (
            <div data-testid="invite_exhausted" className='mt-3 p-2 text-xs font-semibold bg-red-50 text-red-700 border border-red-200 rounded-none'>
               You have used all your invites.
            </div>
         )}

         {sent && (
            <div data-testid="invite_sent" className='mt-5 p-4 border border-neutral-300 rounded-none bg-neutral-50'>
               <p className='font-semibold text-neutral-900 mb-2'>
                  <Icon type='check' size={14} color='#16a34a' /> Invite sent to {sentEmail || 'them'}
               </p>
               {sent.emailSent === false && (
                  <p className='text-xs text-neutral-500 mb-2'>
                     We could not send the email, so share this link with them directly.
                  </p>
               )}
               {sent.link && (
                  <div className='flex items-stretch gap-2'>
                     <input
                     data-testid="invite_link"
                     readOnly
                     value={sent.link}
                     className='flex-1 p-2 border border-neutral-300 rounded-none text-xs font-mono bg-white text-neutral-700'
                     onFocus={(event) => event.target.select()}
                     />
                     <button
                     data-testid="invite_copy"
                     onClick={() => copyLink()}
                     className='px-3 text-xs font-semibold rounded-none bg-neutral-900 text-white hover:bg-black whitespace-nowrap'>
                        {copied ? 'Copied' : 'Copy'}
                     </button>
                  </div>
               )}
            </div>
         )}
      </div>
   );
};

export default InviteSettings;
