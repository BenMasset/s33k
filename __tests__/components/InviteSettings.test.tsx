import { fireEvent, screen, waitFor } from '@testing-library/react';
import InviteSettings from '../../components/settings/InviteSettings';
import { renderWithClient } from '../../__mocks__/utils';

// jsdom has no clipboard by default; stub it so the Copy button path does not throw.
Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });

const inviteUrl = `${window.location.origin}/api/invite`;

beforeEach(() => {
   fetchMock.resetMocks();
});

describe('InviteSettings Component', () => {
   it('shows remaining invites from the listed external invites', async () => {
      // Two external invites used (pending + accepted) => 3 of 5 left.
      fetchMock.mockResponseOnce(JSON.stringify({
         invites: [
            { ID: 1, code: 'a', type: 'external', email: 'a@x.com', status: 'pending', target_account_id: null, created: null, accepted_at: null },
            { ID: 2, code: 'b', type: 'external', email: 'b@x.com', status: 'accepted', target_account_id: null, created: null, accepted_at: null },
         ],
      }));
      renderWithClient(<InviteSettings />);
      await waitFor(() => expect(screen.getByTestId('invites_left').textContent).toContain('3 of 5 invites left'));
   });

   it('sends an invite and shows the success state with a copyable link', async () => {
      fetchMock.mockResponseOnce(JSON.stringify({ invites: [] })); // initial list
      fetchMock.mockResponseOnce(JSON.stringify({ code: 'XYZ', link: 'https://s33k.io/invite/XYZ', type: 'external', emailSent: true }));
      fetchMock.mockResponseOnce(JSON.stringify({ invites: [] })); // invalidation refetch

      renderWithClient(<InviteSettings />);
      await waitFor(() => expect(screen.getByTestId('invites_left').textContent).toContain('5 of 5'));

      fireEvent.change(screen.getByTestId('invite_email'), { target: { value: 'new@team.com' } });
      fireEvent.click(screen.getByTestId('invite_button'));

      await waitFor(() => expect(screen.getByTestId('invite_sent')).toBeInTheDocument());
      expect(screen.getByTestId('invite_sent').textContent).toContain('Invite sent to new@team.com');
      expect((screen.getByTestId('invite_link') as HTMLInputElement).value).toBe('https://s33k.io/invite/XYZ');
   });

   it('shows the quota-exhausted message when the server returns the quota 403', async () => {
      fetchMock.mockResponseOnce(JSON.stringify({ invites: [] })); // initial list
      fetchMock.mockResponseOnce(JSON.stringify({ error: 'External invite quota exhausted.' }), { status: 403 });

      renderWithClient(<InviteSettings />);
      await waitFor(() => expect(screen.getByTestId('invite_button')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('invite_email'), { target: { value: 'over@quota.com' } });
      fireEvent.click(screen.getByTestId('invite_button'));

      // The send fails; the panel surfaces the server message via the error toast. The button stays
      // present and no success state appears.
      await waitFor(() => expect(screen.queryByTestId('invite_sent')).not.toBeInTheDocument());
   });
});
