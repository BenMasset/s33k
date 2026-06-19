import React, { useState } from 'react';
import dayjs from 'dayjs';
import Icon from '../common/Icon';
import { useShares, useShareDomain, useRevokeShare, ShareCreateData } from '../../services/shares';

// Per-domain read-only SHARE panel, mounted as a tab in the Domain Settings modal. The owner enters
// an email and shares this domain read-only. The recipient gets a one-time activation link by email
// and the scoped key is minted only when they accept it (the owner never handles a key here). The
// panel also lists current shares with a Revoke action.
//
// Styling nudges toward the s33k monochrome identity for this NEW surface.

const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

type ShareSettingsProps = {
   domain: string,
};

const ShareSettings = ({ domain }: ShareSettingsProps) => {
   const [email, setEmail] = useState<string>('');
   const [validationError, setValidationError] = useState<string>('');
   const [sharedWith, setSharedWith] = useState<string>('');
   const [lastResult, setLastResult] = useState<ShareCreateData | null>(null);

   const { data, isLoading } = useShares(domain);
   const shares = (data?.shares || []).filter((share) => !share.revoked);

   const onShared = (result: ShareCreateData) => {
      setLastResult(result);
      setSharedWith(email.trim());
      setEmail('');
   };
   const { mutate: share, isLoading: isSharing } = useShareDomain(domain, onShared);
   const { mutate: revoke } = useRevokeShare(domain);

   const submit = () => {
      const trimmed = email.trim();
      if (!trimmed) { setValidationError('Enter an email address.'); return; }
      if (!looksLikeEmail(trimmed)) { setValidationError('Enter a valid email address.'); return; }
      setValidationError('');
      share(trimmed);
   };

   const inputStyle = `w-full p-2 border rounded-none text-sm bg-white border-neutral-300 text-neutral-900
   focus:outline-none focus:border-neutral-900 font-mono`;

   return (
      <div data-testid='share_settings' className='mb-4 text-sm'>
         <p className='text-neutral-500 mb-3'>
            Share {domain} read-only. They get a link by email and read-only access to this one domain. No key is emailed.
         </p>

         <label className='mb-2 font-semibold inline-block text-sm text-neutral-700'>Email</label>
         <input
         data-testid='share_email'
         className={inputStyle}
         type='email'
         value={email}
         placeholder='collaborator@company.com'
         onChange={(event) => { setEmail(event.target.value); setValidationError(''); }}
         onKeyDown={(event) => { if (event.key === 'Enter') { submit(); } }}
         />
         <button
         data-testid='share_button'
         onClick={() => submit()}
         disabled={isSharing}
         className={`mt-3 py-2.5 px-5 w-full rounded-none cursor-pointer font-semibold text-sm transition-colors
         bg-neutral-900 text-white hover:bg-black disabled:opacity-40`}>
            {isSharing && <Icon type='loading' size={14} />} Share read-only
         </button>

         {validationError && (
            <div className='mt-3 p-2 text-xs font-semibold bg-red-50 text-red-700 border border-red-200 rounded-none'>
               {validationError}
            </div>
         )}

         {lastResult?.invited && (
            <div data-testid='share_sent' className='mt-3 p-3 border border-neutral-300 rounded-none bg-neutral-50 text-neutral-900 font-semibold'>
               <Icon type='check' size={14} color='#16a34a' /> Shared with {sharedWith}
               {lastResult.emailSent === false && (
                  <span className='block text-xs text-neutral-500 font-normal mt-1'>
                     We could not send the email. The invite still exists, so reach out to them directly.
                  </span>
               )}
            </div>
         )}

         <div className='mt-6'>
            <p className='font-semibold text-neutral-700 mb-2'>Current shares</p>
            {isLoading && <p className='text-neutral-400 text-xs'><Icon type='loading' size={12} /> Loading shares...</p>}
            {!isLoading && shares.length === 0 && (
               <p data-testid='share_empty' className='text-neutral-400 text-xs'>No active shares for this domain yet.</p>
            )}
            {!isLoading && shares.length > 0 && (
               <ul className='border border-neutral-200 rounded-none divide-y divide-neutral-100'>
                  {shares.map((share_) => (
                     <li key={share_.ID} data-testid='share_row' className='flex items-center justify-between px-3 py-2'>
                        <span className='font-mono text-xs text-neutral-700'>
                           {share_.key_prefix}
                           <span className='block text-neutral-400'>
                              {share_.created ? dayjs(share_.created).format('DD MMM YYYY') : ''}
                           </span>
                        </span>
                        <button
                        data-testid='share_revoke'
                        onClick={() => revoke(share_.ID)}
                        className='text-xs font-semibold text-red-600 hover:text-red-700'>
                           <Icon type='trash' size={12} /> Revoke
                        </button>
                     </li>
                  ))}
               </ul>
            )}
         </div>
      </div>
   );
};

export default ShareSettings;
