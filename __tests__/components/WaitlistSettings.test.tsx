import { fireEvent, screen, waitFor } from '@testing-library/react';
import WaitlistSettings from '../../components/settings/WaitlistSettings';
import { renderWithClient } from '../../__mocks__/utils';

const waitlistUrl = `${window.location.origin}/api/waitlist`;

beforeEach(() => {
   fetchMock.resetMocks();
});

const sampleRows = {
   waitlist: [
      { ID: 3, email: 'ceo@acme.com', domain: 'acme.com', note: 'Saw the launch', status: 'waiting', created: '2026-06-18T00:00:00.000Z' },
      { ID: 2, email: 'lead@globex.io', domain: 'globex.io', note: null, status: 'waiting', created: '2026-06-17T00:00:00.000Z' },
      { ID: 1, email: 'me@initech.com', domain: null, note: null, status: 'waiting', created: '2026-06-16T00:00:00.000Z' },
   ],
};

describe('WaitlistSettings Component', () => {
   it('renders the waitlist rows', async () => {
      fetchMock.mockResponseOnce(JSON.stringify(sampleRows));
      renderWithClient(<WaitlistSettings />);
      await waitFor(() => expect(screen.getAllByTestId('waitlist_row')).toHaveLength(3));
      expect(screen.getByText('ceo@acme.com')).toBeInTheDocument();
   });

   it('shows the empty state when no one is waiting', async () => {
      fetchMock.mockResponseOnce(JSON.stringify({ waitlist: [] }));
      renderWithClient(<WaitlistSettings />);
      await waitFor(() => expect(screen.getByTestId('waitlist_empty')).toBeInTheDocument());
      expect(screen.getByTestId('waitlist_empty').textContent).toContain('No one on the waitlist yet.');
   });

   it('sends an invite for a row and marks it Invited', async () => {
      fetchMock.mockResponseOnce(JSON.stringify(sampleRows)); // waitlist load
      fetchMock.mockResponseOnce(JSON.stringify({ code: 'ABC', link: 'https://s33k.io/invite/ABC', type: 'external', emailSent: true }));
      fetchMock.mockResponseOnce(JSON.stringify({ invites: [] })); // invite-list invalidation

      renderWithClient(<WaitlistSettings />);
      await waitFor(() => expect(screen.getAllByTestId('waitlist_invite_button')).toHaveLength(3));

      fireEvent.click(screen.getAllByTestId('waitlist_invite_button')[0]);
      await waitFor(() => expect(screen.getAllByTestId('waitlist_invited').length).toBeGreaterThan(0));
   });

   it('does not fetch when disabled (non-admin)', async () => {
      renderWithClient(<WaitlistSettings enabled={false} />);
      // With enabled=false the query never fires; the empty state renders without any request.
      await waitFor(() => expect(screen.getByTestId('waitlist_empty')).toBeInTheDocument());
      expect(fetchMock).not.toHaveBeenCalled();
   });
});
