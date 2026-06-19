import React, { useState } from 'react';
import dayjs from 'dayjs';
import Icon from '../common/Icon';
import { useWaitlist, WaitlistEntry } from '../../services/waitlist';
import { useSendInvite } from '../../services/invites';

// Admin-only "Waitlist" view. Lists everyone who requested access from the public landing, with a
// per-row "Send invite" button that fires POST /api/invite { type: 'external', email }. On success
// the row is marked "Invited" optimistically. The parent only renders this for the admin account;
// the API also 401/403s any non-admin, so this is gated twice.
//
// Styling nudges toward the s33k monochrome identity for this NEW surface.

// `enabled` lets the parent avoid even firing the admin-only request for a non-admin caller.
type WaitlistSettingsProps = {
   enabled?: boolean,
};

const WaitlistSettings = ({ enabled = true }: WaitlistSettingsProps) => {
   const { data, isLoading } = useWaitlist(enabled);
   const rows = data?.waitlist || [];
   // Track which emails we have invited this session so the row flips to "Invited" immediately,
   // independent of the waitlist row's own status (the invite does not mutate the waitlist row).
   const [invitedEmails, setInvitedEmails] = useState<Record<string, boolean>>({});
   const [pendingEmail, setPendingEmail] = useState<string>('');

   const { mutate: sendInvite } = useSendInvite();

   const invite = (entry: WaitlistEntry) => {
      setPendingEmail(entry.email);
      sendInvite(entry.email, {
         onSuccess: () => {
            setInvitedEmails((current) => ({ ...current, [entry.email]: true }));
            setPendingEmail('');
         },
         onError: () => { setPendingEmail(''); },
      });
   };

   const isInvited = (entry: WaitlistEntry): boolean => (
      invitedEmails[entry.email] === true || entry.status === 'invited'
   );

   return (
      <div data-testid="waitlist_settings" className='settings__content styled-scrollbar p-6 text-sm'>
         <div className='mb-4'>
            <p className='text-base font-semibold mb-1 text-neutral-900'>Access requests</p>
            <p className='text-neutral-500'>
               People who asked for access from the landing page. Send an invite to bring one in.
            </p>
         </div>

         {isLoading && (
            <div className='p-6 text-center text-neutral-500 border border-neutral-200 rounded-none'>
               <Icon type='loading' size={16} /> Loading the waitlist...
            </div>
         )}

         {!isLoading && rows.length === 0 && (
            <div data-testid="waitlist_empty" className='p-6 text-center text-neutral-500 border border-neutral-200 rounded-none'>
               No one on the waitlist yet.
            </div>
         )}

         {!isLoading && rows.length > 0 && (
            <table className='w-full text-left border-collapse'>
               <thead>
                  <tr className='text-xs uppercase text-neutral-400 border-b border-neutral-200'>
                     <th className='py-2 pr-2 font-semibold'>Email</th>
                     <th className='py-2 pr-2 font-semibold'>Domain</th>
                     <th className='py-2 pr-2 font-semibold'>When</th>
                     <th className='py-2 font-semibold text-right'>Action</th>
                  </tr>
               </thead>
               <tbody>
                  {rows.map((entry) => (
                     <tr key={entry.ID} data-testid='waitlist_row' className='border-b border-neutral-100 align-top'>
                        <td className='py-3 pr-2 font-mono text-neutral-900 break-all'>
                           {entry.email}
                           {entry.note && <span className='block text-xs text-neutral-400 font-sans mt-1'>{entry.note}</span>}
                        </td>
                        <td className='py-3 pr-2 font-mono text-neutral-600 break-all'>{entry.domain || '-'}</td>
                        <td className='py-3 pr-2 text-neutral-500 whitespace-nowrap'>
                           {entry.created ? dayjs(entry.created).format('DD MMM YYYY') : '-'}
                        </td>
                        <td className='py-3 text-right'>
                           {isInvited(entry) ? (
                              <span data-testid='waitlist_invited' className='text-xs font-semibold text-green-700'>
                                 <Icon type='check' size={12} color='#16a34a' /> Invited
                              </span>
                           ) : (
                              <button
                              data-testid='waitlist_invite_button'
                              onClick={() => invite(entry)}
                              disabled={pendingEmail === entry.email}
                              className={`text-xs font-semibold py-1.5 px-3 rounded-none whitespace-nowrap transition-colors
                              bg-neutral-900 text-white hover:bg-black disabled:opacity-40`}>
                                 {pendingEmail === entry.email ? 'Sending' : 'Send invite'}
                              </button>
                           )}
                        </td>
                     </tr>
                  ))}
               </tbody>
            </table>
         )}
      </div>
   );
};

export default WaitlistSettings;
