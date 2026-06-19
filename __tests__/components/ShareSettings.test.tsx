import { fireEvent, screen, waitFor } from '@testing-library/react';
import ShareSettings from '../../components/domains/ShareSettings';
import { renderWithClient } from '../../__mocks__/utils';

beforeEach(() => {
   fetchMock.resetMocks();
});

describe('ShareSettings Component', () => {
   it('lists current shares and the empty state', async () => {
      fetchMock.mockResponseOnce(JSON.stringify({ shares: [] }));
      renderWithClient(<ShareSettings domain='acme.com' />);
      await waitFor(() => expect(screen.getByTestId('share_empty')).toBeInTheDocument());
   });

   it('shares a domain read-only and shows the success state', async () => {
      fetchMock.mockResponseOnce(JSON.stringify({ shares: [] })); // initial list
      fetchMock.mockResponseOnce(JSON.stringify({ invited: true, emailSent: true })); // POST share
      fetchMock.mockResponseOnce(JSON.stringify({ shares: [] })); // invalidation refetch

      renderWithClient(<ShareSettings domain='acme.com' />);
      await waitFor(() => expect(screen.getByTestId('share_button')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('share_email'), { target: { value: 'collab@acme.com' } });
      fireEvent.click(screen.getByTestId('share_button'));

      await waitFor(() => expect(screen.getByTestId('share_sent')).toBeInTheDocument());
      expect(screen.getByTestId('share_sent').textContent).toContain('Shared with collab@acme.com');
   });
});
