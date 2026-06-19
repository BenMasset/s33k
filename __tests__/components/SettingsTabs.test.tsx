import { render, screen } from '@testing-library/react';
import Settings from '../../components/settings/Settings';

// Focused test for the new tab gating in the Settings modal: the Invite tab is always present; the
// Waitlist tab renders ONLY when billing reports the admin sentinel (plan === 'admin'). We mock the
// services so this test is about the gate, not the child panels' own data fetching.

jest.mock('../../hooks/useOnKey', () => ({ __esModule: true, default: () => {} }));
// STABLE references: Settings has a useEffect keyed on the settings query result, so the mock must
// return the SAME object every render, or the effect re-fires forever ("Maximum update depth").
jest.mock('../../services/settings', () => {
   const stableSettings = { data: { settings: {} }, isLoading: false };
   const noopMutation = { mutate: () => {}, isLoading: false };
   return {
      __esModule: true,
      useFetchSettings: () => stableSettings,
      useUpdateSettings: () => noopMutation,
      useClearFailedQueue: () => noopMutation,
      useCheckMigrationStatus: () => ({ data: null }),
      useMigrateDatabase: () => noopMutation,
   };
});
// Stub the tab BODY components (default + the new ones) so this test exercises only the tab gating,
// not each panel's own data fetching or service dependencies.
jest.mock('../../components/settings/ScraperSettings', () => ({ __esModule: true, default: () => <div data-testid='scraper_panel' /> }));
jest.mock('../../components/settings/NotificationSettings', () => ({ __esModule: true, default: () => <div data-testid='notif_panel' /> }));
jest.mock('../../components/settings/IntegrationSettings', () => ({ __esModule: true, default: () => <div data-testid='integration_panel' /> }));
jest.mock('../../components/settings/InviteSettings', () => ({ __esModule: true, default: () => <div data-testid='invite_panel' /> }));
jest.mock('../../components/settings/WaitlistSettings', () => ({ __esModule: true, default: () => <div data-testid='waitlist_panel' /> }));

const mockBilling = jest.fn();
jest.mock('../../services/billing', () => ({
   __esModule: true,
   useBillingStatus: () => mockBilling(),
}));

describe('Settings tabs gating', () => {
   it('shows the Invite tab but hides the Waitlist tab for a non-admin tenant', () => {
      mockBilling.mockReturnValue({ data: { plan: 'free', subscription_status: 'trialing' } });
      render(<Settings closeSettings={jest.fn()} />);
      expect(screen.getByTestId('invite_tab')).toBeInTheDocument();
      expect(screen.queryByTestId('waitlist_tab')).not.toBeInTheDocument();
   });

   it('shows the Waitlist tab for the admin account', () => {
      mockBilling.mockReturnValue({ data: { plan: 'admin' } });
      render(<Settings closeSettings={jest.fn()} />);
      expect(screen.getByTestId('invite_tab')).toBeInTheDocument();
      expect(screen.getByTestId('waitlist_tab')).toBeInTheDocument();
   });
});
